/**
 * Host-side mirror of the on-device video-server quality presets
 * (`android/video-server/.../QualityPreset.kt`): low=540p/2Mbps, medium=720p/4Mbps,
 * high=1080p/8Mbps. The persistent Android encoder applies the preset on-device; capture
 * sources that cannot (the Android `screenrecord` fallback, the iOS sources) use this table
 * so a preset hint means the same thing on every backend.
 */

export type CaptureQualityPreset = "low" | "medium" | "high";

/** Default encoder bitrates per preset, mirroring the on-device `QualityPreset` table. */
const QUALITY_PRESET_BITRATE_BPS: Record<CaptureQualityPreset, number> = {
  low: 2_000_000,
  medium: 4_000_000,
  high: 8_000_000,
};

/** The preset's default bitrate, or undefined when no preset was requested. */
export function qualityPresetBitrateBps(
  quality: CaptureQualityPreset | undefined
): number | undefined {
  return quality ? QUALITY_PRESET_BITRATE_BPS[quality] : undefined;
}
