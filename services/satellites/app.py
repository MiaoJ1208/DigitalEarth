from contextlib import asynccontextmanager
from uuid import UUID

from fastapi import FastAPI, HTTPException, Query, Request, Response
from fastapi.responses import JSONResponse, StreamingResponse
from minio.error import S3Error
from pydantic import BaseModel, ConfigDict, Field, model_validator

from catalog import MAX_SELECTED, PublicCatalog, SATELLITES
from config import ROOT, Settings
from dll_adapter import OrbitLibrary
from service import BusyError, SatelliteService
from storage import Store
from model_store import ModelRegistry

class TrackRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    norad_ids: list[int] = Field(min_length=1, max_length=MAX_SELECTED)

    @model_validator(mode="after")
    def supported(self):
        if len(set(self.norad_ids)) != len(self.norad_ids) or not set(self.norad_ids) <= set(SATELLITES):
            raise ValueError("请选择目录中不重复的卫星编号。")
        return self

class ModelResolveRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    norad_ids: list[int] = Field(min_length=1)

    @model_validator(mode="after")
    def valid_ids(self):
        if len(set(self.norad_ids)) != len(self.norad_ids) or any(not 0 < norad <= 999999999 for norad in self.norad_ids):
            raise ValueError("请提供不重复的有效卫星编号。")
        return self

@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = Settings()
    if not settings.db_password or not settings.minio_password:
        raise RuntimeError("Run initialize.py before starting the satellite API.")
    store = Store(settings)
    store.initialize()
    catalog = PublicCatalog(store)
    catalog.initialize()
    models = ModelRegistry(store)
    models.initialize()
    models.bootstrap()
    app.state.models = models
    app.state.service = SatelliteService(store, catalog, OrbitLibrary(ROOT / "build/satellites.dll"))
    try:
        yield
    finally:
        app.state.service.close()

app = FastAPI(title="DigitalEarth public satellite API", lifespan=lifespan)
PREFIX = "/api/v1/satellites"

@app.post(PREFIX + "/models/resolve")
def resolve_models(body: ModelResolveRequest, request: Request, response: Response):
    response.headers["Cache-Control"] = "no-store"
    try:
        return dict(models=request.app.state.models.resolve(body.norad_ids))
    except ValueError as exc:
        raise HTTPException(503, "尚未配置可用的卫星模型，请先导入模型。") from exc

@app.get(PREFIX + "/models")
def models(request: Request, response: Response):
    response.headers["Cache-Control"] = "no-store"
    return dict(assets=request.app.state.models.list_assets())

@app.get(PREFIX + "/models/versions/{version_id}/model.glb")
def model_file(version_id: UUID, request: Request):
    registry = request.app.state.models
    version = registry.get_version(str(version_id))
    if not version:
        raise HTTPException(404, "模型版本不存在。")
    etag = f'"{version_id}"'
    headers = {"ETag":etag, "Cache-Control":"private, max-age=31536000, immutable"}
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers=headers)
    try:
        source = registry.store.objects.get_object(registry.bucket,version["object_key"])
    except S3Error as exc:
        raise HTTPException(503, "模型文件暂不可用，请检查模型存储。") from exc
    def chunks():
        try:
            yield from source.stream(64*1024)
        finally:
            source.close()
            source.release_conn()
    headers["Content-Length"] = str(version["byte_length"])
    return StreamingResponse(chunks(), media_type="model/gltf-binary", headers=headers)

@app.get(PREFIX + "/health")
def health(request: Request):
    service = request.app.state.service
    with service.store.connect() as conn:
        conn.execute("SELECT 1")
    return dict(status="ok", native_calls=service.native_calls, active_jobs=service.active,
                bucket_ready=service.store.objects.bucket_exists(service.store.settings.bucket))

@app.get(PREFIX + "/catalog")
def catalog(request: Request):
    service = request.app.state.service
    service.catalog.refresh()
    return service.catalog.describe()

@app.post(PREFIX + "/refresh")
def refresh(request: Request):
    service = request.app.state.service
    updated = service.catalog.refresh()
    return dict(updated=updated, **service.catalog.describe())

def job_description(row):
    return dict(job_id=row["job_id"], result_id=row["result_id"], status=row["status"],
        error=row["error"], result_url=f"{PREFIX}/tracks/{row['result_id']}")

@app.post(PREFIX + "/tracks")
def submit(body: TrackRequest, request: Request):
    try:
        row, created = request.app.state.service.submit(body.norad_ids)
    except (ValueError, BusyError) as exc:
        raise HTTPException(503, str(exc)) from exc
    result = job_description(row)
    result.update(preview_supported=True, cache_hit=not created and row["status"] == "succeeded")
    return JSONResponse(result, status_code=200 if row["status"] == "succeeded" else 202)

@app.get(PREFIX + "/jobs/{job_id}/preview")
def preview(job_id: UUID, request: Request, cursor: int = Query(0, ge=0)):
    done, item = request.app.state.service.preview_batch(str(job_id), cursor)
    headers = {"Cache-Control": "no-store"}
    if item is None:
        return Response(status_code=204 if done else 202, headers=headers)
    norad, epoch, duration, digest, raw = item
    headers.update({"X-Norad": str(norad), "X-Epoch": str(epoch), "X-Duration": str(duration), "X-Digest": digest})
    return Response(content=raw, media_type="application/octet-stream", headers=headers)

@app.get(PREFIX + "/jobs/{job_id}")
def job(job_id: UUID, request: Request):
    row = request.app.state.service.store.job(str(job_id))
    if not row:
        raise HTTPException(404, "任务不存在。")
    return job_description(row)

@app.get(PREFIX + "/tracks")
def results(request: Request):
    rows = request.app.state.service.store.list_results()
    for row in rows:
        for satellite in (row["manifest"] or {}).get("satellites", []):
            # History only displays summary metadata. Loading an entry fetches its full manifest.
            satellite.pop("overview", None)
            satellite.pop("blocks", None)
    return dict(results=rows)

@app.get(PREFIX + "/tracks/{result_id}")
def manifest(result_id: UUID, request: Request):
    row = request.app.state.service.store.get(str(result_id))
    if not row:
        raise HTTPException(404, "成果不存在。")
    if row["status"] != "succeeded":
        raise HTTPException(409, "成果尚未完成。")
    return row["manifest"]

@app.get(PREFIX + "/tracks/{result_id}/samples")
def download(result_id: UUID, request: Request):
    store = request.app.state.service.store
    row = store.get(str(result_id))
    if not row or row["status"] != "succeeded":
        raise HTTPException(404, "可用成果不存在。")
    etag = f'"{result_id}"'
    headers = {"ETag": etag, "Cache-Control": "private, max-age=31536000, immutable"}
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers=headers)
    if not row["object_key"]:
        tracks = [dict(satellite_id=spec["satellite_id"], samples=store.read_track(row, spec))
                  for spec in row["manifest"]["satellites"]]
        return JSONResponse(dict(schema_version="satellite-samples-1", result_id=str(result_id),
                                 satellites=tracks), headers=headers)
    try:
        source = store.objects.get_object(store.settings.bucket, row["object_key"])
    except S3Error as exc:
        raise HTTPException(503, "轨迹文件暂不可用，请检查对象存储。") from exc
    def chunks():
        try:
            yield from source.stream(64*1024)
        finally:
            source.close()
            source.release_conn()
    headers["Content-Length"] = str(row["manifest"]["byte_length"])
    return StreamingResponse(chunks(), media_type="application/json", headers=headers)

@app.get(PREFIX + "/tracks/{result_id}/binary/{norad_id}")
def binary_track(result_id: UUID, norad_id: int, request: Request):
    import json
    from orbit_codec import encode
    store = request.app.state.service.store
    row = store.get(str(result_id))
    if not row or row["status"] != "succeeded" or norad_id not in row["request"]["norad_ids"]:
        raise HTTPException(404, "轨迹不存在")
    spec = next(s for s in row["manifest"]["satellites"] if s["norad_id"] == norad_id)
    return Response(encode(store.read_track(row, spec), row["manifest"]["output_step_s"]),
                    media_type="application/octet-stream",
                    headers={"Cache-Control": "private, max-age=31536000, immutable"})

@app.get(PREFIX + "/blocks/{norad_id}/{digest}")
def orbit_block(norad_id: int, digest: str, request: Request):
    import re
    if not re.fullmatch(r"[0-9a-f]{64}", digest):
        raise HTTPException(404)
    try:
        raw = request.app.state.service.store.read_bytes(f"orbit-blocks/{norad_id}/{digest}.orb")
    except S3Error as exc:
        if exc.code == "NoSuchKey":
            raise HTTPException(404) from exc
        raise
    return Response(raw, media_type="application/octet-stream",
                    headers={"Cache-Control":"private, max-age=31536000, immutable"})

@app.get(PREFIX + "/packs/{norad_id}/{digest}")
def orbit_pack(norad_id: int, digest: str, request: Request,
               offset: int = Query(0, ge=0), length: int | None = Query(None, ge=1)):
    import re
    if not re.fullmatch(r"[0-9a-f]{64}", digest):
        raise HTTPException(404)
    if offset and length is None:
        raise HTTPException(422, "指定偏移时须提供长度")
    try:
        raw = request.app.state.service.store.read_bytes(f"orbit-packs/{norad_id}/{digest}.orb", offset, length or 0)
    except S3Error as exc:
        if exc.code == "NoSuchKey":
            raise HTTPException(404) from exc
        if exc.code == "InvalidRange":
            raise HTTPException(416) from exc
        raise
    if length is not None and len(raw) != length:
        raise HTTPException(416)
    return Response(raw, media_type="application/octet-stream",
                    headers={"Cache-Control": "private, max-age=31536000, immutable"})
