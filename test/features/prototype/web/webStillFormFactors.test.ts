import { describe, expect, test } from "bun:test";
import type { WebChild, WebElement } from "../../../../src/features/prototype/web/webNodes";
import { renderPrototypeStill } from "../../../../src/features/prototype/web/webStill";

const spec = {
  id: "focus",
  window: { placement: { type: "fullscreen" } },
  root: {
    type: "column",
    children: [
      { type: "text", text: "Watch next" },
      { type: "button", label: "Play" },
      { type: "button", label: "Later" },
    ],
  },
};

const find = (root: WebChild, match: (element: WebElement) => boolean): WebElement[] =>
  typeof root === "string"
    ? []
    : [...(match(root) ? [root] : []), ...root.children.flatMap((child) => find(child, match))];
const ringed = (root: WebElement) =>
  find(root, (element) => element.attrs["data-focus"] === "ring");
const screen = (root: WebElement) =>
  find(root, (element) => element.attrs["data-chrome"] === "screen")[0]!;

describe("still on watch, TV and car frames (#16446)", () => {
  test("a TV still opens in landscape with focus on its first focusable node", () => {
    for (const frame of ["android-tv-1080p", "apple-tv"]) {
      const { element } = renderPrototypeStill(spec, { frame });
      expect(element.attrs["data-orientation"]).toBe("landscape");
      const width = parseFloat(screen(element).style.width!);
      expect(width).toBeGreaterThan(parseFloat(screen(element).style.height!));
      expect(ringed(element).map((node) => node.children)).toEqual([["Play"]]);
    }
  });

  test("tabBar and bottomNav items take initial focus from the real renderer output", () => {
    for (const type of ["tabBar", "bottomNav"]) {
      const nav = {
        id: "nav",
        window: { placement: { type: "fullscreen" } },
        root: {
          type: "column",
          children: [
            { type: "text", text: "Home" },
            { type: type, items: [{ label: "Movies" }, { label: "Shows" }] },
            { type: "button", label: "Play" },
          ],
        },
      };
      const { element } = renderPrototypeStill(nav, { frame: "android-tv-1080p" });
      const rings = ringed(element);
      expect(rings.map((node) => node.attrs.role)).toEqual(["tab"]);
      expect(JSON.stringify(rings[0])).toContain("Movies");
    }
  });

  test("touch and rotary frames draw no focus ring", () => {
    for (const frame of ["pixel-9", "iphone-16", "wearos-small-round", "car-1024p-landscape"]) {
      expect(ringed(renderPrototypeStill(spec, { frame }).element)).toEqual([]);
    }
  });

  test("a car still is landscape and never hides content", () => {
    const { element } = renderPrototypeStill(spec, { frame: "car-1024p-landscape" });
    expect(element.attrs["data-orientation"]).toBe("landscape");
    const buttons = find(element, (node) => node.attrs["data-node"] === "button");
    expect(buttons.map((node) => node.children)).toEqual([["Play"], ["Later"]]);
    expect(buttons.every((node) => node.style.display !== "none")).toBe(true);
  });

  test("a watch still is portrait and round", () => {
    const { element } = renderPrototypeStill(spec, { frame: "wearos-small-round" });
    expect(element.attrs).toMatchObject({ "data-orientation": "portrait", "data-mask": "round" });
  });

  test("an orientation the frame does not have is an actionable error", () => {
    expect(() =>
      renderPrototypeStill(spec, { frame: "android-tv-1080p", orientation: "portrait" }),
    ).toThrow('Device frame "android-tv-1080p" has no portrait view. Its orientations: landscape');
    expect(() =>
      renderPrototypeStill(spec, { frame: "apple-watch", orientation: "landscape" }),
    ).toThrow("Its orientations: portrait");
  });
});
