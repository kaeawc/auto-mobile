import { describe, expect, test } from "bun:test";
import {
  WEB_BACKDROP_WALLPAPER,
  webBackdropCss,
  webBackdropPlan,
} from "../../../../src/features/prototype/web/webBackdrop";
import { prototypeRolePalette } from "../../../../src/features/prototype/prototypeContrast";
import type { WebElement } from "../../../../src/features/prototype/web/webNodes";
import { renderPrototypeStill } from "../../../../src/features/prototype/web/webStill";

const withBackdrop = (backdrop: unknown, placement: unknown = { type: "fullscreen" }) => ({
  id: "frosted",
  window: { placement, ...(backdrop === undefined ? {} : { backdrop }) },
  root: { type: "text", text: "Hi" },
});
const style = { mode: "light" as const, palette: prototypeRolePalette({}, "light") };
/** The first element under `node`, depth first, that `match` accepts. */
function first(node: WebElement, match: (element: WebElement) => boolean): WebElement | undefined {
  if (match(node)) {
    return node;
  }
  return node.children
    .filter((child): child is WebElement => typeof child !== "string")
    .map((child) => first(child, match))
    .find((found) => found !== undefined);
}
const windowOf = (element: WebElement) =>
  first(element, (node) => node.attrs["data-window"] !== undefined)!;
const screenOf = (element: WebElement): WebElement =>
  element.children.find(
    (child): child is WebElement =>
      typeof child !== "string" && child.attrs["data-chrome"] === "screen",
  )!;

describe("web backdrop plan (#16536)", () => {
  test("Android blurs at the material's radius or the authored blur; glass falls back", () => {
    expect(webBackdropPlan(withBackdrop({ material: "thin" }), "android")).toEqual({
      mode: "blur",
      radius: 16,
    });
    expect(webBackdropPlan(withBackdrop({ material: "thin", blur: 30 }), "android")).toEqual({
      mode: "blur",
      radius: 30,
    });
    expect(
      webBackdropPlan(withBackdrop({ material: "glass", tint: "#FFFFFF" }), "android"),
    ).toEqual({ mode: "fallback", radius: 0, tint: "#FFFFFF" });
  });

  test("iOS blurs every material, an authored blur snapping to the nearest material", () => {
    expect(webBackdropPlan(withBackdrop({ material: "thick" }), "ios")?.radius).toBe(40);
    expect(webBackdropPlan(withBackdrop({ material: "thin", blur: 30 }), "ios")?.radius).toBe(24);
    expect(webBackdropPlan(withBackdrop({ material: "thin", blur: 35 }), "ios")?.radius).toBe(40);
    expect(webBackdropPlan(withBackdrop({ material: "glass" }), "ios")).toEqual({
      mode: "blur",
      radius: 24,
    });
  });

  test("no backdrop, no plan", () => {
    expect(webBackdropPlan(withBackdrop(undefined), "android")).toBeUndefined();
  });
});

describe("web backdrop css (#16536)", () => {
  test("a blur is Skia's sigma for the radius, under the tint at 0.35", () => {
    expect(webBackdropCss({ mode: "blur", radius: 24, tint: "#FF0000" }, style)).toEqual({
      "backdrop-filter": "blur(14.356px)",
      "background-color": "rgba(255,0,0,0.35)",
    });
    // Untinted, only the blur; a zero radius blurs nothing.
    expect(webBackdropCss({ mode: "blur", radius: 24 }, style)).toEqual({
      "backdrop-filter": "blur(14.356px)",
    });
    expect(webBackdropCss({ mode: "blur", radius: 0 }, style)).toEqual({});
  });

  test("the fallback is the tint, else surfaceContainer, at 0.85", () => {
    expect(webBackdropCss({ mode: "fallback", radius: 0, tint: "#00FF00" }, style)).toEqual({
      "background-color": "rgba(0,255,0,0.85)",
    });
    expect(webBackdropCss({ mode: "fallback", radius: 0 }, style)["background-color"]).toMatch(
      /^rgba\(\d+,\d+,\d+,0\.85\)$/,
    );
  });
});

describe("web backdrop in the still (#16536)", () => {
  test("a fullscreen window frosts itself over the wallpaper the screen paints", () => {
    const { element } = renderPrototypeStill(withBackdrop({ material: "regular" }), {
      frame: "pixel-9",
    });
    expect(windowOf(element).style["backdrop-filter"]).toBe("blur(14.356px)");
    expect(screenOf(element).style["background-image"]).toBe(WEB_BACKDROP_WALLPAPER);
  });

  test("a sheet frosts its own region, not the whole screen", () => {
    const sheet = { type: "sheet", edge: "bottom", height: 320 };
    const { element } = renderPrototypeStill(withBackdrop({ material: "thin" }, sheet), {
      frame: "iphone-16",
    });
    const window = windowOf(element);
    expect(window.attrs["data-window"]).toBe("sheet");
    expect(window.style).not.toHaveProperty("backdrop-filter");
    const region = window.children[0] as WebElement;
    expect(region.style).toMatchObject({ height: "320px", "backdrop-filter": "blur(9.738px)" });
  });

  test("without a backdrop the screen paints only its background", () => {
    const { element } = renderPrototypeStill(withBackdrop(undefined), { frame: "pixel-9" });
    expect(screenOf(element).style).not.toHaveProperty("background-image");
    expect(windowOf(element).style).not.toHaveProperty("backdrop-filter");
  });
});
