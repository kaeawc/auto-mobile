import {
  contrastRatio,
  parsePrototypeHex,
  prototypeRoleOverrides,
  prototypeRolePalette,
  type PrototypeColorMode,
  type Rgba,
} from "./prototypeContrast";
import { record } from "./prototypeTemplate";

/**
 * The role colours `theme.colors.seed` derives, as both devices compute them: Android's
 * `prototypeSeedColorScheme` and the iOS agent's `PrototypePalette.seedScheme` share this HSL
 * approximation of Material tonal palettes (no HCT). Primary keeps the seed's hue and clamped
 * saturation, secondary is a muted version, tertiary is rotated 60 degrees, and neutrals carry a
 * trace of the hue. Roles it does not name (error, scrim, inverse, surfaceDim...) keep the mode's
 * baseline. Each colour is rounded to 8-bit channels as Compose's sRGB `Color` stores it, before
 * any contrast comparison reads it.
 */

const DEGREES = 360;
const TERTIARY_HUE_ROTATION = 60;
const NEUTRAL_SATURATION = 0.06;
const SEED_MIN_SATURATION = 0.25;
const SEED_MAX_SATURATION = 0.85;
const MIN_ACCENT_CONTRAST = 3;
const ACCENT_STEP = 0.02;
const ACCENT_MIN_LIGHTNESS = 0.05;
const ACCENT_MAX_LIGHTNESS = 0.95;

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));
const toByte = (value: number): number => Math.trunc(clamp01(value) * 255 + 0.5);

/** HSL to an 8-bit colour; hue in degrees (wrapped), saturation and lightness 0..1. */
export function hslColor(hue: number, saturation: number, lightness: number): Rgba {
  const h = (((hue % DEGREES) + DEGREES) % DEGREES) / 60;
  const s = clamp01(saturation);
  const chroma = (1 - Math.abs(2 * lightness - 1)) * s;
  const x = chroma * (1 - Math.abs((h % 2) - 1));
  const m = lightness - chroma / 2;
  const sector = Math.floor(h) % 6;
  const [r, g, b] = (
    [
      [chroma, x, 0],
      [x, chroma, 0],
      [0, chroma, x],
      [0, x, chroma],
      [x, 0, chroma],
      [chroma, 0, x],
    ] as const
  )[sector]!;
  return { r: toByte(r + m), g: toByte(g + m), b: toByte(b + m), a: 1 };
}

/** Hue in degrees [0, 360) and HSL saturation [0, 1]. */
export function hueAndSaturation(color: Rgba): { hue: number; saturation: number } {
  const [r, g, b] = [color.r / 255, color.g / 255, color.b / 255];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  if (delta === 0) {
    return { hue: 0, saturation: 0 };
  }
  const saturation = delta / (1 - Math.abs(max + min - 1));
  const mod6 = (value: number): number => ((value % 6) + 6) % 6;
  const sector =
    max === r ? mod6((g - b) / delta) : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  return { hue: sector * 60, saturation };
}

/** The roles a seed colour derives for one mode. */
export function prototypeSeedRoles(seed: Rgba, mode: PrototypeColorMode): Record<string, Rgba> {
  const dark = mode === "dark";
  const { hue, saturation } = hueAndSaturation(seed);
  // A grey seed stays grey; only a coloured one is clamped into a usable range.
  const chroma =
    saturation === 0 ? 0 : Math.min(SEED_MAX_SATURATION, Math.max(SEED_MIN_SATURATION, saturation));
  const tone = (h: number, s: number, light: number, darkTone: number): Rgba =>
    hslColor(h, s, dark ? darkTone : light);
  const neutral = NEUTRAL_SATURATION;
  const surface = tone(hue, neutral, 0.98, 0.07);

  // HSL lightness is not perceptual: walk the accent away from the surface until it is legible.
  const accent = (h: number, s: number): Rgba => {
    const step = dark ? ACCENT_STEP : -ACCENT_STEP;
    let lightness = dark ? 0.8 : 0.4;
    let color = hslColor(h, s, lightness);
    while (
      contrastRatio(color, surface) < MIN_ACCENT_CONTRAST &&
      lightness + step >= ACCENT_MIN_LIGHTNESS &&
      lightness + step <= ACCENT_MAX_LIGHTNESS
    ) {
      lightness += step;
      color = hslColor(h, s, lightness);
    }
    return color;
  };
  // The content colour for a role is whichever of a light or dark tone reads better on it.
  const onRole = (role: Rgba, h: number, s: number): Rgba => {
    const light = hslColor(h, s, 0.98);
    const darkOn = hslColor(h, s, 0.04);
    return contrastRatio(role, light) >= contrastRatio(role, darkOn) ? light : darkOn;
  };

  const secondaryChroma = chroma * 0.35;
  const tertiaryHue = hue + TERTIARY_HUE_ROTATION;
  const tertiaryChroma = chroma * 0.6;
  const primary = accent(hue, chroma);
  const secondary = accent(hue, secondaryChroma);
  const tertiary = accent(tertiaryHue, tertiaryChroma);
  const primaryContainer = tone(hue, chroma, 0.9, 0.3);
  const secondaryContainer = tone(hue, secondaryChroma, 0.9, 0.3);
  const tertiaryContainer = tone(tertiaryHue, tertiaryChroma, 0.9, 0.3);
  const onSurface = tone(hue, neutral, 0.1, 0.9);
  return {
    primary,
    onPrimary: onRole(primary, hue, chroma),
    primaryContainer,
    onPrimaryContainer: onRole(primaryContainer, hue, chroma),
    secondary,
    onSecondary: onRole(secondary, hue, secondaryChroma),
    secondaryContainer,
    onSecondaryContainer: onRole(secondaryContainer, hue, secondaryChroma),
    tertiary,
    onTertiary: onRole(tertiary, tertiaryHue, tertiaryChroma),
    tertiaryContainer,
    onTertiaryContainer: onRole(tertiaryContainer, tertiaryHue, tertiaryChroma),
    background: surface,
    onBackground: onSurface,
    surface,
    onSurface,
    surfaceVariant: tone(hue, neutral * 2, 0.9, 0.25),
    onSurfaceVariant: tone(hue, neutral * 2, 0.3, 0.8),
    surfaceContainerLowest: tone(hue, neutral, 1, 0.04),
    surfaceContainerLow: tone(hue, neutral, 0.96, 0.1),
    surfaceContainer: tone(hue, neutral, 0.94, 0.12),
    surfaceContainerHigh: tone(hue, neutral, 0.92, 0.17),
    surfaceContainerHighest: tone(hue, neutral, 0.9, 0.22),
    outline: tone(hue, neutral * 2, 0.46, 0.6),
    outlineVariant: tone(hue, neutral * 2, 0.8, 0.3),
  };
}

/**
 * The role colours a device draws a spec with, for a renderer that has no device scheme of its
 * own (the web still): the mode's baseline, the seed's derived roles over it, then the explicit
 * overrides. `source: device` has no device to read here, so it falls through to the seed or the
 * baseline, as iOS and Android below API 31 do.
 */
export function prototypeDrawnPalette(spec: unknown, mode: PrototypeColorMode): Map<string, Rgba> {
  const palette = prototypeRolePalette({}, mode);
  const seedHex = record(record(record(spec)?.theme)?.colors)?.seed;
  const seed = typeof seedHex === "string" ? parsePrototypeHex(seedHex) : undefined;
  if (seed) {
    for (const [role, color] of Object.entries(prototypeSeedRoles(seed, mode))) {
      palette.set(role, color);
    }
  }
  for (const [role, color] of prototypeRoleOverrides(spec, mode)) {
    palette.set(role, color);
  }
  return palette;
}
