import { useEffect, useRef, useState } from 'react';
import { loadSelectedTrack, readCatalog } from './api';
import type { SatelliteCatalog, SatellitePlaybackState, ReceiveChunk } from './types';

export function satelliteTime(value: string) {
  return `${value.replace('T', ' ').slice(0, 19)} UTC`;
}
function sourceLink(url: string, text: string) {
  try {
    if (['http:', 'https:'].includes(new URL(url).protocol)) {
      return <a href={url} target="_blank" rel="noreferrer">{text}</a>;
    }
  } catch { /* A missing source URL is displayed as text. */ }
  return text;
}
interface Props {
  active: boolean;
  playback: SatellitePlaybackState | null;
  ready: boolean;
  onPreview: (norad: number, xyz: number[]) => () => void;
  onLoad: ReceiveChunk;
  onFocus: () => void;
  onClear: () => void;
}

export function SatellitePanel({ active, playback, ready, onPreview, onLoad, onFocus, onClear }: Props) {
  const [catalog, setCatalog] = useState<SatelliteCatalog | null>(null);
  const [selected, setSelected] = useState<number[]>([25544, 48274, 20580]);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState<string | null>(null);
  const operation = useRef<AbortController | null>(null);
  const catalogLoaded = useRef(false);
  const limit = catalog?.max_selected ?? 0;
  const categories = [...new Map(catalog?.satellites.map(sat => [sat.category, sat.category_name])).entries()];
  const query = search.trim().toLocaleLowerCase();
  const visible = catalog?.satellites.filter(sat => (!category || sat.category === category) &&
    `${sat.display_name} ${sat.object_name} ${sat.norad_id}`.toLocaleLowerCase().includes(query)) ?? [];
  const modelSources = [...new Map(playback?.models.map(model => [model.version_id, model])).values()];

  function applyCatalog(value: SatelliteCatalog) {
    catalogLoaded.current = true;
    setCatalog(value);
    setSelected(previous => previous.filter(id => value.satellites.some(sat => sat.norad_id === id)).slice(0, value.max_selected));
    setError(value.update_error);
  }

  useEffect(() => () => operation.current?.abort(), []);
  useEffect(() => {
    if (!active || catalogLoaded.current) return;
    const controller = new AbortController();
    operation.current = controller;
    setBusy(true);
    readCatalog(controller.signal)
      .then(value => { if (!controller.signal.aborted) applyCatalog(value); })
      .catch(err => { if (!controller.signal.aborted) setError(err.message); })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [active]);

  async function act(action: 'load' | 'refresh') {
    operation.current?.abort();
    const controller = new AbortController();
    operation.current = controller;
    setBusy(true);
    setError(null);
    const previews = new Map<number, () => void>();
    const clearPreviews = () => { for (const remove of previews.values()) remove(); previews.clear(); };
    controller.signal.addEventListener('abort', clearPreviews, {once: true});
    try {
      if (action === 'refresh') {
        const value = await readCatalog(controller.signal, true);
        applyCatalog(value);
        setMessage('卫星数据已读取。');
      } else {
        setMessage('正在加载轨迹…');
        const data = await loadSelectedTrack(selected, controller.signal, onLoad, (norad, xyz) => {
          if (!controller.signal.aborted && !previews.has(norad)) previews.set(norad, onPreview(norad, xyz));
        });
        if (controller.signal.aborted) return;
        setSelected(data.manifest.satellites.map(sat => sat.norad_id)
          .filter(id => catalog?.satellites.some(sat => sat.norad_id === id)).slice(0, limit));
        setMessage(data.reused ? '已复用缓存轨迹。' : '轨迹已加载。');
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        setMessage('');
        setError(err instanceof Error ? err.message : '卫星数据加载失败。');
      }
    } finally {
      clearPreviews();
      controller.signal.removeEventListener('abort', clearPreviews);
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  function clearScene() {
    operation.current?.abort();
    setBusy(false);
    setError(null);
    setMessage('');
    setSelected([]);
    onClear();
  }

  return <div className="satellite-panel-content">
    <div className="satellite-source-heading"><strong>卫星列表</strong><button className="text-button" disabled={busy} onClick={() => void act('refresh')}>更新数据</button></div>
    <div className="satellite-filters">
      <input type="search" aria-label="搜索卫星" placeholder="名称 / NORAD 编号" value={search} onChange={event => setSearch(event.target.value)} />
      <select aria-label="卫星分类" value={category} onChange={event => setCategory(event.target.value)}>
        <option value="">全部分类</option>{categories.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
      </select>
    </div>
    <div className="satellite-selection-status">
      <span role="status">已选 {selected.length} / {limit}<span> · 共 {catalog?.satellites.length ?? 0} 颗</span></span>
      <button className="text-button" aria-label="清空选择和轨迹" disabled={(!catalog && busy) || (!selected.length && !playback && !busy)} onClick={clearScene}>清空选择和轨迹</button>
    </div>
    <div className="satellite-list" role="group" aria-label="可选卫星列表" tabIndex={0}>
    {visible.map(sat => {
      const position = playback?.positions.find(p => p.satellite_id === `norad-${sat.norad_id}`);
      const checked = selected.includes(sat.norad_id);
      return <label className="satellite-choice" key={sat.norad_id} title={`${sat.object_name} · 要素 ${satelliteTime(sat.epoch_utc)}`}>
        <input type="checkbox" checked={checked} disabled={busy || (!checked && selected.length >= limit)}
          onChange={event => setSelected(previous => event.target.checked
            ? previous.includes(sat.norad_id) || previous.length >= limit ? previous : [...previous, sat.norad_id]
            : previous.filter(id => id !== sat.norad_id))} />
        <span><strong>{sat.display_name}</strong>
          <small>NORAD {sat.norad_id} · {sat.category_name} · {{ LEO: '低轨', MEO: '中轨', GEO: '静止轨道' }[sat.orbit_type]}</small>
          {position && <small className="satellite-position">{position.longitude.toFixed(2)}°，{position.latitude.toFixed(2)}° · {(position.height / 1000).toFixed(1)} km</small>}
        </span>
      </label>;
    })}
    {catalog && !visible.length && <p className="satellite-message">没有匹配的卫星。</p>}
    </div>
    {!catalog && !busy && <button className="text-button" onClick={() => void act('refresh')}>重新获取卫星目录</button>}
    <button className="primary-button satellite-load" disabled={busy || !ready || !catalog || !selected.length || selected.length > limit}
      onClick={() => void act('load')}>{busy ? '正在加载…' : '加载所选卫星轨迹'}</button>
    {message && <p className="satellite-message" role="status">{message}</p>}
    {(error || playback?.loadError) && <p className="satellite-error" role="alert">{error || playback?.loadError}</p>}
    {playback && <>
      <div className="satellite-result-info">
        <p>回放起点：{satelliteTime(playback.manifest.epoch_utc)}</p>
        <p>回放时长：{playback.manifest.duration_s / 3600} 小时</p>
        {playback.manifest.window_kind === 'historical' && <p>当前使用较旧要素对应的历史时段。</p>}
      </div>
      <div className="satellite-actions"><button className="text-button" onClick={onFocus}>查看全部轨迹</button></div>
      <details className="satellite-provenance"><summary>数据获取时间与来源</summary>
        {playback.manifest.satellites.map(sat => <p key={sat.satellite_id}>{sourceLink(sat.source_url, sat.object_name)}<br />要素：{satelliteTime(sat.element_epoch_utc)}<br />获取：{satelliteTime(sat.fetched_at)}</p>)}
        {modelSources.map(model => <div key={model.version_id}>
          <p>模型：{model.asset_name} · v{model.version}<br />作者：{model.source_info.author}<br />
            来源：{sourceLink(model.source_info.source_url, model.source_info.title || model.asset_name)}<br />
            许可：{sourceLink(model.source_info.license_url, model.source_info.license)}</p>
          {model.source_info.license_text && <details><summary>许可说明</summary><p>{model.source_info.license_text}</p></details>}
        </div>)}
      </details>
    </>}
  </div>;
}
