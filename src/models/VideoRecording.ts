import type { HighlightShape } from "./VisualHighlight";
import type { PanelRole } from "./DisplayPanel";

export interface VideoRecordingPanel {
  key: string;
  role: PanelRole;
}

export interface VideoRecordingDisplayTransition {
  atMs: number;
  from: VideoRecordingPanel;
  to: VideoRecordingPanel;
}

export type VideoQualityPreset = "low" | "medium" | "high";

export type VideoFormat = "mp4";

/**
 * The container of a finished recording's file. Recordings are requested as `mp4`, but an
 * iOS capture whose post-processing did not finish is returned as its raw `.mov` (#10188).
 */
export type VideoContainerFormat = VideoFormat | "mov";

export interface VideoResolution {
  width: number;
  height: number;
}

export interface VideoResolutionInput {
  width?: number | string;
  height?: number | string;
}

export interface VideoRecordingConfig {
  qualityPreset: VideoQualityPreset;
  targetBitrateKbps: number;
  maxThroughputMbps: number;
  fps: number;
  maxArchiveSizeMb: number;
  format: VideoFormat;
  resolution?: VideoResolution;
}

export interface VideoRecordingConfigInput {
  qualityPreset?: VideoQualityPreset | string;
  targetBitrateKbps?: number | string;
  maxThroughputMbps?: number | string;
  fps?: number | string;
  maxArchiveSizeMb?: number | string;
  format?: VideoFormat | string;
  resolution?: VideoResolutionInput;
}

export interface VideoRecordingHighlightTiming {
  startTimeMs?: number;
}

export interface VideoRecordingHighlightInput {
  description?: string;
  shape: HighlightShape;
  timing?: VideoRecordingHighlightTiming;
}

export interface VideoRecordingHighlightTimeline {
  appearedAtSeconds: number;
  disappearedAtSeconds?: number;
}

export interface VideoRecordingHighlightEntry {
  description?: string;
  shape: HighlightShape;
  timeline: VideoRecordingHighlightTimeline;
}

export interface VideoRecordingMetadata {
  recordingId: string;
  fileName: string;
  filePath: string;
  format: VideoContainerFormat;
  sizeBytes: number;
  /** Wall-clock time between recording start and stop. */
  durationMs?: number;
  /**
   * Playable duration of the finalized file, read from the container (`mvhd`).
   * Can be shorter than `durationMs`: Android `screenrecord` only writes frames
   * when the screen changes, so an idle screen yields a shorter file.
   */
  videoDurationMs?: number;
  codec?: string;
  outputName?: string;
  createdAt: string;
  startedAt: string;
  endedAt?: string;
  lastAccessedAt: string;
  config: VideoRecordingConfig;
  highlights?: VideoRecordingHighlightEntry[];
  recordedPanel?: VideoRecordingPanel;
  transitions?: VideoRecordingDisplayTransition[];
  warnings?: string[];
}
