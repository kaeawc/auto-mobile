import { describe, expect, test } from "bun:test";
import {
  contrastRatio,
  prototypeRolePalette,
  type Rgba,
} from "../../../src/features/prototype/prototypeContrast";
import {
  hslColor,
  hueAndSaturation,
  prototypeDrawnPalette,
  prototypeSeedRoles,
} from "../../../src/features/prototype/prototypeSeedScheme";

const rgb = (r: number, g: number, b: number): Rgba => ({ r, g, b, a: 1 });
const BRAND = rgb(0x67, 0x50, 0xa4);

describe("HSL helpers", () => {
  test("hslColor draws the primaries, wraps the hue and rounds to 8-bit channels", () => {
    expect(hslColor(0, 1, 0.5)).toEqual(rgb(255, 0, 0));
    expect(hslColor(120, 1, 0.5)).toEqual(rgb(0, 255, 0));
    expect(hslColor(240, 1, 0.5)).toEqual(rgb(0, 0, 255));
    expect(hslColor(-120, 1, 0.5)).toEqual(hslColor(240, 1, 0.5));
    expect(hslColor(420, 1, 0.5)).toEqual(hslColor(60, 1, 0.5));
    expect(hslColor(200, 0, 0.5)).toEqual(rgb(128, 128, 128));
  });

  test("hueAndSaturation inverts hslColor and reads a grey as hue 0, saturation 0", () => {
    const { hue, saturation } = hueAndSaturation(BRAND);
    expect(hue).toBeCloseTo(256.43, 2);
    expect(saturation).toBeCloseTo(0.344, 3);
    expect(hueAndSaturation(rgb(255, 0, 0))).toEqual({ hue: 0, saturation: 1 });
    expect(hueAndSaturation(rgb(0, 0, 255))).toEqual({ hue: 240, saturation: 1 });
    expect(hueAndSaturation(rgb(90, 90, 90))).toEqual({ hue: 0, saturation: 0 });
  });
});

describe("prototypeSeedRoles (#16611)", () => {
  test("tones follow the Material light and dark assignments for the seed's hue", () => {
    const light = prototypeSeedRoles(BRAND, "light");
    const dark = prototypeSeedRoles(BRAND, "dark");
    // Containers at lightness 0.90 / 0.30, the surface at 0.98 / 0.07, as both devices draw them.
    expect(light.primaryContainer).toEqual(hslColor(256.43, 0.3443, 0.9));
    expect(dark.primaryContainer).toEqual(rgb(65, 50, 103));
    expect(light.surface).toEqual(light.background);
    expect(dark.surface).toEqual(hslColor(256.43, 0.06, 0.07));
    expect(light.surfaceContainer).not.toEqual(dark.surfaceContainer);
  });

  test("accents stay legible on the surface and on-roles pick the more readable tone", () => {
    for (const seed of [BRAND, rgb(0xff, 0xeb, 0x3b), rgb(0x33, 0x66, 0x99)]) {
      for (const mode of ["light", "dark"] as const) {
        const roles = prototypeSeedRoles(seed, mode);
        for (const accent of ["primary", "secondary", "tertiary"]) {
          expect(contrastRatio(roles[accent]!, roles.surface!)).toBeGreaterThanOrEqual(3);
        }
        const onPrimary = roles.onPrimary!;
        expect(onPrimary.r + onPrimary.g + onPrimary.b > 382).toBe(
          contrastRatio(roles.primary!, rgb(255, 255, 255)) >=
            contrastRatio(roles.primary!, rgb(0, 0, 0)),
        );
      }
    }
  });

  test("a grey seed stays grey and a saturated one is clamped", () => {
    const grey = prototypeSeedRoles(rgb(0x80, 0x80, 0x80), "light").primary!;
    expect(grey.r).toBe(grey.g);
    expect(grey.g).toBe(grey.b);
    const vivid = prototypeSeedRoles(rgb(255, 0, 0), "dark").primaryContainer!;
    expect(hueAndSaturation(vivid).saturation).toBeCloseTo(0.85, 1);
  });
});

describe("prototypeDrawnPalette (#16611)", () => {
  const baselineDark = prototypeRolePalette({}, "dark");

  test("with no seed it is the role palette: the baseline under explicit overrides", () => {
    const spec = { theme: { colors: { primary: "#112233" } } };
    expect(prototypeDrawnPalette(spec, "light")).toEqual(prototypeRolePalette(spec, "light"));
    expect(prototypeDrawnPalette({}, "dark")).toEqual(baselineDark);
  });

  test("a device source without a seed falls through to the baseline", () => {
    const spec = { theme: { colors: { source: "device" } } };
    expect(prototypeDrawnPalette(spec, "dark")).toEqual(baselineDark);
  });

  test("a seed derives its roles, keeps the baseline for the rest, and yields to overrides", () => {
    const spec = {
      theme: { colors: { seed: "#6750A4", primary: "#B3261E", dark: { primary: "#F2B8B5" } } },
    };
    const dark = prototypeDrawnPalette(spec, "dark");
    expect(dark.get("primaryContainer")).toEqual(rgb(65, 50, 103));
    expect(dark.get("error")).toEqual(baselineDark.get("error"));
    expect(dark.get("scrim")).toEqual(baselineDark.get("scrim"));
    expect(dark.get("primary")).toEqual(rgb(0xf2, 0xb8, 0xb5));
    expect(prototypeDrawnPalette(spec, "light").get("primary")).toEqual(rgb(0xb3, 0x26, 0x1e));
  });

  test("an unparseable seed is ignored", () => {
    expect(prototypeDrawnPalette({ theme: { colors: { seed: "teal" } } }, "light")).toEqual(
      prototypeRolePalette({}, "light"),
    );
  });
});
