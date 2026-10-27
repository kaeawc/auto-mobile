import { expect, test } from "bun:test";
import { prototypeSpecSchema } from "../../../src/features/prototype/prototypeSpec";
import { validatePrototypeSpec } from "../../../src/features/prototype/prototypeValidation";
import { prototypeRequiredCapabilities } from "../../../src/features/prototype/prototypeCapabilityGates";

const spec = (root: unknown) => ({
  id: "polish",
  window: { placement: { type: "fullscreen" } },
  root,
});
const shadow = { color: "#000000", radius: 12 };

test("style polish accepts layers, continuous corners, gradient borders, fades and filters", () => {
  const value = spec({
    type: "scroll",
    fadeEdges: { bottom: 24 },
    child: {
      type: "image",
      asset: "photo",
      filter: { saturation: 0, tint: "primary" },
      style: {
        shadows: [shadow],
        cornerStyle: "continuous",
        cornerRadius: "full",
        border: {
          width: 1,
          gradient: { type: "radial", stops: [{ color: "#000000" }, { color: "#FFFFFF" }] },
        },
      },
    },
  });
  expect(validatePrototypeSpec(value).success).toBe(true);
  expect(prototypeSpecSchema.safeParse(value).success).toBe(true);
  expect(
    prototypeRequiredCapabilities(value).find((g) => g.capability === "prototype_style_polish_v2")
      ?.fields,
  ).toEqual([
    "root.fadeEdges",
    "root.child.style.shadows",
    "root.child.style.cornerStyle",
    "root.child.style.border.gradient",
    "root.child.filter",
  ]);
});

for (const field of ["elevation", "shadowColor"]) {
  test(`shadows exclude ${field}`, () => {
    const value = spec({
      type: "box",
      children: [],
      style: { shadows: [shadow], [field]: field === "elevation" ? 0 : "#000000" },
    });
    expect(validatePrototypeSpec(value)).toEqual({
      success: false,
      error: {
        path: "root.style.shadows",
        message: "shadows cannot be combined with elevation or shadowColor",
      },
    });
    expect(prototypeSpecSchema.safeParse(value).success).toBe(false);
  });
}

test("new colour slots preserve theme mode detection", () => {
  const value = spec({
    type: "image",
    asset: "a",
    filter: { tint: { light: "primary", dark: "scrim" } },
    style: {
      shadows: [{ color: { light: "#FFFFFF", dark: "#000000" }, radius: 0 }],
      border: {
        width: 0,
        gradient: { type: "radial", stops: [{ color: "primary" }, { color: "#000000" }] },
      },
    },
  });
  expect(
    prototypeRequiredCapabilities(value).find((g) => g.capability === "prototype_theme_modes_v1")
      ?.fields,
  ).toEqual([
    "root.filter.tint",
    "root.style.shadows[0].color",
    "root.style.border.gradient.stops[0].color",
  ]);
});

test("gate skips opaque values and reports conditional style slots", () => {
  const value = spec({
    type: "box",
    children: [],
    styleWhen: [{ when: { key: "active", equals: true }, style: { cornerStyle: "continuous" } }],
    onTap: [
      { type: "emit", name: "x", payload: { filter: {}, fadeEdges: {}, style: { shadows: [] } } },
    ],
  });
  expect(
    prototypeRequiredCapabilities(value).find((g) => g.capability === "prototype_style_polish_v2")
      ?.fields,
  ).toEqual(["root.styleWhen[0].style.cornerStyle"]);
});

test("border requires exactly one paint source at border.color", () => {
  for (const border of [
    { width: 1 },
    {
      width: 1,
      color: "primary",
      gradient: { type: "radial", stops: [{ color: "#000000" }, { color: "#FFFFFF" }] },
    },
  ]) {
    const value = spec({ type: "box", children: [], style: { border } });
    expect(validatePrototypeSpec(value)).toEqual({
      success: false,
      error: {
        path: "root.style.border.color",
        message: "Exactly one of color, gradient is required",
      },
    });
    const parsed = prototypeSpecSchema.safeParse(value);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0].path).toEqual(["root", "style", "border", "color"]);
    }
  }
});
