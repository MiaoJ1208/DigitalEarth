import csv
import ctypes as C
from datetime import datetime, timezone
import json
from io import BytesIO, StringIO
import math
import time
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, urlparse
from urllib.error import URLError

from sgp4 import omm
from sgp4.api import Satrec
from fastapi.testclient import TestClient

from app import app
from catalog import CATALOG, SPECIFICATIONS, SATELLITES, fetch_public_records, seed_snapshot, validate_records
from config import ROOT, Settings
from dll_adapter import OrbitLibrary, julian, utc
from storage import Store


class CatalogTests(unittest.TestCase):
    def setUp(self):
        self.records = list(csv.DictReader((ROOT / "data/public-gp.csv").read_text(encoding="utf-8").splitlines()))

    def test_group_download_filters_objects_and_requires_a_complete_catalog(self):
        def response(request, **kwargs):
            group = parse_qs(urlparse(request.full_url).query)["GROUP"][0]
            rows = [row for row in self.records if SPECIFICATIONS[int(row["NORAD_CAT_ID"])]["source_group"] == group]
            rows.append({**self.records[0], "NORAD_CAT_ID": "123456"})
            text = StringIO()
            writer = csv.DictWriter(text, fieldnames=list(self.records[0]))
            writer.writeheader()
            writer.writerows(rows)
            stream = BytesIO(text.getvalue().encode())
            stream.status, stream.headers = 200, {}
            return stream
        with patch("catalog.urlopen", side_effect=response) as download:
            rows = fetch_public_records()
        self.assertEqual([int(row["NORAD_CAT_ID"]) for row in rows], list(SATELLITES))
        self.assertEqual(download.call_count, len({entry["source_group"] for entry in CATALOG}))
        with self.assertRaises(ValueError):
            validate_records(rows[:-1])
        with self.assertRaises(ValueError):
            validate_records(rows[:-1] + [rows[0]])

    def test_first_source_error_stops_the_batch(self):
        with patch("catalog.urlopen", side_effect=URLError("offline")) as download:
            with self.assertRaises(URLError):
                fetch_public_records()
        self.assertEqual(download.call_count, 1)

    def test_disabled_entry_can_keep_its_offline_snapshot(self):
        active = {norad: name for norad, name in SATELLITES.items() if norad != 48808}
        with patch("catalog.SATELLITES", active):
            _, rows = seed_snapshot()
        self.assertEqual({int(row["NORAD_CAT_ID"]) for row in rows}, set(active))
        self.assertIn(48808, {int(row["NORAD_CAT_ID"]) for row in self.records})


class NativeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.native = OrbitLibrary(ROOT / "build/satellites.dll")
        with (ROOT / "data/public-gp.csv").open(encoding="utf-8", newline="") as source:
            cls.records = list(csv.DictReader(source))

    def test_public_omm_matches_reference_sgp4(self):
        for record in self.records:
            epoch = utc(record["EPOCH"])
            points = self.native.propagate(record, epoch, duration=600, step=60)
            reference = Satrec()
            omm.initialize(reference, record)
            for dt, x, y, z in points:
                # Split JD prevents avoidable precision loss in the independent caller.
                start = julian(epoch)
                day = math.floor(start)
                error, r, _ = reference.sgp4(day, start-day+dt/86400)
                self.assertEqual(error, 0)
                jd = start + dt/86400
                centuries = (jd-2451545.0)/36525
                theta = (67310.54841 + (876600*3600 + 8640184.812866)*centuries +
                         .093104*centuries**2 - 6.2e-6*centuries**3) * math.pi / 43200
                expected = [(math.cos(theta)*r[0]+math.sin(theta)*r[1])*1000,
                            (-math.sin(theta)*r[0]+math.cos(theta)*r[1])*1000, r[2]*1000]
                self.assertLess(math.dist([x,y,z], expected), 1.0)
                self.assertGreater(math.hypot(x,y,z), 6370000)

    def test_capacity_and_nonfinite_epoch_are_rejected(self):
        fields = (C.c_double*10)(2461361.5, 15.4, .001, 51.6, 100, 20, 30, .0001, 0, 0)
        output = (C.c_double*4)(123,123,123,123)
        written = C.c_int32(999)
        self.assertEqual(self.native.function(fields, fields[0], 2, 10, output, 1, C.byref(written)), 2)
        self.assertEqual(written.value, 0)
        self.assertEqual(list(output), [123]*4)
        self.assertEqual(self.native.function(fields, float('nan'), 1, 10, output, 1, C.byref(written)), 1)


class PipelineTests(unittest.TestCase):
    def test_public_catalog_saved_tracks_and_restart_reuse(self):
        body = {"norad_ids": [25544, 20580]}
        store = Store(Settings())
        with store.connect() as conn:
            exists = conn.execute("SELECT to_regclass('satellite_elements') AS table_name").fetchone()["table_name"]
            before = conn.execute("SELECT * FROM satellite_elements").fetchall() if exists else []
        with TestClient(app) as client:
            with store.connect() as conn:
                after = {row["norad_id"]: row for row in conn.execute("SELECT * FROM satellite_elements").fetchall()}
            for row in before:
                self.assertEqual(after[row["norad_id"]], row, "Startup must preserve existing elements and legacy rows.")
            catalog = client.get("/api/v1/satellites/catalog").json()
            self.assertEqual({sat["norad_id"] for sat in catalog["satellites"]},
                             {25544,48274,20580,25994,49260,54234,36585,37846,43001,48808})
            self.assertEqual(catalog["max_selected"], len(SATELLITES))
            self.assertTrue(all(sat["source_url"].startswith("https://celestrak.org/") for sat in catalog["satellites"]))
            response = client.post("/api/v1/satellites/tracks", json=body)
            self.assertIn(response.status_code, (200,202))
            job = response.json()
            deadline = time.monotonic()+20
            while job["status"] in {"queued", "running"}:
                self.assertLess(time.monotonic(), deadline)
                time.sleep(.03)
                job = client.get(f"/api/v1/satellites/jobs/{job['job_id']}").json()
            self.assertEqual(job["status"], "succeeded", job)
            manifest = client.get(job["result_url"]).json()
            self.assertEqual(manifest["propagation"], "C++ SGP4 (WGS72)")
            saved = client.get(manifest["samples_url"])
            self.assertEqual(saved.status_code, 200)
            self.assertEqual(len(saved.json()["satellites"]), 2)
            self.assertEqual(saved.json()["satellites"][0]["samples"][-1][0], 7200)
            count = client.get("/api/v1/satellites/health").json()["native_calls"]
            repeated = client.post("/api/v1/satellites/tracks", json={"norad_ids": [20580,25544]})
            self.assertEqual(repeated.status_code, 200)
            self.assertTrue(repeated.json()["cache_hit"])
            self.assertEqual(repeated.json()["result_id"], job["result_id"])
            self.assertEqual(client.get("/api/v1/satellites/health").json()["native_calls"], count)
            self.assertEqual(client.post("/api/v1/satellites/tracks", json={**body,"altitude_km":550}).status_code, 422)
            self.assertEqual(client.post("/api/v1/satellites/tracks", json={"norad_ids":[123]}).status_code, 422)
            for ids in ([25544,25544], [43013]):
                self.assertEqual(client.post("/api/v1/satellites/tracks", json={"norad_ids":ids}).status_code, 422)
            changed = client.app.state.service.prepare([25544,20580])
            key = client.app.state.service.cache_key(changed)
            changed["elements"][0]["fingerprint"] = "different-public-elements"
            self.assertNotEqual(client.app.state.service.cache_key(changed), key)
        with TestClient(app) as client:
            repeated = client.post("/api/v1/satellites/tracks", json=body).json()
            self.assertTrue(repeated["cache_hit"])
            self.assertEqual(repeated["result_id"], job["result_id"])
            self.assertEqual(client.get(manifest["samples_url"]).content, saved.content)
            self.assertEqual(client.get("/api/v1/satellites/health").json()["native_calls"], 0)

    def test_navigation_and_geostationary_full_tracks(self):
        with TestClient(app) as client:
            cases = [([36585,37846,43001],86400,10), ([48808,25994,49260],7200,10),
                     ([25544,36585],86400,10), ([48808,37846],86400,10)]
            for ids, duration, step in cases:
                job = client.post("/api/v1/satellites/tracks", json={"norad_ids":ids}).json()
                deadline = time.monotonic() + 20
                while job["status"] in {"queued", "running"}:
                    self.assertLess(time.monotonic(), deadline)
                    time.sleep(.03)
                    job = client.get(f"/api/v1/satellites/jobs/{job['job_id']}").json()
                self.assertEqual(job["status"], "succeeded", job)
                manifest = client.get(job["result_url"]).json()
                data = client.get(manifest["samples_url"]).json()
                self.assertEqual({sat["norad_id"] for sat in manifest["satellites"]}, set(ids))
                self.assertEqual(manifest["duration_s"], duration)
                self.assertEqual(manifest["output_step_s"], step)
                self.assertTrue(all(s["display_step_s"] == step for s in manifest["satellites"]))
                self.assertEqual((utc(manifest["stop_utc"])-utc(manifest["epoch_utc"])).total_seconds(), duration)
                self.assertTrue(all(len(track["samples"]) == duration//step+1 for track in data["satellites"]))
                self.assertTrue(all(track["samples"][-1][0] == duration for track in data["satellites"]))
                repeated = client.post("/api/v1/satellites/tracks", json={"norad_ids":ids})
                self.assertEqual(repeated.status_code, 200)
                self.assertTrue(repeated.json()["cache_hit"])
                self.assertEqual(repeated.json()["result_id"], job["result_id"])
                for track in data["satellites"]:
                    radius = math.hypot(*track["samples"][0][1:])
                    if track["satellite_id"] == "norad-48808":
                        self.assertGreater(radius, 40000000)
                    elif track["satellite_id"] in {"norad-36585", "norad-37846", "norad-43001"}:
                        self.assertGreater(radius, 20000000)

if __name__ == "__main__":
    unittest.main()
