import type { FixedOrbit } from './fixedOrbit';
export const satellitePlaybackSpeeds = [1, 30, 60, 120, 300, 600, 1200, 3600] as const;

export interface SatelliteEntry {
  norad_id: number;
  display_name: string;
  category: string;
  category_name: string;
  orbit_type: 'LEO' | 'MEO' | 'GEO';
  object_name: string;
  epoch_utc: string;
  fetched_at: string;
  source_url: string;
  age_hours: number;
}
export interface SatelliteCatalog {
  provider: string;
  max_selected: number;
  update_error: string | null;
  next_update_at: string | null;
  satellites: SatelliteEntry[];
}
export interface TrackSatellite {
  satellite_id: string;
  norad_id: number;
  display_name: string;
  object_name: string;
  sample_count: number;
  pack_key?: string;
  format?: "ORF1";
  source_epoch?: number;
  display_step_s?: number;
  blocks?: Array<{ key?: string; offset?: number; length?: number; start: number; count: number }>;
  overview?: number[];
  period_s: number;
  element_epoch_utc: string;
  fetched_at: string;
  source_url: string;
}
export interface SatelliteManifest {
  schema_version: 'satellites-1';
  result_id: string;
  epoch_utc: string;
  stop_utc: string;
  duration_s: number;
  output_step_s: number;
  position_frame: 'ECEF_APPROX';
  position_unit: 'm';
  satellites: TrackSatellite[];
  window_kind: 'historical' | 'current-window';
  samples_url: string;
}
export interface SatelliteSamples {
  schema_version: 'satellite-samples-1';
  result_id: string;
  satellites: Array<{ satellite_id: string; samples: number[][] }>;
}
export interface SatelliteModel {
  norad_id: number;
  asset_id: string;
  asset_name: string;
  version_id: string;
  version: number;
  model_url: string;
  render_options: { scale: number; minimum_pixel_size: number; maximum_scale: number };
  source_info: {
    author: string;
    source_url: string;
    license: string;
    license_url: string;
    title: string;
    license_text?: string;
  };
}
export interface SatelliteModelResolution {
  models: SatelliteModel[];
}
export interface SatelliteJob {
  preview_supported?: boolean;
  job_id: string;
  result_id: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  error: string | null;
  result_url: string;
  cache_hit?: boolean;
}
export interface SatellitePlaybackState {
  manifest: SatelliteManifest;
  models: SatelliteModel[];
  elapsed: number;
  currentUtc: string;
  loadError?: string;
  playing: boolean;
  speed: number;
  following: string | null;
  positions: Array<{ satellite_id: string; longitude: number; latitude: number; height: number }>;
}

export interface OrbitChunk {
  fixed?: FixedOrbit;
  satellite: TrackSatellite;
  first: number;
  xyz: Float64Array;
  nextWindow?: (seconds: number, ahead: number, signal: AbortSignal) => Promise<OrbitChunk> | undefined;
}
export type ReceiveChunk = (manifest: SatelliteManifest, chunk: OrbitChunk, models: SatelliteModel[]) => number | void;
