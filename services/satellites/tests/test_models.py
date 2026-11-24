import unittest
from unittest.mock import patch
from uuid import uuid4

from fastapi.testclient import TestClient

from app import app
from catalog import SATELLITES
from config import ROOT, Settings
from model_pack import validate_glb
from model_store import ModelRegistry, render_options
from storage import Store


class ModelTests(unittest.TestCase):
    def test_render_options_reject_invalid_values(self):
        for values in ({"scale":float("nan")}, {"minimum_pixel_size":0}, {"maximum_scale":-1},
                       {"scale":100,"maximum_scale":10}, {"arbitrary_option":1}):
            with self.assertRaises(ValueError):
                render_options(values)

    def test_default_model_download_and_history_reuse(self):
        store = Store(Settings())
        with store.connect() as conn:
            legacy = conn.execute("SELECT * FROM satellite_results WHERE status='succeeded' ORDER BY created_at LIMIT 1").fetchone()
        with TestClient(app) as client:
            registry = client.app.state.models
            for offset in range(0,len(SATELLITES),3):
                ids = list(SATELLITES)[offset:offset+3]
                response = client.post("/api/v1/satellites/models/resolve",json={"norad_ids":ids})
                self.assertEqual(response.status_code,200,response.text)
                self.assertEqual(response.headers["cache-control"],"no-store")
                for model in response.json()["models"]:
                    self.assertEqual(model["asset_name"],"Simple Satellite Low Poly Free")
                    self.assertEqual(model["binding"],"default")
                    self.assertEqual(model["source_info"]["author"],"DjalalxJay")
                    self.assertIn("CC-BY-4.0",model["source_info"]["license"])
                    self.assertGreaterEqual(model["render_options"]["minimum_pixel_size"],30)
            history_model = client.post("/api/v1/satellites/models/resolve",json={"norad_ids":[43013]}).json()["models"][0]
            file = client.get(history_model["model_url"])
            self.assertEqual(file.status_code,200)
            self.assertEqual(file.headers["content-type"],"model/gltf-binary")
            self.assertIn("immutable",file.headers["cache-control"])
            document = validate_glb(file.content)
            self.assertEqual(len(document["images"]),4)
            self.assertIn("DjalalxJay",document["asset"]["copyright"])
            self.assertTrue(all("uri" not in image for image in document["images"]))
            cached = client.get(history_model["model_url"],headers={"If-None-Match":file.headers["etag"]})
            self.assertEqual(cached.status_code,304)
            self.assertEqual(cached.content,b"")
            self.assertEqual(client.get(f"/api/v1/satellites/models/versions/{uuid4()}/model.glb").status_code,404)
            for ids in ([25544,25544], [0]):
                self.assertEqual(client.post("/api/v1/satellites/models/resolve",json={"norad_ids":ids}).status_code,422)
            if legacy:
                before = client.get(f"/api/v1/satellites/tracks/{legacy['result_id']}/samples").content
                registry.bootstrap()
                restored = client.get(f"/api/v1/satellites/tracks/{legacy['result_id']}").json()
                self.assertEqual(restored,legacy["manifest"])
                self.assertEqual(client.get(restored["samples_url"]).content,before)
                self.assertEqual(store.get(legacy["result_id"]),legacy)
            self.assertEqual(client.get("/api/v1/satellites/health").json()["native_calls"],0)
            with store.connect() as conn:
                self.assertEqual(conn.execute("SELECT count(*) AS n FROM satellite_model_bindings WHERE norad_id=ANY(%s)",
                                              (list(SATELLITES),)).fetchone()["n"],len(SATELLITES))

    def test_binding_version_activation_and_restart_preserve_orbits(self):
        with TestClient(app) as client:
            registry = client.app.state.models
            store = registry.store
            original = registry.resolve([25544])[0]
            data = (ROOT.parent.parent / "frontend/public/models/satellite.glb").read_bytes()
            with store.connect() as conn:
                original_binding = conn.execute("SELECT asset_id FROM satellite_model_bindings WHERE norad_id=25544").fetchone()
            asset_id, versions = None, []
            try:
                first = registry.register(f"test-{uuid4()}","Temporary model test",data,dict(author="DigitalEarth test"))
                asset_id = first["asset_id"]
                versions.append(first)
                second = registry.register(first["slug"],"Temporary model test",data,dict(author="DigitalEarth test"),
                                           options=dict(minimum_pixel_size=41))
                versions.append(second)
                registry.bind(25544,asset_id)
                selected = registry.resolve([25544,43013])
                self.assertEqual(selected[0]["version_id"],second["id"])
                self.assertEqual(selected[0]["binding"],"override")
                self.assertEqual(selected[1]["asset_id"],original["asset_id"])
                registry.activate_version(asset_id,first["id"])
                self.assertEqual(registry.resolve([25544])[0]["version_id"],first["id"])
                registry.set_default(asset_id)
                registry.bind(25544)
                fresh = ModelRegistry(store)
                fresh.initialize()
                fresh.bootstrap()
                self.assertEqual(fresh.resolve([25544,43013])[0]["version_id"],first["id"])
                self.assertEqual(fresh.resolve([43013])[0]["binding"],"default")
                self.assertEqual(client.get("/api/v1/satellites/health").json()["native_calls"],0)
            finally:
                registry.set_default(original["asset_id"])
                registry.bind(25544,original_binding["asset_id"] if original_binding else None)
                if asset_id:
                    with store.connect() as conn:
                        conn.execute("UPDATE model_assets SET current_version_id=NULL WHERE id=%s",(asset_id,))
                        conn.execute("DELETE FROM model_versions WHERE asset_id=%s",(asset_id,))
                        conn.execute("DELETE FROM model_assets WHERE id=%s",(asset_id,))
                    for version in versions:
                        store.objects.remove_object(registry.bucket,version["object_key"])

    def test_failed_file_publish_keeps_current_default(self):
        with TestClient(app) as client:
            registry = client.app.state.models
            before = registry.resolve([25544])
            slug = f"failed-{uuid4()}"
            data = (ROOT.parent.parent / "frontend/public/models/satellite.glb").read_bytes()
            with patch.object(registry.store.objects,"put_object",side_effect=RuntimeError("storage unavailable")):
                with self.assertRaises(RuntimeError):
                    registry.register(slug,"Failed test",data,{},make_default=True)
            self.assertIsNone(registry.asset(slug))
            self.assertEqual(registry.resolve([25544]),before)

    def test_failed_database_publication_removes_only_its_new_object(self):
        registry = ModelRegistry(Store(Settings()))
        registry.initialize()
        before = registry.resolve([25544])
        data = (ROOT.parent.parent / "frontend/public/models/satellite.glb").read_bytes()
        slug = f"failed-database-{uuid4()}"
        objects = registry.store.objects
        with patch.object(objects,"remove_object",wraps=objects.remove_object) as remove:
            with self.assertRaises(TypeError):
                registry.register(slug,"Failed metadata test",data,{},
                                  geometry_info={"unserializable":object()},make_default=True)
        self.assertEqual(remove.call_count,1)
        self.assertEqual(remove.call_args.args[0],registry.bucket)
        self.assertTrue(remove.call_args.args[1].startswith("models/"))
        self.assertIsNone(registry.asset(slug))
        self.assertEqual(registry.resolve([25544]),before)


if __name__ == "__main__":
    unittest.main()
