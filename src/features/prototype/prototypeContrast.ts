/**
 * Host-side colour resolution for the prototype accessibility lint (#14126): the Material 3
 * baseline scheme the device falls back to, a spec's role overrides, and WCAG contrast.
 */

import type { PROTOTYPE_COLOR_ROLES } from "./prototypePresentationSchemas";
import { record } from "./prototypeTemplate";

export type PrototypeColorMode = "light" | "dark";
type ColorRole = (typeof PROTOTYPE_COLOR_ROLES)[number];

export interface Rgba {
  r: number;
  g: number;
  b: number;
  /** 0..1 */
  a: number;
}

/** The Material 3 baseline both renderers draw with no seed: `PrototypePalette.baselineLight/Dark`
 * in the iOS agent's PrototypeTheme.swift, which matches Compose's default scheme. */
const BASELINE: Record<PrototypeColorMode, Record<ColorRole, number>> = {
  light: {
    primary: 0x6750a4,
    onPrimary: 0xffffff,
    primaryContainer: 0xeaddff,
    onPrimaryContainer: 0x4f378b,
    inversePrimary: 0xd0bcff,
    secondary: 0x625b71,
    onSecondary: 0xffffff,
    secondaryContainer: 0xe8def8,
    onSecondaryContainer: 0x4a4458,
    tertiary: 0x7d5260,
    onTertiary: 0xffffff,
    tertiaryContainer: 0xffd8e4,
    onTertiaryContainer: 0x633b48,
    background: 0xfef7ff,
    onBackground: 0x1d1b20,
    surface: 0xfef7ff,
    onSurface: 0x1d1b20,
    surfaceVariant: 0xe7e0ec,
    onSurfaceVariant: 0x49454f,
    surfaceTint: 0x6750a4,
    inverseSurface: 0x322f35,
    inverseOnSurface: 0xf5eff7,
    error: 0xb3261e,
    onError: 0xffffff,
    errorContainer: 0xf9dedc,
    onErrorContainer: 0x410e0b,
    outline: 0x79747e,
    outlineVariant: 0xcac4d0,
    scrim: 0x000000,
    surfaceBright: 0xfef7ff,
    surfaceDim: 0xded8e1,
    surfaceContainerLowest: 0xffffff,
    surfaceContainerLow: 0xf7f2fa,
    surfaceContainer: 0xf3edf7,
    surfaceContainerHigh: 0xece6f0,
    surfaceContainerHighest: 0xe6e0e9,
  },
  dark: {
    primary: 0xd0bcff,
    onPrimary: 0x381e72,
    primaryContainer: 0x4f378b,
    onPrimaryContainer: 0xeaddff,
    inversePrimary: 0x6750a4,
    secondary: 0xccc2dc,
    onSecondary: 0x332d41,
    secondaryContainer: 0x4a4458,
    onSecondaryContainer: 0xe8def8,
    tertiary: 0xefb8c8,
    onTertiary: 0x492532,
    tertiaryContainer: 0x633b48,
    onTertiaryContainer: 0xffd8e4,
    background: 0x141218,
    onBackground: 0xe6e0e9,
    surface: 0x141218,
    onSurface: 0xe6e0e9,
    surfaceVariant: 0x49454f,
    onSurfaceVariant: 0xcac4d0,
    surfaceTint: 0xd0bcff,
    inverseSurface: 0xe6e0e9,
    inverseOnSurface: 0x322f35,
    error: 0xf2b8b5,
    onError: 0x601410,
    errorContainer: 0x8c1d18,
    onErrorContainer: 0xf9dedc,
    outline: 0x938f99,
    outlineVariant: 0x49454f,
    scrim: 0x000000,
    surfaceBright: 0x3b383e,
    surfaceDim: 0x141218,
    surfaceContainerLowest: 0x0f0d13,
    surfaceContainerLow: 0x1d1b20,
    surfaceContainer: 0x211f26,
    surfaceContainerHigh: 0x2b2930,
    surfaceContainerHighest: 0x36343b,
  },
};

/** `#RRGGBB` or `#AARRGGBB`, the spec's Android-style hex; anything else is undefined. */
export function parsePrototypeHex(value: string): Rgba | undefined {
  const match = /^#([0-9A-Fa-f]{2})?([0-9A-Fa-f]{6})$/.exec(value);
  if (!match) {
    return undefined;
  }
  const rgb = Number.parseInt(match[2]!, 16);
  return {
    r: (rgb >> 16) & 0xff,
    g: (rgb >> 8) & 0xff,
    b: rgb & 0xff,
    a: match[1] === undefined ? 1 : Number.parseInt(match[1], 16) / 255,
  };
}

function fromInt(value: number): Rgba {
  return { r: (value >> 16) & 0xff, g: (value >> 8) & 0xff, b: value & 0xff, a: 1 };
}

/**
 * Role colours a spec resolves to in one mode. A seed or device source makes the device derive its
 * own scheme, which the host does not reproduce, so only explicitly overridden roles are known then.
 */
export function prototypeRolePalette(spec: unknown, mode: PrototypeColorMode): Map<string, Rgba> {
  const colors = record(record(record(spec)?.theme)?.colors);
  const derived = colors?.seed !== undefined || colors?.source !== undefined;
  const palette = new Map<string, Rgba>(
    derived ? [] : Object.entries(BASELINE[mode]).map(([role, value]) => [role, fromInt(value)]),
  );
  // Flat overrides hold in both modes; the mode's own map is painted over them.
  for (const [role, color] of [
    ...roleOverrides(colors),
    ...roleOverrides(record(colors?.[mode])),
  ]) {
    palette.set(role, color);
  }
  return palette;
}

function roleOverrides(colors: Record<string, unknown> | undefined): [string, Rgba][] {
  return Object.entries(colors ?? {}).flatMap(([role, value]) => {
    const color =
      typeof value === "string" && Object.hasOwn(BASELINE.light, role)
        ? parsePrototypeHex(value)
        : undefined;
    return color ? [[role, color] as [string, Rgba]] : [];
  });
}

/** A colour slot (hex, role or `{light, dark}` pair) in one mode, or undefined when unknown. */
export function resolvePrototypeColor(
  value: unknown,
  mode: PrototypeColorMode,
  palette: ReadonlyMap<string, Rgba>,
): Rgba | undefined {
  const token = record(value)?.[mode] ?? value;
  if (typeof token !== "string") {
    return undefined;
  }
  return token.startsWith("#") ? parsePrototypeHex(token) : palette.get(token);
}

/** `over` painted on an opaque `under`. */
export function compositeColor(over: Rgba, under: Rgba): Rgba {
  const mix = (top: number, bottom: number): number => top * over.a + bottom * (1 - over.a);
  return { r: mix(over.r, under.r), g: mix(over.g, under.g), b: mix(over.b, under.b), a: 1 };
}

function channel(value: number): number {
  const srgb = value / 255;
  return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
}

function luminance(color: Rgba): number {
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

/** WCAG 2.x contrast ratio of two opaque colours, 1..21. */
export function contrastRatio(first: Rgba, second: Rgba): number {
  const [light, dark] = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (light! + 0.05) / (dark! + 0.05);
}
