"""Fetch public GP elements on demand, with a persistent two-hour minimum interval."""
import csv
from datetime import datetime, timezone, timedelta
import gzip
from hashlib import sha256
from io import StringIO
import json
import logging
import math
import re
from threading import Lock
from urllib.request import Request, urlopen

from psycopg.types.json import Jsonb
from config import ROOT
from dll_adapter import utc

def load_configuration():
    data = json.loads((ROOT / "data/satellite-catalog.json").read_text(encoding="utf-8"))
    if data.get("schema_version") != "satellite-catalog-1":
        raise ValueError("Unsupported satellite catalog configuration.")
    categories = data["categories"]
    entries = [entry for entry in data["satellites"] if entry.get("enabled", True)]
    ids = [entry["norad_id"] for entry in entries]
    if not entries or len(set(ids)) != len(ids):
        raise ValueError("Satellite catalog must contain unique entries.")
    for entry in entries:
        if (not isinstance(entry["norad_id"], int) or entry["norad_id"] <= 0 or
            not entry["display_name"] or entry["category"] not in categories or
            entry["orbit_type"] not in {"LEO", "MEO", "GEO"} or
            not re.fullmatch(r"[a-z0-9-]+", entry["source_group"])):
            raise ValueError("Invalid satellite catalog entry.")
    return entries, categories

CATALOG, CATEGORIES = load_configuration()
SPECIFICATIONS = {entry["norad_id"]: entry for entry in CATALOG}
SATELLITES = {entry["norad_id"]: entry["display_name"] for entry in CATALOG}
MAX_SELECTED = len(SATELLITES)
FIELDS = ("MEAN_MOTION", "ECCENTRICITY", "INCLINATION", "RA_OF_ASC_NODE",
          "ARG_OF_PERICENTER", "MEAN_ANOMALY", "BSTAR", "MEAN_MOTION_DOT", "MEAN_MOTION_DDOT")
logger = logging.getLogger(__name__)

def source_url(norad):
    return f"https://celestrak.org/NORAD/elements/gp.php?GROUP={SPECIFICATIONS[norad]['source_group']}&FORMAT=CSV"

def validate(record):
    norad = int(record["NORAD_CAT_ID"])
    if norad not in SATELLITES or not record.get("OBJECT_NAME"):
        raise ValueError("Unexpected satellite in public data.")
    utc(record["EPOCH"])
    values = {name: float(record[name]) for name in FIELDS}
    if not all(math.isfinite(value) for value in values.values()) or not 0 < values["MEAN_MOTION"] < 20 or not 0 <= values["ECCENTRICITY"] < 1:
        raise ValueError("Invalid public GP orbital element.")
    return norad

def validate_records(records):
    if len(records) != len(SATELLITES) or {validate(row) for row in records} != set(SATELLITES):
        raise ValueError("Public source did not return the complete configured catalog.")

def seed_snapshot():
    meta = json.loads((ROOT / "data/public-gp.json").read_text(encoding="utf-8"))
    rows = csv.DictReader(StringIO((ROOT / "data/public-gp.csv").read_text(encoding="utf-8")))
    records = [row for row in rows if int(row["NORAD_CAT_ID"]) in SATELLITES]
    validate_records(records)
    return utc(meta["fetched_at"]), records

def fetch_public_records():
    records = []
    groups = dict.fromkeys(entry["source_group"] for entry in CATALOG)
    for group in groups:
        ids = {entry["norad_id"] for entry in CATALOG if entry["source_group"] == group}
        url = source_url(next(iter(ids)))
        request = Request(url, headers={"User-Agent": "DigitalEarth/0.1 public-orbit-viewer", "Accept-Encoding": "gzip"})
        # Stop the batch at its first error; each configured group is requested only once.
        with urlopen(request, timeout=8) as response:
            if response.status != 200:
                raise ValueError("CelesTrak returned a non-200 response.")
            raw = response.read(2 * 1024 * 1024)
            if response.headers.get("Content-Encoding") == "gzip":
                raw = gzip.decompress(raw)
        rows = csv.DictReader(StringIO(raw.decode("utf-8-sig")))
        records.extend(row for row in rows if int(row["NORAD_CAT_ID"]) in ids)
    validate_records(records)
    by_id = {int(row["NORAD_CAT_ID"]): row for row in records}
    return [by_id[norad] for norad in SATELLITES]

class PublicCatalog:
    def __init__(self, store):
        self.store = store
        self.lock = Lock()

    def initialize(self):
        fetched, records = seed_snapshot()
        with self.store.connect() as conn:
            conn.execute("""CREATE TABLE IF NOT EXISTS satellite_elements (
                norad_id integer PRIMARY KEY, record jsonb NOT NULL, fetched_at timestamptz NOT NULL,
                source_url text NOT NULL, fingerprint text NOT NULL)""")
            conn.execute("""CREATE TABLE IF NOT EXISTS satellite_source_state (
                id integer PRIMARY KEY CHECK(id=1), attempted_at timestamptz, error text)""")
            inserted = self.write(conn, records, fetched, missing_only=True)
            conn.execute("""INSERT INTO satellite_source_state VALUES (1,%s,NULL)
                ON CONFLICT(id) DO NOTHING""", (fetched,))
            if inserted:
                conn.execute("""UPDATE satellite_source_state SET
                    error=CASE WHEN attempted_at IS NULL OR attempted_at < %s THEN NULL ELSE error END,
                    attempted_at=GREATEST(attempted_at,%s) WHERE id=1""",
                    (fetched, fetched))

    def write(self, conn, records, fetched, missing_only=False):
        validate_records(records)
        inserted = 0
        for record in records:
            norad = validate(record)
            fingerprint = sha256(json.dumps(record, sort_keys=True).encode()).hexdigest()
            conflict = ("DO NOTHING" if missing_only else """DO UPDATE SET
                record=excluded.record,fetched_at=excluded.fetched_at,
                source_url=excluded.source_url,fingerprint=excluded.fingerprint
                WHERE satellite_elements.fetched_at <= excluded.fetched_at""")
            inserted += conn.execute("INSERT INTO satellite_elements VALUES (%s,%s,%s,%s,%s) "
                "ON CONFLICT(norad_id) " + conflict,
                (norad, Jsonb(record), fetched, source_url(norad), fingerprint)).rowcount
        return inserted

    def refresh(self):
        with self.lock:
            now = datetime.now(timezone.utc)
            with self.store.connect() as conn:
                state = conn.execute("SELECT * FROM satellite_source_state WHERE id=1").fetchone()
                if state and state["attempted_at"] and now-state["attempted_at"] < timedelta(hours=2):
                    return False
                conn.execute("""INSERT INTO satellite_source_state VALUES (1,%s,NULL)
                    ON CONFLICT(id) DO UPDATE SET attempted_at=excluded.attempted_at,error=NULL""", (now,))
            try:
                records = fetch_public_records()
                with self.store.connect() as conn:
                    self.write(conn, records, now)
                return True
            except Exception:
                logger.exception("Public GP update failed; retaining the last complete catalog")
                with self.store.connect() as conn:
                    conn.execute("UPDATE satellite_source_state SET error=%s WHERE id=1",
                                 ("公开数据更新失败，保留上次完整快照；请稍后重试。",))
                return False

    def entries(self):
        with self.store.connect() as conn:
            return conn.execute("SELECT * FROM satellite_elements WHERE norad_id=ANY(%s) ORDER BY norad_id", (list(SATELLITES),)).fetchall()

    def describe(self):
        now = datetime.now(timezone.utc)
        by_id = {row["norad_id"]: row for row in self.entries()}
        with self.store.connect() as conn:
            state = conn.execute("SELECT * FROM satellite_source_state WHERE id=1").fetchone()
        return dict(provider="CelesTrak", max_selected=MAX_SELECTED, update_error=state["error"] if state else None,
                    next_update_at=(state["attempted_at"]+timedelta(hours=2)) if state and state["attempted_at"] else None,
                    satellites=[dict(norad_id=row["norad_id"], display_name=SATELLITES[row["norad_id"]],
                        category=SPECIFICATIONS[row["norad_id"]]["category"],
                        category_name=CATEGORIES[SPECIFICATIONS[row["norad_id"]]["category"]],
                        orbit_type=SPECIFICATIONS[row["norad_id"]]["orbit_type"],
                        object_name=row["record"]["OBJECT_NAME"], epoch_utc=utc(row["record"]["EPOCH"]),
                        fetched_at=row["fetched_at"], source_url=row["source_url"],
                        age_hours=round((now-utc(row["record"]["EPOCH"])).total_seconds()/3600, 1))
                        for row in (by_id[norad] for norad in SATELLITES if norad in by_id)])
