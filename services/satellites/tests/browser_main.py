"""Exercise public satellites in the actual React workspace with its one existing Viewer."""
import json
import os
from pathlib import Path

from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / "work/satellites"
OUT.mkdir(parents=True, exist_ok=True)

def executable():
    for root in (os.getenv("PROGRAMFILES"), os.getenv("PROGRAMFILES(X86)"), os.getenv("LOCALAPPDATA")):
        if root:
            for name in ("Google/Chrome/Application/chrome.exe", "Microsoft/Edge/Application/msedge.exe"):
                path = Path(root) / name
                if path.is_file():
                    return str(path)
    return None


def tracking_snapshot(page):
    return page.evaluate("""() => {
      const v = window.__testViewer;
      const p = v.trackedEntity.position.getValue(v.clock.currentTime);
      const c = v.camera.positionWC;
      const screen = v.scene.cartesianToCanvasCoordinates(p);
      return {id:v.trackedEntity.id, distance:Math.hypot(c.x-p.x,c.y-p.y,c.z-p.z),
        height:v.camera.positionCartographic.height, pitch:v.camera.pitch,
        centreError:Math.hypot(screen.x-v.scene.canvas.clientWidth/2,screen.y-v.scene.canvas.clientHeight/2),
        camera:[c.x,c.y,c.z]};
    }""")


def assert_overview(state, satellite_id, distance=16000000):
    assert state["id"] == satellite_id, state
    assert abs(state["distance"] - distance) < 100, state
    assert state["height"] > 15000000, state
    assert state["pitch"] < -1.5, state
    assert state["centreError"] < 2, state

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(executable_path=executable(), headless=True,
                                         args=["--enable-unsafe-swiftshader"])
    page = browser.new_page(viewport={"width":1440,"height":1000})
    errors, requests = [], []
    page.on("pageerror", lambda error: errors.append(str(error).split("?")[0]))
    page.on("request", lambda req: requests.append((req.method,req.url)) if "/api/v1/satellites/" in req.url else None)
    page.goto("http://127.0.0.1:5173/?panel=satellites", wait_until="domcontentloaded")
    expect(page.locator(".satellite-choice")).to_have_count(10, timeout=60000)
    expect(page.locator(".satellite-panel-content input[type=number]")).to_have_count(0)
    expect(page.locator(".satellite-choice").filter(has_text="国际空间站")).to_be_visible()
    def checkbox(norad):
        return page.locator(".satellite-choice").filter(has_text=f"NORAD {norad}").locator("input")
    expect(page.locator(".satellite-choice input:checked")).to_have_count(3)
    expect(page.locator(".satellite-choice input:disabled")).to_have_count(0)
    expect(checkbox(54234)).to_be_enabled()
    checkbox(48274).uncheck()
    expect(checkbox(54234)).to_be_enabled()
    checkbox(54234).check()
    expect(checkbox(48274)).to_be_enabled()
    search = page.get_by_role("searchbox", name="搜索卫星")
    search.fill("48808")
    expect(page.locator(".satellite-choice")).to_have_count(1)
    expect(page.locator(".satellite-choice").filter(has_text="风云四号")).to_be_visible()
    search.fill("")
    page.get_by_label("卫星分类", exact=True).select_option("navigation")
    expect(page.locator(".satellite-choice")).to_have_count(3)
    page.get_by_role("button", name="清空选择和轨迹", exact=True).click()
    for norad in (36585,37846,43001):
        checkbox(norad).check()
    expect(page.locator(".satellite-choice input:checked")).to_have_count(3)
    page.get_by_label("卫星分类", exact=True).select_option("")
    expect(page.locator(".satellite-choice input:disabled")).to_have_count(0)
    page.get_by_role("button", name="清空选择和轨迹", exact=True).click()
    for norad in (25544,20580,54234):
        checkbox(norad).check()
    catalog_list = page.get_by_role("group", name="可选卫星列表", exact=True)
    assert catalog_list.evaluate("e => e.scrollHeight > e.clientHeight && getComputedStyle(e).overflowY === 'scroll'")
    toggle = page.get_by_role("button", name="时间轴与曲线", exact=True)
    expect(toggle).to_be_disabled()
    expect(toggle).to_have_attribute("aria-expanded", "false")
    # Capture the real controller's Viewer for assertions; production exposes no debug globals.
    page.evaluate("""async () => {
      const moduleUrl = performance.getEntriesByType('resource')
        .find(e => new URL(e.name).pathname === '/src/features/globe/SceneController.ts').name;
      const { SceneController } = await import(moduleUrl);
      const playbackUrl = performance.getEntriesByType('resource')
        .find(e => new URL(e.name).pathname === '/src/features/satellites/SatellitePlayback.ts').name;
      const { SatellitePlayback } = await import(playbackUrl);
      const points = new WeakMap();
      const makeLine = SatellitePlayback.prototype.makeLine;
      SatellitePlayback.prototype.makeLine = function(id, positions, color) {
        const line = makeLine.call(this, id, positions, color);
        points.set(line, positions);
        return line;
      };
      window.__testOrbitPoints = () => window.__testPlayback.lines.flatMap(line => points.get(line) ?? []);
      const load = SceneController.prototype.loadSatellites;
      SceneController.prototype.loadSatellites = function(...args) {
        window.__testPlayback = this.satellitePlayback;
        window.__testViewer = this.viewer;
        window.__testManifest = args[0];
        window.__testSamples = args[1];
        window.__testModels = args[2];
        return load.apply(this, args);
      };
    }""")
    load = page.get_by_role("button", name="加载所选卫星轨迹", exact=True)
    expect(load).to_be_enabled(timeout=60000)
    before_scroll = load.bounding_box()["y"]
    catalog_list.hover()
    page.mouse.wheel(0, 700)
    page.wait_for_timeout(200)
    assert catalog_list.evaluate("e => e.scrollTop > 0")
    assert abs(load.bounding_box()["y"] - before_scroll) < 1
    catalog_list.evaluate("e => e.scrollTop = 0")
    page.screenshot(path=str(OUT / "catalog-scroll.png"))
    page.evaluate("window.__initialGlobeCanvas = document.querySelector('.cesium-widget canvas')")
    load.click()
    controls = page.get_by_role("region", name="卫星轨迹回放", exact=True)
    expect(toggle).to_be_enabled(timeout=60000)
    page.wait_for_function("!!window.__testViewer")
    expect(controls).to_have_count(0)
    expect(page.locator(".satellite-position")).to_have_count(3)
    page.wait_for_timeout(15000)
    page.wait_for_function("""() => {
      const v=window.__testViewer;
      const models=Array.from({length:v.scene.primitives.length},(_,i)=>v.scene.primitives.get(i))
        .filter(p=>p.id?.id?.startsWith('norad-') && p.ready);
      return models.length===3 && models.every(p=>p._texturesLoaded);
    }""",timeout=60000)
    model_bindings = page.evaluate("window.__testModels")
    assert len(model_bindings)==3
    assert all(model["asset_name"]=="Simple Satellite Low Poly Free" for model in model_bindings)
    assert all(model["source_info"]["author"]=="DjalalxJay" for model in model_bindings)
    assert len({model["version_id"] for model in model_bindings})==1
    provenance = page.locator(".satellite-provenance")
    provenance.locator(":scope > summary").click()
    expect(provenance.locator(":scope > div > p").filter(has_text="DjalalxJay")).to_be_visible()
    expect(provenance.get_by_role("link",name="CC-BY-4.0",exact=True)).to_be_visible()
    provenance.locator(":scope > summary").click()
    page.locator(".satellites-panel .panel-content").evaluate("e=>e.scrollTop=0")
    assert page.evaluate("""() => {
      const v=window.__testViewer;
      return v.dataSources.getByName('public-satellites')[0].entities.values.filter(e=>e.model)
        .every(e=>e.model.uri.getValue(v.clock.currentTime).startsWith('/api/v1/satellites/models/versions/'));
    }""")
    page.screenshot(path=str(OUT / "timeline-collapsed.png"))
    toggle.click()
    expect(toggle).to_have_attribute("aria-expanded", "true")
    expect(controls).to_be_visible()
    map_bounds = page.locator(".map-controls").bounding_box()
    assert map_bounds["y"] + map_bounds["height"] < controls.bounding_box()["y"]
    expect(load).to_be_enabled()
    expect(page.locator(".cesium-widget canvas")).to_have_count(1)
    expect(page.locator(".satellite-position")).to_have_count(3)
    subpoints = page.evaluate("""() => {
      const viewer = window.__testViewer;
      return viewer.dataSources.getByName('public-satellites')[0].entities.values
        .filter(e => e.id.endsWith('-subpoint')).map(e => {
          const p = e.position.getValue(viewer.clock.currentTime);
          return { id:e.id, radius:Math.hypot(p.x,p.y,p.z),
            label:e.label.text.getValue(viewer.clock.currentTime),
            noTrail:!e.path && !e.polyline };
        });
    }""")
    assert len(subpoints) == 3
    assert all(p["noTrail"] and 6356750 < p["radius"] < 6378140 and "星下点" in p["label"] for p in subpoints)
    assert "公开要素推算轨迹" not in page.locator("body").inner_text()
    old_time = controls.locator("time").inner_text()
    frame_a = page.locator(".globe-viewport").screenshot(path=str(OUT / "motion-a.png"))
    page.wait_for_function("text => document.querySelector('.satellite-controls time').textContent !== text", arg=old_time)
    page.wait_for_timeout(700)
    frame_b = page.locator(".globe-viewport").screenshot(path=str(OUT / "motion-b.png"))
    assert frame_a != frame_b
    count_before_fold = len(requests)
    before_fold = page.evaluate("window.__testViewer.clock.currentTime.toString()")
    controls.get_by_role("button", name="折叠时间轴", exact=True).click()
    expect(toggle).to_be_focused()
    expect(controls).to_have_count(0)
    expect(toggle).to_have_attribute("aria-expanded", "false")
    page.wait_for_timeout(500)
    assert page.evaluate("window.__testViewer.clock.shouldAnimate")
    assert before_fold != page.evaluate("window.__testViewer.clock.currentTime.toString()")
    assert len(requests) == count_before_fold
    toggle.click()
    controls.get_by_role("button", name="暂停", exact=True).click()
    page.wait_for_timeout(200)
    paused = controls.locator("time").inner_text()
    count = len(requests)
    page.wait_for_timeout(500)
    assert controls.locator("time").inner_text() == paused
    page.get_by_label("卫星回放倍速").select_option("120")
    controls.get_by_role("button", name="播放", exact=True).click()
    page.wait_for_function("text => document.querySelector('.satellite-controls time').textContent !== text", arg=paused)
    slider = page.get_by_label("卫星回放时间", exact=True)
    bounds = slider.bounding_box()
    slider.click(position={"x":bounds["width"]*.4,"y":bounds["height"]/2})
    expect(controls.get_by_role("button", name="播放", exact=True)).to_be_visible()
    controls.get_by_role("button", name="回到起点", exact=True).click()
    expect(slider).to_have_value("0")
    assert len(requests) == count, "Playback controls must not issue backend requests."
    page.get_by_label("跟随卫星", exact=True).select_option("norad-25544")
    page.wait_for_timeout(1800)
    assert_overview(tracking_snapshot(page), "norad-25544")
    # Seeking and switching satellites keep the target centred in a high, downward view.
    slider.click(position={"x":bounds["width"]*.6,"y":bounds["height"]/2})
    page.wait_for_timeout(200)
    assert_overview(tracking_snapshot(page), "norad-25544")
    page.get_by_label("跟随卫星", exact=True).select_option("norad-54234")
    page.wait_for_timeout(1800)
    assert_overview(tracking_snapshot(page), "norad-54234")
    page.screenshot(path=str(OUT / "satellite-follow.png"))
    before_follow_play = tracking_snapshot(page)
    controls.get_by_role("button", name="播放", exact=True).click()
    page.wait_for_timeout(700)
    controls.get_by_role("button", name="暂停", exact=True).click()
    after_follow_play = tracking_snapshot(page)
    assert_overview(after_follow_play, "norad-54234")
    assert sum((a-b)**2 for a,b in zip(before_follow_play["camera"],after_follow_play["camera"])) > 100000000
    # User zoom is retained while the view centre continues to follow playback time.
    page.get_by_role("button", name="缩小", exact=True).click()
    page.wait_for_timeout(200)
    zoomed = tracking_snapshot(page)
    assert zoomed["distance"] > 17000000, zoomed
    slider.click(position={"x":bounds["width"]*.4,"y":bounds["height"]/2})
    page.wait_for_timeout(200)
    assert_overview(tracking_snapshot(page), "norad-54234", zoomed["distance"])
    before_free = tracking_snapshot(page)["camera"]
    page.get_by_label("跟随卫星", exact=True).select_option("")
    after_free = page.evaluate("""() => {
      const v = window.__testViewer;
      if (v.trackedEntity) throw Error('Free view still tracks an entity');
      const c = v.camera.positionWC;
      return [c.x,c.y,c.z];
    }""")
    assert sum((a-b)**2 for a,b in zip(before_free,after_free)) < 1
    assert len(requests) == count, "Following, seeking and zoom must stay local."
    page.locator(".navigation").get_by_role("button",name="查询索引",exact=True).click()
    expect(page.get_by_role("tab",name="地名查询",exact=True)).to_be_visible()
    assert page.evaluate("document.querySelector('.cesium-widget canvas') === window.__initialGlobeCanvas")
    page.locator(".navigation").get_by_role("button",name="图层管理",exact=True).click()
    expect(page.get_by_text("中国省级行政区界线",exact=True)).to_be_visible()
    page.locator(".navigation").get_by_role("button",name="卫星轨迹",exact=True).click()
    assert page.evaluate("document.querySelector('.cesium-widget canvas') === window.__initialGlobeCanvas")
    load.click()
    expect(page.locator(".satellite-message").filter(has_text="复用")).to_be_visible(timeout=30000)
    expect(load).to_be_enabled()
    page.get_by_role("button",name="查看全部轨迹",exact=True).click()
    page.wait_for_timeout(1200)
    page.screenshot(path=str(OUT / "integrated-desktop.png"))
    # A model-resolution error must leave the loaded orbit and model entities intact.
    preserved = page.evaluate("window.__testManifest.result_id")
    failure_route = "**/api/v1/satellites/models/resolve"
    page.route(failure_route,lambda route: route.fulfill(status=503,content_type="application/json",
                                                        body=json.dumps({"detail":"模型服务测试失败。"})))
    load.click()
    expect(page.get_by_role("alert").filter(has_text="卫星模型解析失败")).to_be_visible(timeout=30000)
    expect(load).to_be_enabled()
    assert page.evaluate("window.__testManifest.result_id")==preserved
    expect(page.locator(".satellite-position")).to_have_count(3)
    assert page.evaluate("document.querySelector('.cesium-widget canvas') === window.__initialGlobeCanvas")
    page.unroute(failure_route)
    # Each orbital scale must be framed automatically, without a manual zoom-out.
    for label, ids, duration, step, target in (
        ("meo", [36585,37846,43001],86400,10,36585),
        ("geo", [48808],7200,10,48808),
        ("mixed", [25544,36585],86400,10,36585),
    ):
        page.get_by_role("button", name="清空选择和轨迹", exact=True).click()
        for norad in ids:
            checkbox(norad).check()
        load.click()
        expect(load).to_be_enabled(timeout=60000)
        page.wait_for_function("""ids => window.__testManifest.satellites.map(s=>s.norad_id).sort().join(',') === [...ids].sort().join(',')""", arg=ids)
        page.wait_for_timeout(1400)
        framing = page.evaluate("""() => {
          const v = window.__testViewer;
          let outside = 0;
          const points = window.__testOrbitPoints();
          if (!points.length) throw Error('Missing static orbit geometry');
          for (const p of points) {
            const s = v.scene.cartesianToCanvasCoordinates(p);
            if (!s || s.x<0 || s.y<0 || s.x>v.scene.canvas.clientWidth || s.y>v.scene.canvas.clientHeight) outside++;
          }
          return {outside, height:v.camera.positionCartographic.height,
            duration:window.__testManifest.duration_s,step:window.__testManifest.output_step_s};
        }""")
        assert framing["outside"] == 0, (label, framing)
        assert framing["height"] > 50000000, (label, framing)
        assert framing["duration"] == duration and framing["step"] == step, framing
        expect(page.get_by_label("卫星回放倍速")).to_have_value("600" if duration>7200 else "60")
        page.screenshot(path=str(OUT / f"adaptive-{label}-overview.png"))
        controls.get_by_role("button", name="暂停", exact=True).click()
        page.get_by_label("跟随卫星", exact=True).select_option(f"norad-{target}")
        page.wait_for_timeout(400)
        tracked = tracking_snapshot(page)
        assert tracked["distance"] > 40000000, (label, tracked)
        assert_overview(tracked, f"norad-{target}", tracked["distance"])
        page.screenshot(path=str(OUT / f"adaptive-{label}-follow.png"))
        page.get_by_role("button", name="缩小", exact=True).click()
        page.wait_for_timeout(200)
        tracked_zoom = tracking_snapshot(page)
        slider.click(position={"x":bounds["width"]*.35,"y":bounds["height"]/2})
        page.wait_for_timeout(200)
        assert_overview(tracking_snapshot(page), f"norad-{target}", tracked_zoom["distance"])
        page.get_by_role("button", name="查看全部轨迹", exact=True).click()
        page.wait_for_timeout(1000)
    # After reload, tracks are loaded directly from the current selection.
    page.reload(wait_until="domcontentloaded")
    expect(load).to_be_enabled(timeout=60000)
    expect(page.get_by_role("heading", name="已保存轨迹")).to_have_count(0)
    load.click()
    expect(toggle).to_be_enabled(timeout=30000)
    expect(controls).to_have_count(0)
    toggle.click()
    expect(controls).to_be_visible()
    restored_count = page.get_by_label("跟随卫星", exact=True).locator("option").count() - 1
    assert 1 <= restored_count <= 3
    expect(load).to_be_enabled()
    expect(page.locator(".satellite-message").filter(has_text="轨迹")).to_be_visible()
    expect(page.locator(".scene-status")).to_have_text("场景就绪", timeout=60000)
    page.set_viewport_size({"width":1000,"height":760})
    page.wait_for_timeout(2500)
    page.locator(".satellites-panel .panel-content").evaluate("e => e.scrollTop = 0")
    catalog_list.evaluate("e => e.scrollTop = 0")
    body_bounds = page.locator(".satellites-panel .panel-content").bounding_box()
    load_bounds = load.bounding_box()
    assert load_bounds["y"] + load_bounds["height"] <= body_bounds["y"] + body_bounds["height"], (load_bounds, body_bounds)
    page.screenshot(path=str(OUT / "integrated-compact.png"))
    assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
    toggle_bounds = toggle.bounding_box()
    assert toggle_bounds["x"] > 700 and toggle_bounds["y"] > 720
    map_bounds = page.locator(".map-controls").bounding_box()
    assert map_bounds["y"] + map_bounds["height"] < controls.bounding_box()["y"]
    credits_bounds = page.locator(".cesium-viewer-bottom").bounding_box()
    assert credits_bounds["x"] + credits_bounds["width"] < map_bounds["x"]
    toggle.click()
    expect(controls).to_have_count(0)
    expect(page.locator(".satellite-position")).to_have_count(restored_count)
    assert not errors, errors
    page.get_by_role("button",name="清空选择和轨迹",exact=True).click()
    expect(page.get_by_role("region",name="卫星轨迹回放",exact=True)).to_have_count(0)
    expect(toggle).to_be_disabled()
    expect(page.locator(".cesium-widget canvas")).to_have_count(1)
    (OUT / "browser-result.json").write_text(json.dumps({"page_errors":errors,"satellite_api_requests":len(requests)},indent=2),encoding="utf-8")
    print("Integrated workspace passed: PostgreSQL model resolution, textured MinIO GLB, failure preservation, orbit cache reuse and adaptive playback.")
    browser.close()
