import assert from 'node:assert/strict';
import test from 'node:test';
import { isManifest, isModelResolution, isSamples, loadSavedTrack } from '../src/features/satellites/api.ts';

const manifest = {
  schema_version: 'satellites-1', result_id: '12345678-1234-1234-1234-123456789abc',
  epoch_utc: '2026-11-18T00:00:00Z', stop_utc: '2026-11-18T00:00:10Z',
  duration_s: 10, output_step_s: 10, position_frame: 'ECEF_APPROX', position_unit: 'm',
  window_kind: 'current-window',
  samples_url: '/api/v1/satellites/tracks/12345678-1234-1234-1234-123456789abc/samples',
  satellites: [{ satellite_id:'norad-25544', norad_id:25544, display_name:'ISS', object_name:'ISS',
    sample_count:2, period_s:5500, element_epoch_utc:'2026-11-17T20:00:00Z',
    fetched_at:'2026-11-18T00:00:00Z', source_url:'https://celestrak.org/NORAD/elements/gp.php' }],
};
const payload = { schema_version:'satellite-samples-1', result_id:manifest.result_id,
  satellites:[{satellite_id:'norad-25544',samples:[[0,7000000,0,0],[10,6999000,100000,0]]}] };
const model = {
  norad_id: 25544, asset_id: '11111111-1111-4111-8111-111111111111', asset_name: 'Satellite model',
  version_id: '22222222-2222-4222-8222-222222222222', version: 1,
  model_url: '/api/v1/satellites/models/versions/22222222-2222-4222-8222-222222222222/model.glb',
  render_options: { scale: 1, minimum_pixel_size: 40, maximum_scale: 5000000 },
  source_info: { author: 'Model author', title: 'Satellite', source_url: 'https://example.com/satellite',
    license: 'CC BY 4.0', license_url: 'https://creativecommons.org/licenses/by/4.0/', license_text: 'Attribution' },
};

test('only matching Earth-fixed metre samples enter the scene', () => {
  assert.equal(isManifest(manifest), true);
  assert.ok(isManifest(manifest));
  assert.equal(isSamples(payload, manifest), true);
  assert.equal(isManifest({...manifest,position_frame:'TEME'}), false);
  assert.equal(isManifest({...manifest,position_unit:'km'}), false);
  assert.equal(isManifest({...manifest,samples_url:'https://other.example/samples'}), false);
  assert.equal(isSamples({...payload,result_id:'other'}, manifest), false);
});

test('missing satellites, invalid coordinates and incorrect times are rejected', () => {
  assert.ok(isManifest(manifest));
  assert.equal(isSamples({...payload,satellites:[]}, manifest), false);
  assert.equal(isSamples({...payload,satellites:[{satellite_id:'norad-25544',samples:[[0,NaN,0,0],[10,1,2,3]]}]}, manifest), false);
  assert.equal(isSamples({...payload,satellites:[{satellite_id:'norad-25544',samples:[[0,1,2,3],[5,1,2,3]]}]}, manifest), false);
});

test('model resolution must cover each requested satellite once, including historical catalog entries', () => {
  const legacy = { ...model, norad_id: 43013 };
  assert.ok(isModelResolution({ models: [model] }, [25544]));
  assert.ok(isModelResolution({ models: [legacy, model] }, [25544, 43013]));
  for (const models of [[], [model, model], [model, { ...model, norad_id: 123 }]]) {
    assert.equal(isModelResolution({ models }, [25544, 43013]), false);
  }
  assert.equal(isModelResolution({ models: [model] }, [25544, 25544]), false);
  assert.equal(isModelResolution({ models: [model] }, []), false);
  assert.equal(isModelResolution({ models: [model] }, [25544, 43013, 20580, 48274]), false);
  assert.equal(isModelResolution({ models: [{ ...model, asset_id: 'bad-id' }] }, [25544]), false);
  assert.equal(isModelResolution({ models: [{ ...model, version_id: 'bad-id' }] }, [25544]), false);
  assert.equal(isModelResolution({ models: [{ ...model, version: 0 }] }, [25544]), false);
});

test('model resources stay at their versioned same-origin URL and rendering values remain bounded', () => {
  for (const url of ['https://other.example/model.glb', '//other.example/model.glb',
    '/api/v1/satellites/models/versions/other/model.glb', `${model.model_url}?download=true`,
    '/api/v1/satellites/models/versions/22222222-2222-4222-8222-222222222222/../model.glb']) {
    assert.equal(isModelResolution({ models: [{ ...model, model_url: url }] }, [25544]), false, url);
  }
  for (const options of [
    { ...model.render_options, scale: 0 }, { ...model.render_options, scale: Infinity },
    { ...model.render_options, scale: 1e7 }, { ...model.render_options, minimum_pixel_size: -1 },
    { ...model.render_options, minimum_pixel_size: 4097 }, { ...model.render_options, maximum_scale: NaN },
    { ...model.render_options, maximum_scale: 1e10 }, { ...model.render_options, maximum_scale: .5 },
  ]) assert.equal(isModelResolution({ models: [{ ...model, render_options: options }] }, [25544]), false);
  for (const source of [{ ...model.source_info, source_url: 'javascript:alert(1)' },
    { ...model.source_info, license_url: 'data:text/html,bad' }, { ...model.source_info, license_text: 123 }]) {
    assert.equal(isModelResolution({ models: [{ ...model, source_info: source }] }, [25544]), false);
  }
  assert.ok(isModelResolution({ models: [{ ...model, source_info: { ...model.source_info, source_url: '', license_url: '' } }] }, [25544]));
});

test('saved tracks fetch current models separately and in parallel with immutable samples', async () => {
  const originalFetch = globalThis.fetch;
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: globalThis });
  const legacyManifest = { ...manifest, satellites: [{ ...manifest.satellites[0], norad_id: 43013, satellite_id: 'norad-43013' }] };
  const chunks: Float64Array[] = [];
  const receive = (_: unknown, chunk: {xyz: Float64Array}) => { chunks.push(chunk.xyz); };
  const binaryPath = `/api/v1/satellites/tracks/${manifest.result_id}/binary/43013`;
  const packet = Uint8Array.from([79, 82, 66, 49, 2, 0, 0, 0, 0, 0, 0, 0, 10, 0, 0, 0, 128, 246, 224, 66, 0, 0, 159, 146, 226, 66, 128, 137, 122, 0]);
  const requests: Array<{ path: string; method: string; body: unknown }> = [];
  let currentModel = { ...model, norad_id: 43013 };
  let invalidResolution = false;
  let hold = true;
  const release: Array<() => void> = [];
  globalThis.fetch = async (input, init) => {
    const path = String(input);
    requests.push({ path, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (path === `/api/v1/satellites/tracks/${manifest.result_id}`) return new Response(JSON.stringify(legacyManifest));
    if (path !== binaryPath && path !== '/api/v1/satellites/models/resolve') throw new Error(`Unexpected request: ${path}`);
    if (hold) await new Promise<void>(resolve => release.push(resolve));
    if (path === binaryPath) return new Response(packet);
    return new Response(JSON.stringify({ models: invalidResolution ? [] : [currentModel] }));
  };
  try {
    const loading = loadSavedTrack(manifest.result_id, new AbortController().signal, receive);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(release.length, 2, 'Samples and current-model resolution must start without awaiting one another.');
    hold = false;
    release.forEach(resolve => resolve());
    const first = await loading;
    assert.deepEqual(first.manifest, legacyManifest);
    assert.deepEqual([...chunks[0]], [7000000,0,0,6999000,100000,0]);
    assert.equal(first.models[0].version, 1);
    currentModel = { ...currentModel, version: 2, version_id: '33333333-3333-4333-8333-333333333333',
      model_url: '/api/v1/satellites/models/versions/33333333-3333-4333-8333-333333333333/model.glb' };
    const second = await loadSavedTrack(manifest.result_id, new AbortController().signal, receive);
    assert.deepEqual(second.manifest, first.manifest);
    assert.deepEqual(chunks[1], chunks[0]);
    assert.equal(second.models[0].version, 2);
    const resolutions = requests.filter(request => request.path.endsWith('/models/resolve'));
    assert.equal(resolutions.length, 2);
    assert.ok(resolutions.every(request => request.method === 'POST' && JSON.stringify(request.body) === '{"norad_ids":[43013]}'));
    assert.equal(requests.filter(request => request.method === 'POST').length, 2, 'History loading never resubmits propagation.');
    invalidResolution = true;
    await assert.rejects(loadSavedTrack(manifest.result_id, new AbortController().signal, receive), /模型配置格式异常/);
  } finally {
    release.forEach(resolve => resolve());
    globalThis.fetch = originalFetch;
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});
