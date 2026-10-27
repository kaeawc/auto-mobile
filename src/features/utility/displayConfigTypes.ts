/** Resolved light/dark/system theme; `custom` is an Android user-defined night-mode schedule. */
export type DisplayTheme = "light" | "dark" | "system" | "custom";

/**
 * `"default"` means the Android font-scale setting is absent, which differs
 * from an explicit `1`: restoring it must delete the override rather than
 * silently replacing an inherited/default value with a concrete setting.
 */
export type FontScaleInput = number | "default";

/** The AOSP default text scale — restored on `reset`. */
export const DEFAULT_FONT_SCALE = 1.0;
