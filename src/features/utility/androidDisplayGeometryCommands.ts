/**
 * Parsers and command builders for the Android display geometry that `displayConfig` changes at
 * runtime (#14101): the `wm size` override, the navigation-bar mode overlays and the display-cutout
 * emulation overlays. Pure functions only, so the device-facing classes and the session-release
 * restore share one definition of every command and value mapping.
 */

/** A display size in pixels, in the display's natural orientation (as `wm size` reports it). */
export interface DisplaySize {
  width: number;
  height: number;
}

/** A size override, or `"default"` for no override (the physical size). */
export type DisplaySizeInput = DisplaySize | "default";

export const NAVIGATION_MODES = ["gesture", "threeButton", "twoButton"] as const;
export type NavigationMode = (typeof NAVIGATION_MODES)[number];
/** `"default"`: no navigation-bar overlay enabled, so the system image's built-in mode applies. */
export type NavigationModeInput = NavigationMode | "default";

export const DISPLAY_CUTOUTS = ["corner", "double", "hole", "tall", "waterfall"] as const;
export type DisplayCutoutKind = (typeof DISPLAY_CUTOUTS)[number];
/** `"none"`: no cutout-emulation overlay enabled. */
export type DisplayCutoutInput = DisplayCutoutKind | "none";

/**
 * `WindowManagerService.setForcedDisplaySize` clamps each side to at least 200 px and at most
 * twice the initial (physical) size, so a request outside that range would silently land on a
 * different size. Source: frameworks/base/services/core/java/com/android/server/wm/
 * WindowManagerService.java (MIN_WIDTH, MIN_HEIGHT, MAX_SCALE).
 */
export const MIN_ANDROID_DISPLAY_SIDE_PX = 200;
export const MAX_ANDROID_DISPLAY_SCALE = 2;
/** Static schema ceiling; the runtime check against the physical size is the real bound. */
export const MAX_ANDROID_DISPLAY_SIDE_PX = 16384;

/** The overlay groups displayConfig drives, keyed by the displayConfig field that selects them. */
export type OverlayGroup = "navigationMode" | "displayCutout";

const NAVBAR_PREFIX = "com.android.internal.systemui.navbar.";
const CUTOUT_PREFIX = "com.android.internal.display.cutout.emulation.";

const GROUP_PREFIXES: Record<OverlayGroup, string> = {
  navigationMode: NAVBAR_PREFIX,
  displayCutout: CUTOUT_PREFIX,
};

const NAVIGATION_MODE_PACKAGES: Record<NavigationMode, string> = {
  gesture: `${NAVBAR_PREFIX}gestural`,
  threeButton: `${NAVBAR_PREFIX}threebutton`,
  twoButton: `${NAVBAR_PREFIX}twobutton`,
};

/** An overlay `cmd overlay list` shows; `---` (cannot be enabled) entries are not listed. */
export interface OverlayEntry {
  packageName: string;
  enabled: boolean;
}

/** The overlays of one group, in list order. */
export function groupOverlays(
  entries: readonly OverlayEntry[],
  group: OverlayGroup,
): OverlayEntry[] {
  return entries.filter((entry) => entry.packageName.startsWith(GROUP_PREFIXES[group]));
}

/** The enabled overlay packages of one group. */
export function enabledOverlays(entries: readonly OverlayEntry[], group: OverlayGroup): string[] {
  return groupOverlays(entries, group)
    .filter((entry) => entry.enabled)
    .map((entry) => entry.packageName);
}

/** The overlay package a requested value enables, or `[]` for the no-overlay value. */
export function overlayTargetFor(
  group: OverlayGroup,
  value: NavigationModeInput | DisplayCutoutInput,
): string[] {
  if (value === "default" || value === "none") {
    return [];
  }
  return group === "navigationMode"
    ? [NAVIGATION_MODE_PACKAGES[value as NavigationMode]]
    : [`${CUTOUT_PREFIX}${value}`];
}

/** Map a group's enabled overlays to its displayConfig value; undefined when not one known value. */
export function overlayValue(
  group: OverlayGroup,
  enabled: readonly string[],
): NavigationModeInput | DisplayCutoutInput | undefined {
  if (enabled.length === 0) {
    return group === "navigationMode" ? "default" : "none";
  }
  if (enabled.length > 1) {
    return undefined;
  }
  const name = enabled[0].slice(GROUP_PREFIXES[group].length);
  if (group === "displayCutout") {
    return (DISPLAY_CUTOUTS as readonly string[]).includes(name)
      ? (name as DisplayCutoutKind)
      : undefined;
  }
  // The gestural back-sensitivity variants (gestural_wide_back, ...) are still gesture navigation.
  if (name === "gestural" || name.startsWith("gestural_")) {
    return "gesture";
  }
  return name === "threebutton" ? "threeButton" : name === "twobutton" ? "twoButton" : undefined;
}

/** The group values this system image can select: its shipped, enable-able overlays. */
export function availableOverlayValues(
  entries: readonly OverlayEntry[],
  group: OverlayGroup,
): string[] {
  const installed = new Set(groupOverlays(entries, group).map((entry) => entry.packageName));
  const values: readonly (NavigationModeInput | DisplayCutoutInput)[] =
    group === "navigationMode" ? NAVIGATION_MODES : DISPLAY_CUTOUTS;
  const shipped = values.filter((value) => installed.has(overlayTargetFor(group, value)[0]));
  return [group === "navigationMode" ? "default" : "none", ...shipped];
}

/**
 * The `cmd overlay` commands that move a group from `current` to exactly `target` enabled
 * packages. `enable-exclusive --category` switches atomically within the overlay category; any
 * other previously enabled package of the group is disabled explicitly so the end state is exact
 * even when an image files the group under several categories.
 */
export function overlayCommands(current: readonly string[], target: readonly string[]): string[] {
  const sameSet = current.length === target.length && target.every((pkg) => current.includes(pkg));
  if (sameSet) {
    return [];
  }
  const [first, ...rest] = target;
  return [
    ...(first === undefined ? [] : [`shell cmd overlay enable-exclusive --category ${first}`]),
    ...rest.map((pkg) => `shell cmd overlay enable ${pkg}`),
    ...current
      .filter((pkg) => !target.includes(pkg))
      .map((pkg) => `shell cmd overlay disable ${pkg}`),
  ];
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

/** `-d <id>` only for a non-default display, so the default-display wire stays unchanged. */
function displayFlag(displayId: number | undefined): string {
  return displayId === undefined || displayId === 0 ? "" : ` -d ${displayId}`;
}

export function wmSizeReadCommand(displayId: number | undefined): string {
  return `shell wm size${displayFlag(displayId)}`;
}

export function wmSizeWriteCommand(
  target: DisplaySizeInput,
  displayId: number | undefined,
): string {
  const value = target === "default" ? "reset" : `${target.width}x${target.height}`;
  return `shell wm size ${value}${displayFlag(displayId)}`;
}

/** The override in its restorable form: the size, or `"default"` with no override. */
export function restorableSize(size: WmSize): DisplaySizeInput {
  return size.override ?? "default";
}

/** The size the display currently renders at. */
export function effectiveSize(size: WmSize): DisplaySize | undefined {
  return size.override ?? size.physical;
}

export function sameSize(
  a: DisplaySizeInput | undefined,
  b: DisplaySizeInput | undefined,
): boolean {
  if (a === undefined || b === undefined || a === "default" || b === "default") {
    return a === b;
  }
  return a.width === b.width && a.height === b.height;
}

export function formatSize(size: DisplaySizeInput | undefined): string {
  return size === undefined || size === "default" ? String(size) : `${size.width}x${size.height}`;
}
