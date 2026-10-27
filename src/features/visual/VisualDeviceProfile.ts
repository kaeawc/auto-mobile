import type { Platform } from "../../models/Platform";

/**
 * The display configuration a screenshot baseline is only valid for (#14083): a baseline recorded
 * at one size, density, font scale or theme is never compared against another.
 */
export interface VisualDeviceProfile {
  platform: Platform;
  /** Full-screen screenshot pixels, in display orientation. */
  width: number;
  height: number;
  /** Android effective DPI, or the iOS native scale; null when the device reported neither. */
  density: number | null;
  fontScale: number | null;
  /** The resolved display theme (`light`, `dark`), or null when the device has no reading. */
  theme: string | null;
}

function part(value: number | string | null): string {
  return value === null ? "na" : String(value).replace(/[^A-Za-z0-9.]/g, "_");
}

/** A stable, filesystem-safe key for one profile. */
export function visualProfileKey(profile: VisualDeviceProfile): string {
  return [
    profile.platform,
    `${profile.width}x${profile.height}`,
    `d${part(profile.density)}`,
    `f${part(profile.fontScale)}`,
    part(profile.theme),
  ].join("-");
}

/** The fields two profiles disagree on, for the mismatch error. */
export function profileDifferences(
  expected: VisualDeviceProfile,
  actual: VisualDeviceProfile,
): string[] {
  const fields: Array<keyof VisualDeviceProfile> = [
    "platform",
    "width",
    "height",
    "density",
    "fontScale",
    "theme",
  ];
  return fields
    .filter((field) => expected[field] !== actual[field])
    .map((field) => `${field}: baseline ${expected[field]} vs device ${actual[field]}`);
}
