import type {
  VideoFormat,
  VideoQualityPreset,
  VideoRecordingConfig,
  VideoRecordingConfigInput,
  VideoResolution,
} from "./VideoRecording";

export const DEFAULT_VIDEO_RECORDING_CONFIG: VideoRecordingConfig = {
  qualityPreset: "low",
  targetBitrateKbps: 1000,
  maxThroughputMbps: 5,
  fps: 15,
  maxArchiveSizeMb: 100,
  format: "mp4",
};

const QUALITY_PRESETS = new Set<VideoQualityPreset>(["low", "medium", "high"]);
const VIDEO_FORMATS = new Set<VideoFormat>(["mp4"]);

export function parseVideoRecordingConfig(
  input: VideoRecordingConfigInput | null | undefined,
): VideoRecordingConfig {
  const safeInput: VideoRecordingConfigInput = input && typeof input === "object" ? input : {};

  const qualityPreset = parseQualityPreset(safeInput.qualityPreset);
  const maxThroughputMbps = parsePositiveNumber(
    safeInput.maxThroughputMbps,
    DEFAULT_VIDEO_RECORDING_CONFIG.maxThroughputMbps,
    true,
  );
  const requestedBitrateKbps = parsePositiveNumber(
    safeInput.targetBitrateKbps,
    DEFAULT_VIDEO_RECORDING_CONFIG.targetBitrateKbps,
    true,
  );
  const targetBitrateKbps = capBitrateKbps(requestedBitrateKbps, maxThroughputMbps);
  const fps = parsePositiveNumber(safeInput.fps, DEFAULT_VIDEO_RECORDING_CONFIG.fps, false);
  const maxArchiveSizeMb = parsePositiveNumber(
    safeInput.maxArchiveSizeMb,
    DEFAULT_VIDEO_RECORDING_CONFIG.maxArchiveSizeMb,
    true,
  );
  const format = parseFormat(safeInput.format);
  const resolution = parseResolution(safeInput.resolution);

  return {
    qualityPreset,
    targetBitrateKbps,
    maxThroughputMbps,
    fps,
    maxArchiveSizeMb,
    format,
    resolution,
  };
}

function parseQualityPreset(value: VideoRecordingConfigInput["qualityPreset"]): VideoQualityPreset {
  if (typeof value === "string" && QUALITY_PRESETS.has(value as VideoQualityPreset)) {
    return value as VideoQualityPreset;
  }

  return DEFAULT_VIDEO_RECORDING_CONFIG.qualityPreset;
}

function parseFormat(value: VideoRecordingConfigInput["format"]): VideoFormat {
  if (typeof value === "string" && VIDEO_FORMATS.has(value as VideoFormat)) {
    return value as VideoFormat;
  }

  return DEFAULT_VIDEO_RECORDING_CONFIG.format;
}

function parseResolution(
  value: VideoRecordingConfigInput["resolution"],
): VideoResolution | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const width = parsePositiveNumber(value.width, 0, false);
  const height = parsePositiveNumber(value.height, 0, false);

  if (width <= 0 || height <= 0) {
    return undefined;
  }

  return { width, height };
}

export function capBitrateKbps(targetBitrateKbps: number, maxThroughputMbps: number): number {
  if (!(maxThroughputMbps > 0)) {
    return targetBitrateKbps;
  }

  // Throughput caps use whole Kbps: 1 Kbps is the minimum representable cap.
  // A smaller positive budget must not round to zero and disable the cap.
  const maxBitrateKbps = Math.max(1, Math.floor(maxThroughputMbps * 1000));
  return Math.min(targetBitrateKbps, maxBitrateKbps);
}

function parsePositiveNumber(
  value: number | string | undefined,
  defaultValue: number,
  allowFloat: boolean,
): number {
  if (value === null || value === undefined) {
    return defaultValue;
  }

  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return defaultValue;
  }

  return allowFloat ? parsed : Math.round(parsed);
}
