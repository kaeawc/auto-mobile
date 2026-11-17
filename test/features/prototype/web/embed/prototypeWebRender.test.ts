import { describe, expect, test } from "bun:test";
import { renderPrototype } from "../../../../../src/features/prototype/web/embed/prototypeWebRender";
import { PrototypeWebRefusal } from "../../../../../src/features/prototype/web/embed/prototypeWebInput";
import {
  el,
  toHtml,
  type WebChild,
  type WebElement,
} from "../../../../../src/features/prototype/web/webNodes";
import { renderPrototypeStill } from "../../../../../src/features/prototype/web/webStill";
import rawRegistry from "../../../../../src/features/prototype/web/deviceFrames.json";
import type { PrototypeWebFrame } from "../../../../../src/features/prototype/web/embed/prototypeWebRender";

/** A frame option as a page would pass it: JSON the type system cannot vouch for. */
const frameOption = (value: unknown) => value as PrototypeWebFrame;
const pixelEntry = frameOption(rawRegistry.frames[0]);

const twoScreens = {
  id: "two",
  window: { placement: { type: "fullscreen" } },
  root: {
    type: "stack",
    id: "nav",
    start: "home",
    screens: {
      detail: { type: "text", text: "Detail" },
      home: { type: "text", text: "Home" },
    },
  },
};
const withIcon = { id: "icon", root: { type: "icon", name: "home" } };

const findAll = (node: WebChild, match: (element: WebElement) => boolean): WebElement[] =>
  typeof node === "string"
    ? []
    : [...(match(node) ? [node] : []), ...node.children.flatMap((child) => findAll(child, match))];

function refusalCode(draw: () => unknown): string {
  try {
    draw();
  } catch (error) {
    if (error instanceof PrototypeWebRefusal) {
      return error.error.code;
    }
    throw error;
  }
  return "drawn";
}

describe("renderPrototype (#16453)", () => {
  test("draws what the still renderer draws, in the default frame", () => {
    const rendered = renderPrototype(twoScreens, { mode: "light" });
    const still = renderPrototypeStill(twoScreens, {
      frame: "pixel-9",
      orientation: "portrait",
      mode: "light",
    });
    expect(toHtml(rendered.element)).toBe(toHtml(still.element));
    expect(rendered).toMatchObject({
      frame: "pixel-9",
      orientation: "portrait",
      orientations: ["portrait", "landscape"],
      stack: { start: "home", screens: ["home", "detail"], screen: "home" },
    });
  });

  test("draws the chosen screen, and the start for one that is gone", () => {
    expect(renderPrototype(twoScreens, { screen: "detail" }).stack?.screen).toBe("detail");
    expect(renderPrototype(twoScreens, { screen: "gone" }).stack?.screen).toBe("home");
  });

  test("frame false draws the default frame's screen alone", () => {
    const rendered = renderPrototype(twoScreens, { frame: false });
    const still = renderPrototypeStill(twoScreens, {
      frame: "pixel-9",
      orientation: "portrait",
      chromeless: true,
    });
    expect(rendered.frame).toBe(false);
    expect(toHtml(rendered.element)).toBe(toHtml(still.element));
  });

  test("refuses an unknown frame, orientation or envelope version", () => {
    expect(refusalCode(() => renderPrototype(twoScreens, { frame: "nope" }))).toBe("invalidOption");
    expect(
      refusalCode(() =>
        renderPrototype(twoScreens, { frame: "android-tv-1080p", orientation: "portrait" }),
      ),
    ).toBe("invalidOption");
    expect(
      refusalCode(() =>
        renderPrototype({
          format: "automobile-prototype-embed",
          version: 9,
          requires: [],
          spec: twoScreens,
        }),
      ),
    ).toBe("unknownVersion");
  });

  test("draws a frame object as the registry frame it copies", () => {
    const rendered = renderPrototype(twoScreens, {
      frame: structuredClone(pixelEntry),
      mode: "light",
    });
    const still = renderPrototypeStill(twoScreens, { frame: "pixel-9", mode: "light" });
    expect(rendered.orientations).toEqual(["portrait", "landscape"]);
    expect(toHtml(rendered.element)).toBe(toHtml(still.element));
  });

  test("names a frame object by its own id and label", () => {
    const custom = { ...pixelEntry, id: "my-phone", label: "My phone" };
    const rendered = renderPrototype(twoScreens, { frame: custom });
    expect(rendered.frame).toBe("my-phone");
    expect(rendered.element.attrs["aria-label"]).toBe("My phone (portrait)");
  });

  test("draws a narrower frame object at its own width", () => {
    const narrow = {
      ...pixelEntry,
      id: "narrow",
      screen: { ...pixelEntry.screen, widthDp: 360 },
      cutout: { type: "none" as const },
    };
    const rendered = renderPrototype(twoScreens, { frame: narrow });
    expect(toHtml(rendered.element)).toContain("360px");
  });

  test("refuses an invalid frame object with its path", () => {
    const invalid = frameOption({ ...pixelEntry, mask: "oval" });
    expect(refusalCode(() => renderPrototype(twoScreens, { frame: invalid }))).toBe(
      "invalidOption",
    );
    expect(() => renderPrototype(twoScreens, { frame: invalid })).toThrow("frame.mask");
  });

  test("draws an envelope's glyph through the given parser", () => {
    const parsed: string[] = [];
    const rendered = renderPrototype(
      {
        format: "automobile-prototype-embed",
        version: 1,
        requires: [],
        spec: withIcon,
        glyphs: { "filled/home": "<path/>" },
      },
      {
        parseGlyph: (markup) => {
          parsed.push(markup);
          return [el("path", { attrs: { d: "M0 0h24v24H0z" } })];
        },
      },
    );
    expect(parsed).toEqual(["<path/>"]);
    expect(findAll(rendered.element, (node) => node.attrs.d === "M0 0h24v24H0z")).toHaveLength(1);
    expect(rendered.unsupportedNodes).toEqual([]);
  });
});
