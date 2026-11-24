import {
  Cartesian2,
  Cartesian3,
  Cartographic,
  Color,
  createWorldImageryAsync,
  createWorldTerrainAsync,
  EllipsoidTerrainProvider,
  GridImageryProvider,
  HeightReference,
  ImageryLayer,
  Ion,
  IonWorldImageryStyle,
  LabelStyle,
  Math as CesiumMath,
  Rectangle,
  SceneMode,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  sampleTerrainMostDetailed,
  VerticalOrigin,
  Viewer,
  WebMapServiceImageryProvider,
} from 'cesium';
import { sceneConfig } from '../../config/scene';
import { provinceBoundary } from '../../config/mapServices';
import { SatellitePlayback } from '../satellites/SatellitePlayback';
import type { SatelliteManifest, SatelliteModel, OrbitChunk } from '../satellites/types';
import { MapLabels } from '../mapLabels/MapLabels';
import { WorkspaceScene } from '../mapWorkspace/WorkspaceScene';
import { geodesicPath } from '../mapWorkspace/distance';
import type { WorkspaceInput, WorkspaceOverlay, WorkspaceVertex } from '../mapWorkspace/types';
import { initialSnapshot } from './types';
import type { GeoPosition, SelectedPosition, SceneSnapshot, TerrainStatus } from './types';
import type { PlaceResult } from '../locations/types';
import {
  defaultProvinceSettings, loadProvinceSettings, normalizeProvinceSettings,
  provinceSettingsKey, saveProvinceSettings,
} from '../layers/provinceSettings';
import type { ProvinceSettings } from '../layers/provinceSettings';

/** Owns the Viewer and all Cesium resources. React only receives serializable data. */
export class SceneController {
  private readonly viewer: Viewer;
  private readonly satellitePlayback: SatellitePlayback;
  private readonly workspaceScene: WorkspaceScene;
  private readonly mapLabels: MapLabels;
  private readonly input: ScreenSpaceEventHandler;
  private workspaceInput: WorkspaceInput | null = null;
  private restoreViewerInput?: () => void;
  private readonly disposers: Array<() => void> = [];
  private gridLayer?: ImageryLayer;
  private provinceLayer?: ImageryLayer;
  private provinceRequestId = 0;
  private provinceReloadTimer?: ReturnType<typeof setTimeout>;
  private readonly provinceStorageKey = provinceSettingsKey(provinceBoundary.url, provinceBoundary.layer);
  private removeProvinceErrorListener?: () => void;
  private disposed = false;
  private snapshot = {
    ...initialSnapshot,
    provinceSettings: loadProvinceSettings(this.provinceStorageKey),
  };
  private lastPointerUpdate = 0;
  private requestedGrid = false;
  private terrainRequestId = 0;
  private selectionRevision = 0;
  private removeTerrainErrorListener?: () => void;

  constructor(
    container: HTMLElement,
    private readonly onChange: (state: SceneSnapshot) => void,
  ) {
    window.CESIUM_BASE_URL = sceneConfig.cesiumBaseUrl;
    Ion.defaultAccessToken = sceneConfig.ionToken;
    this.viewer = new Viewer(container, {
      baseLayer: false,
      terrainProvider: new EllipsoidTerrainProvider(),
      animation: false,
      timeline: false,
      geocoder: false,
      baseLayerPicker: false,
      homeButton: false,
      sceneModePicker: false,
      navigationHelpButton: false,
      fullscreenButton: false,
      infoBox: false,
      selectionIndicator: false,
      requestRenderMode: true,
      maximumRenderTimeChange: Number.POSITIVE_INFINITY,
      shouldAnimate: false,
    });
    this.satellitePlayback = new SatellitePlayback(this.viewer, satellitePlayback => this.emit({ satellitePlayback }));
    this.workspaceScene = new WorkspaceScene(this.viewer);
    this.mapLabels = new MapLabels(this.viewer);
    const scene = this.viewer.scene;
    scene.backgroundColor = Color.fromCssColorString('#06162e');
    if (scene.skyBox) scene.skyBox.show = false;
    scene.globe.baseColor = Color.fromCssColorString('#0a2345');
    scene.globe.enableLighting = false;
    scene.screenSpaceCameraController.minimumZoomDistance = 100;
    scene.screenSpaceCameraController.maximumZoomDistance = 100_000_000;
    this.viewer.camera.percentageChanged = 0.01;
    this.home(false);

    this.input = new ScreenSpaceEventHandler(scene.canvas);
    this.input.setInputAction(({ endPosition }: { endPosition: Cartesian2 }) => {
      const now = performance.now();
      if (now - this.lastPointerUpdate < 60) return;
      this.lastPointerUpdate = now;
      const point = this.pick(endPosition);
      this.emit({ pointer: point });
      this.workspaceInput?.onHover(point ? this.workspaceVertex(endPosition, point) : null);
    }, ScreenSpaceEventType.MOUSE_MOVE);
    this.input.setInputAction(({ position }: { position: Cartesian2 }) => {
      const point = this.pick(position);
      if (!point) return;
      if (this.workspaceInput) this.workspaceInput.onPick(this.workspaceVertex(position, point));
      else this.select(point);
    }, ScreenSpaceEventType.LEFT_CLICK);
    const onLeave = () => {
      this.emit({ pointer: null });
      this.workspaceInput?.onHover(null);
    };
    scene.canvas.addEventListener('mouseleave', onLeave);
    this.disposers.push(() => scene.canvas.removeEventListener('mouseleave', onLeave));
    this.disposers.push(this.viewer.camera.changed.addEventListener(() => this.updateCamera()));
    this.disposers.push(this.viewer.camera.moveEnd.addEventListener(() => this.updateCamera()));
    this.disposers.push(
      scene.morphStart.addEventListener(() => {
        this.emit({ transitioning: true, pointer: null });
        this.workspaceInput?.onHover(null);
      }),
    );
    this.disposers.push(
      scene.morphComplete.addEventListener(() => {
        this.emit({ transitioning: false });
        this.updateCamera();
      }),
    );
    this.disposers.push(
      scene.renderError.addEventListener((_scene, error: Error) => {
        this.emit({ status: 'error', error: `场景渲染失败：${error.message}` });
      }),
    );
    this.updateCamera();
    this.gridLayer = this.viewer.imageryLayers.addImageryProvider(
      new GridImageryProvider({
        cells: 8,
        color: Color.WHITE.withAlpha(0.24),
        glowColor: Color.TRANSPARENT,
        backgroundColor: Color.TRANSPARENT,
      }),
    );
    this.gridLayer.show = this.requestedGrid;
    if (this.snapshot.provinceSettings.enabled) void this.loadProvinceLayer();
    void this.loadImagery();
    void this.setTerrainEnabled(true);
  }

  private emit(patch: Partial<SceneSnapshot>) {
    if (this.disposed) return;
    this.snapshot = { ...this.snapshot, ...patch };
    this.onChange(this.snapshot);
  }

  private async loadImagery() {
    if (!sceneConfig.ionToken) {
      this.emit({
        status: 'error',
        error: '未配置 Cesium ion Token，无法加载全球影像。请在 .env.local 中配置后重启服务。',
      });
      return;
    }
    try {
      const provider = await createWorldImageryAsync({ style: IonWorldImageryStyle.AERIAL });
      // A StrictMode cleanup or unmount may happen while ion metadata loads.
      if (this.disposed) return;
      this.viewer.imageryLayers.addImageryProvider(provider, 0);
      this.disposers.push(
        provider.errorEvent.addEventListener(() => {
          this.emit({
            status: 'error',
            error: '全球影像瓦片加载失败，请检查 Cesium ion Token 的影像读取权限和网络后重试。',
          });
        }),
      );
      this.emit({ status: 'ready', error: undefined });
      this.viewer.scene.requestRender();
    } catch {
      this.emit({
        status: 'error',
        error: '全球影像服务连接失败，请检查 Cesium ion Token 的影像读取权限和网络后重试。',
      });
    }
  }

  private updateCamera() {
    // Heading and cartographic position are temporarily undefined while morphing.
    if (this.viewer.scene.mode === SceneMode.MORPHING) return;
    this.emit({
      cameraHeight: this.viewer.camera.positionCartographic.height,
      heading: CesiumMath.toDegrees(this.viewer.camera.heading),
      mode: this.viewer.scene.mode === SceneMode.SCENE2D ? '2D' : '3D',
    });
  }

  private pick(position: Cartesian2): GeoPosition | null {
    if (this.viewer.scene.mode === SceneMode.MORPHING) return null;
    if (this.snapshot.terrainStatus === 'ready') {
      const ray = this.viewer.camera.getPickRay(position);
      const point = ray && this.viewer.scene.globe.pick(ray, this.viewer.scene);
      if (!point) return null;
      const location = Cartographic.fromCartesian(point);
      return {
        longitude: CesiumMath.toDegrees(location.longitude),
        latitude: CesiumMath.toDegrees(location.latitude),
        height: Number.isFinite(location.height) ? location.height : null,
      };
    }
    // Use an exact ellipsoid intersection while no real terrain is active.
    const point = this.viewer.camera.pickEllipsoid(position, this.viewer.scene.globe.ellipsoid);
    if (!point) return null;
    const location = Cartographic.fromCartesian(point);
    return {
      longitude: CesiumMath.toDegrees(location.longitude),
      latitude: CesiumMath.toDegrees(location.latitude),
      height: 0,
    };
  }

  private workspaceVertex(screen: Cartesian2, point: GeoPosition): WorkspaceVertex {
    return this.workspaceScene.pickPoint(screen) ?? this.mapLabels.pickVertex(screen) ?? {
      longitude: point.longitude,
      latitude: point.latitude,
    };
  }

  setWorkspaceInput(input: WorkspaceInput | null) {
    if (this.disposed) return;
    const wasActive = this.workspaceInput !== null;
    this.workspaceInput = input;
    if (input && !wasActive) {
      this.satellitePlayback.follow(null);
      const { screenSpaceEventHandler, scene } = this.viewer;
      const click = screenSpaceEventHandler.getInputAction(ScreenSpaceEventType.LEFT_CLICK);
      const doubleClick = screenSpaceEventHandler.getInputAction(ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
      const cursor = scene.canvas.style.cursor;
      screenSpaceEventHandler.removeInputAction(ScreenSpaceEventType.LEFT_CLICK);
      screenSpaceEventHandler.removeInputAction(ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
      scene.canvas.style.cursor = 'crosshair';
      this.restoreViewerInput = () => {
        if (click) screenSpaceEventHandler.setInputAction(click, ScreenSpaceEventType.LEFT_CLICK);
        if (doubleClick) screenSpaceEventHandler.setInputAction(doubleClick, ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
        scene.canvas.style.cursor = cursor;
      };
    } else if (!input && wasActive) {
      this.restoreViewerInput?.();
      this.restoreViewerInput = undefined;
    }
  }

  setWorkspaceOverlay(overlay: WorkspaceOverlay) {
    if (this.disposed) return;
    const priorityPoints = this.workspaceScene.setOverlay(overlay);
    if (priorityPoints) this.mapLabels.setPriorityPoints(priorityPoints);
  }

  focusWorkspacePoints(points: WorkspaceVertex[]) {
    if (this.disposed || this.snapshot.transitioning || points.length === 0) return;
    this.satellitePlayback.follow(null);
    const path = points.length === 1 ? points : points.slice(1).flatMap((point, i) => geodesicPath(points[i], point));
    const bounds = Rectangle.fromCartographicArray(path.map(point => Cartographic.fromDegrees(point.longitude, point.latitude)));
    let destination: Cartesian3 | Rectangle;
    if (points.length === 1) {
      const center = Rectangle.center(bounds);
      destination = Cartesian3.fromRadians(center.longitude, center.latitude, 130_000);
    } else {
      const padding = Math.max(CesiumMath.toRadians(0.01), Math.max(bounds.width, bounds.height) * 0.15);
      destination = bounds.width + 2 * padding >= CesiumMath.TWO_PI ? Rectangle.MAX_VALUE : new Rectangle(
        CesiumMath.negativePiToPi(bounds.west - padding), Math.max(-CesiumMath.PI_OVER_TWO, bounds.south - padding),
        CesiumMath.negativePiToPi(bounds.east + padding), Math.min(CesiumMath.PI_OVER_TWO, bounds.north + padding),
      );
    }
    this.viewer.camera.flyTo({
      destination,
      duration: 1.2,
      orientation: { heading: 0, pitch: -CesiumMath.PI_OVER_TWO, roll: 0 },
    });
  }

  setMapLabelsVisible(visible: boolean) {
    if (!this.disposed) this.mapLabels.setVisible(visible);
  }

  select(position: SelectedPosition) {
    this.selectionRevision++;
    const heightReference =
      this.snapshot.terrainStatus === 'ready'
        ? HeightReference.CLAMP_TO_GROUND
        : HeightReference.NONE;
    this.viewer.entities.removeById('selected-position');
    this.viewer.entities.add({
      id: 'selected-position',
      position: Cartesian3.fromDegrees(position.longitude, position.latitude, position.height ?? 0),
      point: {
        pixelSize: 9,
        color: Color.WHITE,
        outlineColor: Color.fromCssColorString('#17559a'),
        outlineWidth: 3,
        heightReference,
      },
      label: {
        text: position.place?.name ?? `${position.longitude.toFixed(3)}°, ${position.latitude.toFixed(3)}°`,
        font: '12px sans-serif',
        fillColor: Color.WHITE,
        outlineColor: Color.fromCssColorString('#081320'),
        outlineWidth: 4,
        style: LabelStyle.FILL_AND_OUTLINE,
        pixelOffset: new Cartesian2(0, -18),
        verticalOrigin: VerticalOrigin.BOTTOM,
        heightReference,
      },
    });
    this.emit({ selection: position });
    this.viewer.scene.requestRender();
  }

  clearSelection() {
    this.selectionRevision++;
    this.viewer.entities.removeById('selected-position');
    this.emit({ selection: null });
    this.viewer.scene.requestRender();
  }

  locate(longitude: number, latitude: number, cameraAltitude: number, place?: PlaceResult) {
    this.satellitePlayback.follow(null);
    const useTerrain = this.snapshot.terrainStatus === 'ready';
    this.select({ longitude, latitude, height: useTerrain ? null : 0, place });
    if (useTerrain) void this.sampleSelectedHeight(longitude, latitude);
    this.viewer.camera.flyTo({
      destination: Cartesian3.fromDegrees(longitude, latitude, cameraAltitude),
      duration: 1.4,
      orientation: { heading: 0, pitch: -CesiumMath.PI_OVER_TWO, roll: 0 },
    });
  }

  private async sampleSelectedHeight(longitude: number, latitude: number) {
    const revision = this.selectionRevision;
    const requestId = this.terrainRequestId;
    try {
      const [point] = await sampleTerrainMostDetailed(this.viewer.terrainProvider, [
        Cartographic.fromDegrees(longitude, latitude),
      ]);
      if (
        this.disposed ||
        revision !== this.selectionRevision ||
        requestId !== this.terrainRequestId
      )
        return;
      if (Number.isFinite(point.height) && this.snapshot.selection) {
        this.select({ ...this.snapshot.selection, height: point.height });
      }
    } catch {
      // Keep an unknown height unknown; do not manufacture a zero elevation.
    }
  }

  home(animate = true) {
    this.setView(sceneConfig.initialView, animate);
  }

  globalView() {
    this.setView(sceneConfig.globalView, true);
  }

  private setView(
    view: { longitude: number; latitude: number; altitude: number },
    animate: boolean,
  ) {
    this.satellitePlayback.follow(null);
    const options = {
      destination: Cartesian3.fromDegrees(view.longitude, view.latitude, view.altitude),
      orientation: { heading: 0, pitch: -CesiumMath.PI_OVER_TWO, roll: 0 },
    };
    if (animate) this.viewer.camera.flyTo({ ...options, duration: 1.2 });
    else this.viewer.camera.setView(options);
  }

  zoom(direction: 'in' | 'out') {
    const amount = Math.max(50, this.viewer.camera.positionCartographic.height * 0.35);
    if (direction === 'in') this.viewer.camera.zoomIn(amount);
    else this.viewer.camera.zoomOut(amount);
    this.viewer.scene.requestRender();
    this.updateCamera();
  }

  northUp() {
    if (this.viewer.scene.mode !== SceneMode.SCENE3D) return;
    this.viewer.camera.flyTo({
      destination: this.viewer.camera.positionWC,
      orientation: { heading: 0, pitch: this.viewer.camera.pitch, roll: 0 },
      duration: 0.6,
    });
  }

  setMode(mode: '2D' | '3D') {
    if (this.viewer.scene.mode === SceneMode.MORPHING || this.snapshot.mode === mode) return;
    if (mode === '2D') this.viewer.scene.morphTo2D(0.6);
    else this.viewer.scene.morphTo3D(0.6);
  }

  setGrid(show: boolean) {
    this.requestedGrid = show;
    if (this.gridLayer) this.gridLayer.show = show;
    this.viewer.scene.requestRender();
  }

  setProvinceEnabled(enabled: boolean) {
    if (this.disposed) return;
    this.updateProvinceSettings({ enabled });
  }

  updateProvinceSettings(patch: Partial<ProvinceSettings>) {
    if (this.disposed) return;
    const previous = this.snapshot.provinceSettings;
    const settings = normalizeProvinceSettings({ ...previous, ...patch });
    const styleChanged = settings.lineColor !== previous.lineColor || settings.lineWidth !== previous.lineWidth;
    this.emit({
      provinceSettings: settings,
      provinceSettingsSaved: saveProvinceSettings(this.provinceStorageKey, settings),
    });
    if (this.provinceLayer) this.provinceLayer.alpha = settings.opacity;
    this.viewer.scene.requestRender();
    if (!settings.enabled) {
      clearTimeout(this.provinceReloadTimer);
      ++this.provinceRequestId;
      this.removeProvinceErrorListener?.();
      this.removeProvinceErrorListener = undefined;
      if (this.provinceLayer) this.viewer.imageryLayers.remove(this.provinceLayer, true);
      this.provinceLayer = undefined;
      this.emit({ provinceStatus: 'disabled', provinceError: undefined });
    } else if (!previous.enabled || styleChanged) {
      // Invalidate earlier responses immediately, including during the debounce interval.
      ++this.provinceRequestId;
      clearTimeout(this.provinceReloadTimer);
      this.emit({ provinceStatus: 'loading', provinceError: undefined });
      this.provinceReloadTimer = setTimeout(() => void this.loadProvinceLayer(), 250);
    }
  }

  resetProvinceSettings() {
    this.updateProvinceSettings({ ...defaultProvinceSettings });
  }

  retryProvinces() {
    if (this.disposed || !this.snapshot.provinceSettings.enabled) return;
    clearTimeout(this.provinceReloadTimer);
    void this.loadProvinceLayer();
  }

  private async loadProvinceLayer() {
    if (this.disposed || !this.snapshot.provinceSettings.enabled) return;
    const requestId = ++this.provinceRequestId;
    const settings = this.snapshot.provinceSettings;
    this.emit({ provinceStatus: 'loading', provinceError: undefined });
    try {
      const { west, south, east, north } = provinceBoundary.bounds;
      const provider = new WebMapServiceImageryProvider({
        url: provinceBoundary.url,
        layers: provinceBoundary.layer,
        parameters: {
          version: '1.1.1', format: 'image/png', transparent: true,
          styles: provinceBoundary.style,
          env: `lineColor:${settings.lineColor};lineWidth:${settings.lineWidth}`,
        },
        srs: 'EPSG:4326',
        rectangle: Rectangle.fromDegrees(west, south, east, north),
        enablePickFeatures: false,
      });
      // Verify a real PNG from the hemisphere containing China before reporting ready.
      const probe = await provider.requestImage(1, 0, 0);
      if (!probe) throw new Error('WMS image unavailable');
      if (probe instanceof ImageBitmap) probe.close();
      if (this.disposed || requestId !== this.provinceRequestId) return;
      // Keep the last working layer visible until the replacement passes its PNG probe.
      const previous = this.provinceLayer;
      const index = previous ? this.viewer.imageryLayers.indexOf(previous) : undefined;
      const layer = this.viewer.imageryLayers.addImageryProvider(provider, index);
      layer.alpha = this.snapshot.provinceSettings.opacity;
      this.removeProvinceErrorListener?.();
      if (previous) this.viewer.imageryLayers.remove(previous, true);
      this.provinceLayer = layer;
      if (this.gridLayer) this.viewer.imageryLayers.raiseToTop(this.gridLayer);
      this.removeProvinceErrorListener = provider.errorEvent.addEventListener(() => {
        if (this.disposed || requestId !== this.provinceRequestId) return;
        layer.show = false;
        this.emit({
          provinceStatus: 'error',
          provinceError: '省界瓦片加载失败，请检查 GeoServer 后重试。',
        });
        this.viewer.scene.requestRender();
      });
      this.emit({ provinceStatus: 'ready', provinceError: undefined });
      this.viewer.scene.requestRender();
    } catch {
      if (this.disposed || requestId !== this.provinceRequestId) return;
      this.emit({
        provinceStatus: 'error',
        provinceError: this.provinceLayer?.show
          ? '新样式加载失败，暂保留上次显示。请检查地图服务后重试。'
          : '无法加载省界，请确认地图服务及可调样式可用，再重试。',
      });
    }
  }

  focusProvinces() {
    this.satellitePlayback.follow(null);
    const { west, south, east, north } = provinceBoundary.bounds;
    this.viewer.camera.flyTo({
      destination: Rectangle.fromDegrees(west - 2, south - 2, east + 2, north + 2),
      duration: 1.2,
      orientation: { heading: 0, pitch: -CesiumMath.PI_OVER_TWO, roll: 0 },
    });
  }

  async setTerrainEnabled(enabled: boolean) {
    if (this.disposed) return;
    if (
      enabled &&
      (this.snapshot.terrainStatus === 'loading' || this.snapshot.terrainStatus === 'ready')
    )
      return;
    const requestId = ++this.terrainRequestId;
    this.removeTerrainErrorListener?.();
    this.removeTerrainErrorListener = undefined;
    if (!sceneConfig.ionToken) {
      this.restoreEllipsoid('unconfigured');
      return;
    }
    if (!enabled) {
      this.restoreEllipsoid('disabled');
      return;
    }
    this.emit({ terrainStatus: 'loading', terrainError: undefined });
    try {
      const provider = await createWorldTerrainAsync();
      if (this.disposed || requestId !== this.terrainRequestId) return;
      this.removeTerrainErrorListener = provider.errorEvent.addEventListener(() => {
        if (this.disposed || requestId !== this.terrainRequestId) return;
        ++this.terrainRequestId;
        this.removeTerrainErrorListener?.();
        this.removeTerrainErrorListener = undefined;
        this.restoreEllipsoid(
          'error',
          '地形瓦片加载失败，已恢复椭球面。请检查访问权限和网络后重试。',
        );
      });
      this.viewer.terrainProvider = provider;
      this.clearSelection();
      this.emit({ terrainStatus: 'ready', terrainError: undefined, pointer: null });
      this.viewer.scene.requestRender();
    } catch {
      if (this.disposed || requestId !== this.terrainRequestId) return;
      // Do not echo service URLs or access tokens into interface error messages.
      this.restoreEllipsoid(
        'error',
        '地形服务连接失败，已使用椭球面。请检查访问凭据、权限和网络后重试。',
      );
    }
  }

  private restoreEllipsoid(status: TerrainStatus, error?: string) {
    this.viewer.terrainProvider = new EllipsoidTerrainProvider();
    this.clearSelection();
    this.emit({ terrainStatus: status, terrainError: error, pointer: null });
    this.viewer.scene.requestRender();
  }

  previewSatellite(norad: number, xyz: number[]) { return this.satellitePlayback.preview(norad, xyz); }
  loadSatellites(manifest: SatelliteManifest, samples: OrbitChunk, models: SatelliteModel[]) { return this.satellitePlayback.load(manifest, samples, models); }
  playSatellites(enabled: boolean) { this.satellitePlayback.play(enabled); }
  seekSatellites(seconds: number) { this.satellitePlayback.seek(seconds); }
  speedSatellites(speed: number) { this.satellitePlayback.speed(speed); }
  followSatellite(id: string | null) { this.satellitePlayback.follow(id); }
  focusSatellites() { this.satellitePlayback.focus(); }
  clearSatellites() { this.satellitePlayback.clear(); }

  destroy() {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.provinceReloadTimer);
    ++this.provinceRequestId;
    this.removeProvinceErrorListener?.();
    ++this.terrainRequestId;
    this.removeTerrainErrorListener?.();
    this.disposers.forEach((dispose) => dispose());
    this.mapLabels.destroy();
    this.workspaceScene.destroy();
    this.satellitePlayback.destroy();
    this.input.destroy();
    this.viewer.destroy();
  }
}
