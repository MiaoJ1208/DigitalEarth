"""Run from services/satellites with uv run python benchmark_transfer.py."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import random
from statistics import median
import struct
import subprocess
import threading
from time import perf_counter_ns

from playwright.sync_api import sync_playwright

from config import Settings
from orbit_codec import encode
from storage import Store


def original_track():
    store = Store(Settings())
    for result in store.list_results():
        if result["status"] != "succeeded" or result["manifest"]["duration_s"] != 86400:
            continue
        row = store.get(result["result_id"])
        if not row["object_key"]:
            continue
        source = store.objects.get_object(store.settings.bucket, row["object_key"])
        try:
            data = json.load(source)
        finally:
            source.close()
            source.release_conn()
        track = data["satellites"][0]
        if len(track["samples"]) == 8641:
            return row["result_id"], track
    raise RuntimeError("Requires an original 8641-point result in local MinIO")


def main():
    result_id, track = original_track()
    rows = track["samples"]
    # Compare against the existing Python rows, plus direct native-buffer copying.
    packed = struct.Struct("<4d")
    native = bytearray(b"".join(packed.pack(*row) for row in rows))
    encoders = {
        "json": lambda: json.dumps(rows, separators=(",", ":"), allow_nan=False).encode(),
        "raw": lambda: b"".join(packed.pack(*row) for row in rows),
        "orb": lambda: encode(rows, 10),
        "native-copy": lambda: bytes(native),
    }
    samples = {k: [] for k in encoders}
    payload = {}
    rng = random.Random(42)
    for iteration in range(35):
        for k in rng.sample(list(encoders),len(encoders)):
            start = perf_counter_ns()
            payload[k] = encoders[k]()
            if iteration >= 5:
                samples[k].append((perf_counter_ns()-start)/1e6)
    print(result_id, track["satellite_id"], len(rows), flush=True)
    print("server median ms / bytes", {k:(round(median(v),3),len(payload[k])) for k,v in samples.items()}, flush=True)
    assert payload["raw"] == payload["native-copy"]
    repo = Path(__file__).resolve().parents[2]
    codec = repo / "frontend/src/features/satellites/orbitCodec.ts"
    # Strip types from the actual frontend decoder, without reimplementing it.
    js = subprocess.check_output(["node","--input-type=module","-e",
        "import fs from 'node:fs';import {stripTypeScriptTypes} from 'node:module';process.stdout.write(stripTypeScriptTypes(fs.readFileSync(process.argv[1],'utf8')))", str(codec)])
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        def log_message(self,*args):
            pass
        def do_GET(self):
            key = self.path.strip("/")
            content = payload.get(key, js if key == "codec.js" else b"<html></html>")
            self.send_response(200)
            self.send_header("Cache-Control","no-store")
            self.send_header("Content-Type", "text/javascript" if key=="codec.js" else "text/html" if not key else "application/octet-stream")
            self.send_header("Content-Length",str(len(content)))
            self.end_headers()
            self.wfile.write(content)
    server = ThreadingHTTPServer(("127.0.0.1",0),Handler)
    threading.Thread(target=server.serve_forever,daemon=True).start()
    try:
        with sync_playwright() as p:
            browser=p.chromium.launch(channel="msedge")
            page=browser.new_page()
            page.goto(f"http://127.0.0.1:{server.server_port}/")
            cdp=page.context.new_cdp_session(page)
            cdp.send("Network.enable")
            for label, rate, latency, runs in [("loopback",-1,0,30),("20Mbps",2500000,20,20)]:
                cdp.send("Network.emulateNetworkConditions",dict(offline=False,latency=latency,
                         downloadThroughput=rate,uploadThroughput=rate))
                result=page.evaluate("""async runs=>{
                  const {decodeOrbit}=await import('/codec.js');
                  const decoder=new TextDecoder(), kinds=['json','raw','orb'];
                  function decode(k,b) {
                    if(k==='json')return JSON.parse(decoder.decode(b));
                    if(k==='orb')return decodeOrbit(b);
                    const v=new Float64Array(b), rows=[];
                    for(let j=0;j<v.length;j+=4) rows.push([v[j],v[j+1],v[j+2],v[j+3]]);
                    return rows;
                  }
                  const ref=await (await fetch('/json')).json();
                  const result={};
                  for(let i=0;i<runs+5;i++)for(let j=0;j<3;j++){
                    const k=kinds[(j+i)%3],t=performance.now();
                    const b=await (await fetch('/'+k,{cache:'no-store'})).arrayBuffer(),u=performance.now();
                    const r=decode(k,b),e=performance.now();
                    if(r.length!==ref.length || r.some((p,i)=>p[0]!==ref[i][0] ||
                      Math.hypot(...p.slice(1).map((x,j)=>x-ref[i][j+1]))>(k==='orb'?0.087:0)))throw Error(k);
                    if(i>=5)(result[k]??=[]).push([u-t,e-u,e-t]);
                  }
                  return result;
                }""",runs)
                for k, trials in result.items():
                    print(label,k,"fetch/decode/total median ms",
                          [round(median(col),2) for col in zip(*trials)],flush=True)
            browser.close()
    finally:
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    main()
