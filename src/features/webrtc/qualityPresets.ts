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

/** Maximum encoded long edge, matching the on-device video-server presets. */
export const QUALITY_PRESET_MAX_LONG_SIDE: Record<CaptureQualityPreset, number> = {
  low: 540,
  medium: 720,
  high: 1080,
};

/** Scale down to the preset's long edge, preserving aspect ratio and even dimensions. */
export function capToQualityPreset(
  size: { width: number; height: number },
  quality: CaptureQualityPreset | undefined,
): { width: number; height: number } {
  if (!quality) {
    return size;
  }
  // Invalid dimensions have no meaningful aspect ratio; preserve them rather than invent a size.
  if (
    !Number.isFinite(size.width) ||
    !Number.isFinite(size.height) ||
    size.width <= 0 ||
    size.height <= 0
  ) {
    return size;
  }
  const maxLongSide = QUALITY_PRESET_MAX_LONG_SIDE[quality];
  const longSide = Math.max(size.width, size.height);
  if (longSide <= maxLongSide) {
    return { width: Math.max(2, size.width & ~1), height: Math.max(2, size.height & ~1) };
  }
  const scale = maxLongSide / longSide;
  if (size.height >= size.width) {
    return { width: Math.max(2, Math.trunc(size.width * scale) & ~1), height: maxLongSide };
  }
  return { width: maxLongSide, height: Math.max(2, Math.trunc(size.height * scale) & ~1) };
}

/** The preset's default bitrate, or undefined when no preset was requested. */
export function qualityPresetBitrateBps(
  quality: CaptureQualityPreset | undefined,
): number | undefined {
  return quality ? QUALITY_PRESET_BITRATE_BPS[quality] : undefined;
}
