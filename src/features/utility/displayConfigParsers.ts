/**
 * Parsers for the Android display settings displayConfig reads (#6096), and the
 * `cmd uimode night` argument for a theme.
 */
import { DEFAULT_FONT_SCALE, type DisplayTheme, type FontScaleInput } from "./displayConfigTypes";

export { parseWmDensity } from "../../utils/android-cmdline-tools/wmDisplayParsers";

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

/**
 * Android before 8 registers the `uimode` service but has no shell command for it, so
 * `cmd uimode night` exits 0 with "No shell command implementation." (issue #18984).
 * API 24 writes it to stderr with empty stdout; API 25 writes it to stdout. Only this
 * exact message counts, so unrelated stderr never marks night mode unsupported.
 */
export function isNightModeUnsupported(stdout: string, stderr: string = ""): boolean {
  return [stdout, stderr].some((stream) => /no shell command implementation/i.test(stream));
}

export const ANDROID_THEME_UNSUPPORTED_ERROR =
  "theme is not supported on this device: Android before 8 (API 26) has no `cmd uimode night`. " +
  "fontScale and density still work.";

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
