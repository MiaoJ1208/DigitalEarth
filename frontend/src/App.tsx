import { useCallback, useRef, useState } from 'react';
import { Icon } from './components/Icon';
import { sceneConfig } from './config/scene';
import { provinceBoundary } from './config/mapServices';
import { LayerPropertiesPanel } from './features/layers/LayerPropertiesPanel';
import type { IconName } from './components/Icon';
import { GlobeViewport } from './features/globe/GlobeViewport';
import type { SceneController } from './features/globe/SceneController';
import { initialSnapshot } from './features/globe/types';
import type { MapLayerStatus, SceneSnapshot, TerrainStatus } from './features/globe/types';
import { QueryPanel } from './features/locations/QueryPanel';
import { placeCameraHeight, placeHierarchy, placeKindLabel } from './features/locations/types';
import { AnnotationPanel } from './features/mapWorkspace/AnnotationPanel';
import { MeasurementPanel } from './features/mapWorkspace/MeasurementPanel';
import { useMapWorkspace } from './features/mapWorkspace/useMapWorkspace';
import { SatellitePanel } from './features/satellites/SatellitePanel';
import { SatelliteControls } from './features/satellites/SatelliteControls';
import './features/mapWorkspace/mapWorkspace.css';
import './features/satellites/satellites.css';

type Panel = 'layers' | 'annotations' | 'measurements' | 'query' | 'satellites';
const navigation: Array<{ id: Panel; label: string; icon: IconName }> = [
  { id: 'layers', label: '图层管理', icon: 'layers' },
  { id: 'measurements', label: '距离测量', icon: 'ruler' },
  { id: 'annotations', label: '地图标注', icon: 'pen' },
  { id: 'query', label: '查询索引', icon: 'locate' },
  { id: 'satellites', label: '卫星轨迹', icon: 'orbit' },
];
const terrainLabels: Record<TerrainStatus, string> = {
  unconfigured: '未配置',
  disabled: '已关闭',
  loading: '加载中',
  ready: '可用',
  error: '加载失败',
};
const mapLayerLabels: Record<MapLayerStatus, string> = {
  disabled: '已关闭',
  loading: '加载中',
  ready: '已开启',
  error: '加载失败',
};

function formatHeight(height: number) {
  return Math.abs(height) >= 1000
    ? `${(height / 1000).toLocaleString('en-US', { maximumFractionDigits: 1 })} km`
    : `${height.toFixed(1)} m`;
}
function coordinate(value: number, positive: string, negative: string) {
  return `${Math.abs(value).toFixed(4)}° ${value >= 0 ? positive : negative}`;
}
function surfaceHeight(height: number | null) {
  return height === null ? '待加载' : `${height.toFixed(1)} m`;
}

export default function App() {
  const controller = useRef<SceneController | null>(null);
  const [readyController, setReadyController] = useState<SceneController | null>(null);
  const [scene, setScene] = useState<SceneSnapshot>(initialSnapshot);
  const [panel, setPanel] = useState<Panel | null>(() => new URLSearchParams(window.location.search).get('panel') === 'satellites' ? 'satellites' : 'query');
  const [grid, setGrid] = useState(false);
  const [timelineOpen, setTimelineOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [layerPropertiesOpen, setLayerPropertiesOpen] = useState(false);
  const layerPropertiesButton = useRef<HTMLButtonElement>(null);
  const timelineButton = useRef<HTMLButtonElement>(null);
  const onReady = useCallback((value: SceneController | null) => {
    controller.current = value;
    setReadyController(value);
  }, []);
  const onSnapshot = useCallback((value: SceneSnapshot) => setScene(value), []);
  const onError = useCallback(
    (error: string) => setScene((previous) => ({ ...previous, status: 'error', error })),
    [],
  );
  const initialized = scene.status !== 'loading' && !scene.transitioning;
  const terrainActive = scene.terrainStatus === 'ready';
  const terrainBusy = scene.terrainStatus === 'loading';
  const terrainName = terrainActive ? '全球高程地形' : 'WGS84 椭球面';
  const workspaceTool = panel === 'annotations' || panel === 'measurements' ? panel : null;
  const canPick = !!readyController && !scene.transitioning;
  const workspace = useMapWorkspace(readyController, workspaceTool, canPick);
  const currentPanel = navigation.find(item => item.id === panel);
  const pickedPlace = scene.selection?.place;

  function togglePanel(value: Panel) {
    setPanel((current) => (current === value ? null : value));
    if (value === 'annotations' || value === 'measurements') setLayerPropertiesOpen(false);
  }

  function closeLayerProperties() {
    setLayerPropertiesOpen(false);
    layerPropertiesButton.current?.focus();
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="./" aria-label="DigitalEarth 首页">
          <span className="brand-symbol">
            <Icon name="orbit" size={28} />
          </span>
          <span>
            DigitalEarth<small>数字地球仿真展示</small>
          </span>
        </a>
        <div className="header-divider" />
        <div className="breadcrumb">
          <span>工作空间</span>
          <Icon name="chevron" size={12} />
          <strong>数字地球</strong>
        </div>
        <span className="version">V0.1</span>
      </header>

      <main className={`workspace ${scene.satellitePlayback && timelineOpen ? 'timeline-expanded' : ''}`}>
        <GlobeViewport onReady={onReady} onSnapshot={onSnapshot} onError={onError} />
        <nav className="navigation" aria-label="工作区功能">
          {navigation.map((item) => (
            <button
              key={item.id}
              className={`nav-item ${panel === item.id ? 'active' : ''}`}
              onClick={() => togglePanel(item.id)}
              aria-pressed={panel === item.id}
              title={item.label}
            >
              <Icon name={item.icon} size={22} />
              <span>{item.label}</span>
            </button>
          ))}
        </nav>

        <div className="scene-heading">
          <span className="eyebrow">DIGITAL EARTH WORKSPACE</span>
          <h1>
            三维场景<span>/</span>
            <small>{scene.satellitePlayback ? '卫星轨迹' : '基础地球'}</small>
          </h1>
        </div>

        <aside className={`floating-panel main-panel ${panel === 'query' ? 'query-panel' : ''} ${panel === 'satellites' ? 'satellites-panel' : ''} ${workspaceTool ? 'map-tools-panel' : ''}`} hidden={!panel} aria-label={currentPanel?.label}>
          <div className="panel-header">
            <div>
              {currentPanel && <><Icon name={currentPanel.icon} size={18} /><h2>{currentPanel.label}</h2></>}
            </div>
            <button className="icon-button" aria-label="收起面板" onClick={() => setPanel(null)}>
              <Icon name="close" size={16} />
            </button>
          </div>
          <div className="panel-content">
            {workspaceTool === 'annotations' && <AnnotationPanel workspace={workspace} canPick={canPick}
              onMeasure={() => setPanel('measurements')} />}
            {workspaceTool === 'measurements' && <MeasurementPanel workspace={workspace} canPick={canPick} />}
            <div hidden={panel !== 'satellites'}>
              <SatellitePanel active={panel === 'satellites'} ready={!!controller.current && !scene.transitioning}
                playback={scene.satellitePlayback}
                onPreview={(norad, xyz) => controller.current?.previewSatellite(norad, xyz) ?? (() => {})}
                onLoad={(manifest, samples, models) => controller.current?.loadSatellites(manifest, samples, models)}
                onFocus={() => controller.current?.focusSatellites()}
                onClear={() => controller.current?.clearSatellites()} />
            </div>
            {panel === 'layers' && (
              <>
                <p className="panel-description">管理地球底图、地形与辅助图层。</p>
                <h3 className="section-title">
                  基础底图<span className="tag">Cesium ion</span>
                </h3>
                <div className="basemap-card">
                  <span className="map-thumbnail">
                    <Icon name="globe" size={29} />
                  </span>
                  <span className="basemap-text">
                    <strong>{sceneConfig.imageryName}</strong>
                    <small>{sceneConfig.imageryDescription}</small>
                  </span>
                </div>
                <div className="resource-detail">
                  <span className="resource-dot" />
                  全球影像 · 在线加载
                </div>
                <div className="panel-divider" />
                <h3 className="section-title">
                  地形资源<span className="tag">{terrainLabels[scene.terrainStatus]}</span>
                </h3>
                <label className="toggle-row">
                  <span>
                    <Icon name="globe" size={17} />
                    真实地形
                  </span>
                  <input
                    type="checkbox"
                    role="switch"
                    checked={terrainActive || terrainBusy}
                    disabled={scene.terrainStatus === 'unconfigured'}
                    onChange={(e) => void controller.current?.setTerrainEnabled(e.target.checked)}
                  />
                  <span className="switch-track" />
                </label>
                <p className="quiet-description terrain-description" role="status">
                  {scene.terrainStatus === 'unconfigured' &&
                    '未配置地形服务，当前使用 WGS84 椭球面。'}
                  {scene.terrainStatus === 'disabled' &&
                    '真实地形已关闭，当前使用 WGS84 椭球面。'}
                  {terrainBusy && '正在连接地形服务，完成后显示真实高程起伏。'}
                  {terrainActive && 'Cesium World Terrain · 高度采用 WGS84 椭球高。'}
                  {scene.terrainStatus === 'error' && scene.terrainError}
                </p>
                {scene.terrainStatus === 'error' && (
                  <button
                    className="text-button"
                    onClick={() => void controller.current?.setTerrainEnabled(true)}
                  >
                    重试加载
                    <Icon name="arrow" size={15} />
                  </button>
                )}
                <div className="panel-divider" />
                <h3 className="section-title">
                  行政区划<span className="tag">{mapLayerLabels[scene.provinceStatus]}</span>
                </h3>
                <label className="toggle-row">
                  <span>
                    <Icon name="layers" size={17} />
                    {provinceBoundary.name}
                  </span>
                  <input
                    type="checkbox"
                    role="switch"
                    checked={scene.provinceSettings.enabled}
                    onChange={(e) => void controller.current?.setProvinceEnabled(e.target.checked)}
                  />
                  <span className="switch-track" />
                </label>
                <p className="quiet-description terrain-description" role="status">
                  {scene.provinceStatus === 'loading' && '正在连接省界地图服务…'}
                  {scene.provinceStatus === 'ready' && '省界描边 · 叠加于卫星影像上。'}
                  {scene.provinceStatus === 'disabled' && '省界图层已关闭。'}
                  {scene.provinceStatus === 'error' && scene.provinceError}
                </p>
                {scene.provinceStatus === 'error' && (
                  <button className="text-button" onClick={() => controller.current?.retryProvinces()}>
                    重试省界加载<Icon name="arrow" size={15} />
                  </button>
                )}
                <div className="province-layer-actions">
                  <button
                    ref={layerPropertiesButton}
                    className="text-button"
                    aria-expanded={layerPropertiesOpen}
                    onClick={() => setLayerPropertiesOpen((open) => !open)}
                  >
                    图层属性<Icon name="layers" size={15} />
                  </button>
                  <button
                    className="text-button"
                    onClick={() => controller.current?.focusProvinces()}
                    disabled={!initialized}
                  >
                    定位到中国<Icon name="locate" size={15} />
                  </button>
                </div>
                <div className="panel-divider" />
                <h3 className="section-title">辅助图层</h3>
                <label className="toggle-row">
                  <span><Icon name="pin" size={17} />地名注记</span>
                  <input type="checkbox" role="switch" checked={workspace.labelsVisible}
                    onChange={event => workspace.setLabelsVisible(event.target.checked)} />
                  <span className="switch-track" />
                </label>
                <label className="toggle-row">
                  <span>
                    <Icon name="grid" size={17} />
                    网格辅助线
                  </span>
                  <input
                    type="checkbox"
                    role="switch"
                    checked={grid}
                    onChange={(e) => {
                      setGrid(e.target.checked);
                      controller.current?.setGrid(e.target.checked);
                    }}
                  />
                  <span className="switch-track" />
                </label>
              </>
            )}
            <div hidden={panel !== 'query'}>
              <QueryPanel
                onLocate={(lon, lat, altitude) => controller.current?.locate(lon, lat, altitude)}
                disabled={!initialized}
                active={panel === 'query'}
                selectedPlaceId={scene.selection?.place?.geoname_id}
                onSelectPlace={(place) => {
                  controller.current?.locate(place.longitude, place.latitude, placeCameraHeight(place), place);
                  setLayerPropertiesOpen(false);
                  setInspectorOpen(true);
                }}
              />
              {pickedPlace && <button className="map-workspace-button map-save-place" type="button"
                disabled={workspace.status.busy} onClick={() => {
                  const started = workspace.annotation.start({
                    longitude: pickedPlace.longitude,
                    latitude: pickedPlace.latitude,
                    name: pickedPlace.name,
                    source_geoname_id: pickedPlace.geoname_id,
                  });
                  if (started) setPanel('annotations');
                }}>
                <Icon name="pen" size={15} />将「{pickedPlace.name}」添加为标注
              </button>}
            </div>
          </div>
          <div className="panel-footer">
            <span className="resource-dot" />
            {scene.status === 'ready'
              ? '场景就绪'
              : scene.status === 'loading'
                ? '场景初始化中'
                : '场景异常'}
            <span>{scene.mode}</span>
          </div>
        </aside>

        {layerPropertiesOpen && (
          <LayerPropertiesPanel
            settings={scene.provinceSettings}
            status={scene.provinceStatus}
            error={scene.provinceError}
            saved={scene.provinceSettingsSaved}
            canLocate={initialized}
            onChange={(patch) => controller.current?.updateProvinceSettings(patch)}
            onLocate={() => controller.current?.focusProvinces()}
            onRetry={() => controller.current?.retryProvinces()}
            onReset={() => controller.current?.resetProvinceSettings()}
            onClose={closeLayerProperties}
          />
        )}

        {inspectorOpen && !layerPropertiesOpen && panel !== 'satellites' && !workspaceTool && (
          <aside className="floating-panel inspector" aria-label="场景信息">
            <div className="panel-header">
              <div>
                <Icon name="pin" size={17} />
                <h2>{scene.selection?.place ? '地点信息' : scene.selection ? '选中位置' : '场景信息'}</h2>
              </div>
              <button
                className="icon-button"
                aria-label="收起场景信息"
                onClick={() => setInspectorOpen(false)}
              >
                <Icon name="close" size={15} />
              </button>
            </div>
            <div className="inspector-content">
              <span className="inspector-label">
                {scene.selection ? 'SURFACE COORDINATES' : 'CAMERA & REFERENCE'}
              </span>
              {scene.selection ? (
                <dl>
                  {scene.selection.place && (
                    <>
                      <div><dt>名称</dt><dd>{scene.selection.place.name}</dd></div>
                      <div><dt>类型</dt><dd>{placeKindLabel(scene.selection.place)}</dd></div>
                      <div><dt>归属</dt><dd className="place-inspector-hierarchy">{placeHierarchy(scene.selection.place)}</dd></div>
                      <div><dt>地点编号</dt><dd>{scene.selection.place.geoname_id}</dd></div>
                      <div><dt>来源</dt><dd>GeoNames</dd></div>
                    </>
                  )}
                  <div>
                    <dt>经度</dt>
                    <dd>{coordinate(scene.selection.longitude, 'E', 'W')}</dd>
                  </div>
                  <div>
                    <dt>纬度</dt>
                    <dd>{coordinate(scene.selection.latitude, 'N', 'S')}</dd>
                  </div>
                  <div>
                    <dt>椭球高</dt>
                    <dd>{surfaceHeight(scene.selection.height)}</dd>
                  </div>
                  <div>
                    <dt>坐标基准</dt>
                    <dd>WGS84</dd>
                  </div>
                </dl>
              ) : (
                <dl>
                  <div>
                    <dt>视角高度</dt>
                    <dd>{formatHeight(scene.cameraHeight)}</dd>
                  </div>
                  <div>
                    <dt>空间参考</dt>
                    <dd>WGS84</dd>
                  </div>
                  <div>
                    <dt>地形资源</dt>
                    <dd>{terrainName}</dd>
                  </div>
                  <div>
                    <dt>场景模式</dt>
                    <dd>{scene.mode}</dd>
                  </div>
                </dl>
              )}
              {scene.selection?.place?.approximate_representative_point && (
                <p className="inspector-hint">此位置为近似代表点。</p>
              )}
              {scene.selection ? (
                <button
                  className="text-button"
                  onClick={() => controller.current?.clearSelection()}
                >
                  清除选中位置
                  <Icon name="close" size={13} />
                </button>
              ) : (
                <p className="inspector-hint">点击地球，查看地表坐标</p>
              )}
            </div>
          </aside>
        )}

        <div className="map-controls" aria-label="地图控制">
          <button
            className="compass"
            aria-label="指北复位"
            title="指北复位"
            onClick={() => controller.current?.northUp()}
            disabled={!initialized}
          >
            <span className="compass-letter">N</span>
            <span className="compass-needle" style={{ transform: `rotate(${-scene.heading}deg)` }}>
              ▲
            </span>
          </button>
          <div className="control-group">
            <button
              aria-label="放大"
              title="放大"
              onClick={() => controller.current?.zoom('in')}
              disabled={!initialized}
            >
              <Icon name="plus" />
            </button>
            <button
              aria-label="缩小"
              title="缩小"
              onClick={() => controller.current?.zoom('out')}
              disabled={!initialized}
            >
              <Icon name="minus" />
            </button>
          </div>
          <div className="control-group">
            <button
              className={scene.mode === '3D' ? 'selected' : ''}
              aria-label="三维视图"
              aria-pressed={scene.mode === '3D'}
              onClick={() => controller.current?.setMode('3D')}
              disabled={!initialized}
            >
              3D
            </button>
            <button
              className={scene.mode === '2D' ? 'selected' : ''}
              aria-label="二维视图"
              aria-pressed={scene.mode === '2D'}
              onClick={() => controller.current?.setMode('2D')}
              disabled={!initialized}
            >
              2D
            </button>
          </div>
          <div className="control-group">
            <button
              aria-label="初始视角"
              title="初始视角"
              onClick={() => controller.current?.home()}
              disabled={!initialized}
            >
              <Icon name="home" />
            </button>
            <button
              aria-label="全球视角"
              title="全球视角"
              onClick={() => controller.current?.globalView()}
              disabled={!initialized}
            >
              <Icon name="globe" />
            </button>
            <button
              aria-label="显示场景信息"
              aria-pressed={inspectorOpen}
              title="场景信息"
              onClick={() => {
                if (layerPropertiesOpen) {
                  setLayerPropertiesOpen(false);
                  setInspectorOpen(true);
                } else setInspectorOpen((value) => !value);
              }}
            >
              <Icon name="info" />
            </button>
          </div>
        </div>

        {scene.satellitePlayback && timelineOpen && <SatelliteControls state={scene.satellitePlayback}
          onPlay={enabled => controller.current?.playSatellites(enabled)}
          onSeek={elapsed => controller.current?.seekSatellites(elapsed)}
          onSpeed={speed => controller.current?.speedSatellites(speed)}
          onFollow={id => controller.current?.followSatellite(id)}
          onCollapse={() => { setTimelineOpen(false); timelineButton.current?.focus(); }} />}

        <div className="mouse-hint" hidden={!!scene.satellitePlayback}>
          <Icon name="mouse" size={14} />
          <span>
            拖动浏览<span className="hint-dot">·</span>滚轮缩放<span className="hint-dot">·</span>
            单击拾取
          </span>
        </div>
        {scene.status === 'loading' && (
          <div className="scene-message" role="status">
            <span className="loading-ring" />
            正在准备三维场景与全球影像…
          </div>
        )}
        {scene.status === 'error' && (
          <div className="scene-error" role="alert">
            <Icon name="info" />
            <div>
              <strong>场景资源加载异常</strong>
              <p>{scene.error}</p>
            </div>
            <button onClick={() => window.location.reload()}>重新加载</button>
          </div>
        )}
      </main>

      <footer className="statusbar">
        <div className="scene-status">
          <span className="status-dot" />
          {scene.status === 'ready'
            ? '场景就绪'
            : scene.status === 'loading'
              ? '初始化中'
              : '资源异常'}
        </div>
        <span className="status-separator" />
        <div className="pointer-values">
          <span>
            经度 <b>{scene.pointer ? coordinate(scene.pointer.longitude, 'E', 'W') : '—'}</b>
          </span>
          <span>
            纬度 <b>{scene.pointer ? coordinate(scene.pointer.latitude, 'N', 'S') : '—'}</b>
          </span>
          <span className="pointer-height">
            椭球高 <b>{scene.pointer ? surfaceHeight(scene.pointer.height) : '—'}</b>
          </span>
        </div>
        <div className="status-right">
          <span>
            视角高度 <b>{formatHeight(scene.cameraHeight)}</b>
          </span>
          <span className="status-separator" />
          <span>WGS84</span>
          <span className="status-mode">{scene.mode}</span>
        </div>
        <button ref={timelineButton} className="timeline-toggle" aria-controls="satellite-timeline"
          aria-expanded={!!scene.satellitePlayback && timelineOpen} disabled={!scene.satellitePlayback}
          title={scene.satellitePlayback ? undefined : '加载卫星轨迹后展开'}
          onClick={() => setTimelineOpen(open => !open)}>
          <Icon name="clock" size={14} /><span>时间轴与曲线</span>
          <Icon name="chevron" size={12} />
        </button>
      </footer>
    </div>
  );
}
