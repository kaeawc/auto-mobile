/**
 * Parsers for the Android display settings displayConfig reads (#6096), and the
 * `cmd uimode night` argument for a theme.
 */
import { DEFAULT_FONT_SCALE, type DisplayTheme, type FontScaleInput } from "./displayConfigTypes";

/**
 * Parse `settings get system font_scale`. An unset value ("null") means the
 * device is at the AOSP default of 1.0; a malformed value yields `undefined` so
 * the caller does not fabricate a scale it could not read.
 */
export function parseFontScale(raw: string): number | undefined {
  const value = raw.trim();
  if (value === "null") {
    return DEFAULT_FONT_SCALE;
  }
  if (!/^[+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Preserve the difference between an absent Android setting and an explicit
 * `1.0` value for restore payloads. `parseFontScale` remains the value parser
 * for callers that only need the effective scale.
 */
export function parseFontScaleSnapshot(raw: string): FontScaleInput | undefined {
  const value = raw.trim();
  return value === "null" ? "default" : parseFontScale(value);
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

/**
 * Parse `cmd uimode night` output ("Night mode: yes|no|auto|custom"). `yes` is
 * dark, `no` is light, `auto` follows the system (mapped to the tool's
 * `system`). `custom` (a user-defined schedule / bedtime mode) is kept as its
 * OWN distinct value rather than collapsed into `system`: collapsing it would
 * make a later restore of `previous.theme` write `cmd uimode night auto`,
 * silently destroying the user's custom schedule instead of restoring it
 * (issue #6096 review).
 */
export function parseNightMode(raw: string): DisplayTheme | undefined {
  const match = raw.match(/Night mode:\s*(\w+)/i);
  const value = (match?.[1] ?? raw.trim()).toLowerCase();
  switch (value) {
    case "yes":
      return "dark";
    case "no":
      return "light";
    case "auto":
      return "system";
    case "custom":
      return "custom";
    default:
      return undefined;
  }
}

/** Map the tool's theme enum to the `cmd uimode night` argument. */
export function nightModeArg(theme: DisplayTheme): string {
  switch (theme) {
    case "dark":
      return "yes";
    case "light":
      return "no";
    case "system":
      return "auto";
    // Restores the device's custom night-mode schedule rather than clobbering it
    // with `auto`; `cmd uimode night custom` re-selects the custom schedule mode.
    case "custom":
      return "custom";
  }
}
