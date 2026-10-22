import { invalidateDisplayCaches } from "../observe/DisplayTransition";

/** Relative density buckets, resolved against the device's physical density. */
export type DensityBucket = "smaller" | "default" | "larger";

/** Density input: an explicit effective dpi, or a relative bucket. */
export type DensityInput = number | DensityBucket;

/** Scale factors for the relative density buckets (against physical density). */
const DENSITY_BUCKET_FACTORS: Record<Exclude<DensityBucket, "default">, number> = {
  smaller: 0.85,
  larger: 1.15,
};

/** `wm density` rejects values below this AOSP-supported floor. */
export const MIN_ANDROID_DENSITY_DPI = 72;

/**
 * Safety ceiling for explicit and relative density requests. AOSP's
 * `DisplayMetrics.DENSITY_XXXHIGH` is 640 dpi; 1280 dpi gives high-density
 * panels orchestrator-chosen headroom while bounding requests after issue
 * #11660 triggered a system_server ANR with an unbounded density.
 * Source: frameworks/base/core/java/android/util/DisplayMetrics.java.
 */
export const MAX_ANDROID_DENSITY_DPI = 1280;

/**
 * Resolve a density input to a `wm density` command. A number is an explicit
 * dpi; `default` resets to physical; `smaller`/`larger` scale the physical
 * density (returns null when it could not be read, so buckets are never guessed).
 */
export function resolveDensityCommand(
  density: DensityInput,
  physical: number | undefined,
): { command: string; target: number | "default" } | { error: string } {
  if (typeof density === "number") {
    const target = Math.round(density);
    if (target < MIN_ANDROID_DENSITY_DPI) {
      return {
        error: `Cannot set display density: ${target} dpi is below Android's ${MIN_ANDROID_DENSITY_DPI} dpi minimum.`,
      };
    }
    if (target > MAX_ANDROID_DENSITY_DPI) {
      return {
        error: `Cannot set display density: ${target} dpi exceeds Android's ${MAX_ANDROID_DENSITY_DPI} dpi maximum.`,
      };
    }
    return { command: `shell wm density ${target}`, target };
  }
  if (density === "default") {
    return { command: "shell wm density reset", target: "default" };
  }
  if (physical === undefined) {
    return {
      error:
        `Cannot resolve relative density bucket '${density}': the device's physical density ` +
        "could not be read.",
    };
  }
  const scaled = Math.round(physical * DENSITY_BUCKET_FACTORS[density]);
  if (scaled < MIN_ANDROID_DENSITY_DPI) {
    return {
      error:
        `Cannot resolve relative density bucket '${density}': ${scaled} dpi is below Android's ` +
        `${MIN_ANDROID_DENSITY_DPI} dpi minimum.`,
    };
  }
  if (scaled > MAX_ANDROID_DENSITY_DPI) {
    return {
      error:
        `Cannot resolve relative density bucket '${density}': ${scaled} dpi exceeds Android's ` +
        `${MAX_ANDROID_DENSITY_DPI} dpi maximum.`,
    };
  }
  return { command: `shell wm density ${scaled}`, target: scaled };
}

/** Density moves every dp-based bound, so cached observations and coordinates are stale. */
export function invalidateAfterDensityChange(
  device: { deviceId: string },
  issuedDensity: number | "default" | undefined,
  options: { invalidate?: (deviceId: string, reason: string) => void },
): void {
  if (issuedDensity !== undefined) {
    (options.invalidate ?? invalidateDisplayCaches)(
      device.deviceId,
      "Display density changed by displayConfig",
    );
  }
}
