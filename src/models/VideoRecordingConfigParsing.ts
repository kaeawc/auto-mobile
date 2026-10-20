import type {
  VideoFormat,
  VideoQualityPreset,
  VideoRecordingConfig,
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

const QUALITY_PRESETS: readonly VideoQualityPreset[] = ["low", "medium", "high"];
const VIDEO_FORMATS: readonly VideoFormat[] = ["mp4"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse a recording config from any caller (tool arguments, stored settings): the input is
 * untrusted, so every field is validated and falls back to its default instead of throwing.
 */
export function parseVideoRecordingConfig(input: unknown): VideoRecordingConfig {
  const safeInput: Record<string, unknown> = isRecord(input) ? input : {};

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

function parseQualityPreset(value: unknown): VideoQualityPreset {
  return (
    QUALITY_PRESETS.find((preset) => preset === value) ??
    DEFAULT_VIDEO_RECORDING_CONFIG.qualityPreset
  );
}

function parseFormat(value: unknown): VideoFormat {
  return VIDEO_FORMATS.find((format) => format === value) ?? DEFAULT_VIDEO_RECORDING_CONFIG.format;
}

function parseResolution(value: unknown): VideoResolution | undefined {
  if (!isRecord(value)) {
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

function parsePositiveNumber(value: unknown, defaultValue: number, allowFloat: boolean): number {
  if (value === null || value === undefined) {
    return defaultValue;
  }

  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return defaultValue;
  }

  return allowFloat ? parsed : Math.round(parsed);
}
