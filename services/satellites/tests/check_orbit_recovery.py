"""Integration regression for interrupted publication, shared blocks and dangling indexes."""
from dataclasses import replace
import os
from unittest.mock import patch
from uuid import uuid4

import psycopg
from psycopg import sql

from config import Settings
from storage import Store


def run():
    suffix = uuid4().hex
    settings = replace(Settings(), bucket="orbit-test-" + suffix)
    schema = "orbit_test_" + suffix
    store = Store(settings)
    with psycopg.connect(**settings.db_kwargs()) as conn:
        conn.execute(sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(schema)))
    previous = os.environ.get("PGOPTIONS")
    os.environ["PGOPTIONS"] = "-c search_path=" + schema
    try:
        store.initialize()
        def job(name):
            row, _ = store.claim(name, {"norad_ids": [1]})
            store.mark_running(row["result_id"])
            return row["result_id"]
        def publish(result, shift):
            manifest = {"output_step_s": 10, "satellites": [{"norad_id":1,"satellite_id":"norad-1"}]}
            rows = [[t, t+shift, 2*t, -t] for t in range(0, 7201, 10)]
            store.save(result, {"satellites":[{"samples":rows}]}, manifest)
            return manifest["satellites"][0]["blocks"]

        first, second = job("one"), job("two")
        blocks = publish(first, 0)
        assert blocks == publish(second, 0)
        assert len(store.read_track(store.get(first), store.get(first)["manifest"]["satellites"][0])) == 721
        interrupted = job("interrupted")
        put = store.objects.put_object
        def fail_after_put(*args, **kwargs):
            put(*args, **kwargs)
            raise RuntimeError("injected after PUT")
        with patch.object(store.objects, "put_object", side_effect=fail_after_put):
            try:
                publish(interrupted, 42)
            except RuntimeError as exc:
                assert str(exc) == "injected after PUT"
            else:
                raise AssertionError("expected a publication failure")
        stored = {o.object_name for o in store.objects.list_objects(settings.bucket, recursive=True)}
        spec = store.get(first)["manifest"]["satellites"][0]
        key = spec["pack_key"]
        assert stored == {key}
        full = store.read_bytes(key)
        for block in blocks:
            offset, length = block["offset"], block["length"]
            assert store.read_bytes(key, offset, length) == full[offset:offset+length]
        store.objects.remove_object(settings.bucket, key)
        store.initialize()
        assert all(store.get(i)["status"] == "failed" for i in (first, second, interrupted))
        assert not list(store.objects.list_objects(settings.bucket, recursive=True))
        retry, claimed = store.claim("one", {"norad_ids":[1]})
        assert claimed
        store.mark_running(retry["result_id"])
        publish(retry["result_id"], 0)
        assert store.get(first)["status"] == "succeeded"
        fixed = job("fixed")
        epoch = 1700000000
        spec = dict(norad_id=1, satellite_id="norad-1", format="ORF1", sample_key="source", source_epoch=epoch)
        rows = [[t, -t, t + 0.14, 42164000] for t in range(0, 86401, 10)]
        manifest = dict(output_step_s=10, satellites=[spec])
        store.save(fixed, {"satellites": [{"samples": rows}]}, manifest)
        assert store.fixed_sources(["source"], epoch + 64800, 300)["source"]["pack_key"] == spec["pack_key"]
        assert not store.fixed_sources(["source"], epoch + 10, 86400)
        from orbit_codec import fixed_window
        raw = store.read_bytes(spec["pack_key"])
        assert len(raw) == 103712
        assert fixed_window(raw, epoch + 64800, 300, 30)[1] == [30, -64830, 64830.1, 42164000]
        store.objects.remove_object(settings.bucket, spec["pack_key"])
        store.initialize()
        assert not store.fixed_sources(["source"], epoch, 7200)
        assert store.get(fixed)["status"] == "failed"
        print("PASS: shared blocks, interrupted PUT, missing object, restart, retry")
    finally:
        if previous is None:
            os.environ.pop("PGOPTIONS")
        else:
            os.environ["PGOPTIONS"] = previous
        if store.objects.bucket_exists(settings.bucket):
            for obj in store.objects.list_objects(settings.bucket, recursive=True):
                store.objects.remove_object(settings.bucket, obj.object_name)
            store.objects.remove_bucket(settings.bucket)
        with psycopg.connect(**settings.db_kwargs()) as conn:
            conn.execute(sql.SQL("DROP SCHEMA {} CASCADE").format(sql.Identifier(schema)))


if __name__ == "__main__":
    run()
