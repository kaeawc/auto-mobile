/**
 * Parsers for `wm size` and `wm density` output, shared by device inventory (#18988) and the
 * displayConfig feature. Pure functions only.
 */

/** A display size in pixels, in the display's natural orientation (as `wm size` reports it). */
export interface DisplaySize {
  width: number;
  height: number;
}

export interface WmSize {
  physical?: DisplaySize;
  override?: DisplaySize;
}

/**
 * Parse `wm size`:
 *
 *   Physical size: 1080x2400
 *   Override size: 720x1600
 *
 * Returns undefined when a line is malformed or no physical size is reported, so a restore
 * payload is never invented from partial output.
 */
export function parseWmSize(raw: string): WmSize | undefined {
  const sizes: WmSize = {};
  for (const match of raw.matchAll(/^[ \t]*(Physical|Override) size:[ \t]*([^\r\n]*)/gim)) {
    const size = /^(\d+)x(\d+)$/.exec(match[2].trim());
    const key = match[1].toLowerCase() as keyof WmSize;
    if (!size || sizes[key] !== undefined) {
      return undefined;
    }
    sizes[key] = { width: Number(size[1]), height: Number(size[2]) };
  }
  return sizes.physical === undefined ? undefined : sizes;
}

/**
 * Parse `wm density` free text, preferring the override density when one is set:
 *
 *   Physical density: 440
 *   Override density: 480
 *
 * `effective` is `undefined` when neither line is present/parseable. `overridden`
 * distinguishes "no override present" (effective falls back to physical) from an
 * actual override, so a caller can tell whether the effective number represents a
 * forced state or the device's unmodified default (issue #6096 review).
 */
export function parseWmDensity(raw: string): {
  physical?: number;
  effective?: number;
  overridden: boolean;
} {
  const densities = new Map<string, number>();
  for (const match of raw.matchAll(/^[ \t]*(Physical|Override) density:[ \t]*([^\r\n]*)/gim)) {
    const kind = match[1].toLowerCase();
    const value = match[2].trim();
    const parsed = Number(value);
    // A malformed override must not fall back to physical density and invent
    // an absent override in the restoration payload (#6333).
    if (
      !/^\d+$/.test(value) ||
      !Number.isSafeInteger(parsed) ||
      parsed <= 0 ||
      densities.has(kind)
    ) {
      return { effective: undefined, overridden: false };
    }
    densities.set(kind, parsed);
  }
  const physical = densities.get("physical");
  const override = densities.get("override");
  const overridden = override !== undefined && Number.isFinite(override);
  return {
    ...(physical !== undefined && Number.isFinite(physical) ? { physical } : {}),
    effective: overridden
      ? override
      : physical !== undefined && Number.isFinite(physical)
        ? physical
        : undefined,
    overridden,
  };
}
