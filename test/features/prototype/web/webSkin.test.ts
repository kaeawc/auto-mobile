import { describe, expect, test } from "bun:test";
import type { WebChild, WebElement } from "../../../../src/features/prototype/web/webNodes";
import {
  renderPrototypeStill,
  type PrototypeStillOptions,
} from "../../../../src/features/prototype/web/webStill";

function find(node: WebChild, predicate: (element: WebElement) => boolean): WebElement[] {
  if (typeof node === "string") {
    return [];
  }
  return [
    ...(predicate(node) ? [node] : []),
    ...node.children.flatMap((child) => find(child, predicate)),
  ];
}

const textOf = (node: WebChild): string =>
  typeof node === "string" ? node : node.children.map(textOf).join("");

/** The element tagged `tag` in a still of a column holding `nodes`. */
function rendered(
  nodes: readonly Record<string, unknown>[],
  options: PrototypeStillOptions,
  tag: string,
  state: Record<string, unknown> = {},
): WebElement {
  const spec = {
    id: "skin",
    theme: { colors: { primary: "#336699" } },
    state,
    root: { type: "column", children: nodes },
  };
  const element = renderPrototypeStill(spec, options).element;
  return find(element, (candidate) => candidate.attrs["data-testid"] === tag)[0]!;
}

const button = (extra: Record<string, unknown> = {}) => ({
  type: "button",
  label: "Save",
  testTag: "b",
  ...extra,
});

const slider = (extra: Record<string, unknown> = {}) => ({
  type: "slider",
  label: "Volume",
  stateKey: "v",
  min: 0,
  max: 10,
  testTag: "s",
  ...extra,
});

const part = (element: WebElement, name: string) =>
  find(element, (candidate) => candidate.attrs["data-part"] === name)[0]!;

describe("platform skins (#16531)", () => {
  test("the frame's platform picks the skin, and an explicit skin wins", () => {
    const android = rendered([button()], { frame: "pixel-9" }, "b");
    const ios = rendered([button()], { frame: "iphone-16" }, "b");
    expect(android.style["border-radius"]).toBe("20px");
    expect(ios.style["border-radius"]).toBe("6px");
    expect(rendered([button()], { frame: "pixel-9", skin: "ios" }, "b")).toEqual(ios);
    expect(rendered([button()], { frame: "iphone-16", skin: "android" }, "b")).toEqual(android);
  });

  test("the iOS skin draws a filled button as .borderedProminent in the body style", () => {
    const ios = rendered([button({ icon: "check" })], { skin: "ios" }, "b");
    expect(ios.style).toMatchObject({
      "background-color": "rgba(51,102,153,1)",
      color: "#ffffff",
      "font-size": "17px",
      "min-height": "34px",
      padding: "7px 12px",
      gap: "6px",
    });
    expect(textOf(ios)).toEndWith("Save");
    expect(ios.attrs.role).toBe("button");
  });

  test("each iOS button variant takes its SwiftUI style", () => {
    const styleOf = (variant: string) =>
      rendered([button({ variant })], { skin: "ios" }, "b").style;
    expect(styleOf("tonal")["background-color"]).toBe("rgba(51,102,153,0.15)");
    expect(styleOf("tonal").color).toBe("rgba(51,102,153,1)");
    expect(styleOf("elevated")["box-shadow"]).toBe("0 1px 2px rgba(0,0,0,0.2)");
    expect(styleOf("outlined")).toMatchObject({
      border: "1px solid rgba(51,102,153,1)",
      "border-radius": "9999px",
      padding: "8px 16px",
    });
    expect(styleOf("outlined")["background-color"]).toBeUndefined();
    expect(styleOf("text").padding).toBeUndefined();
    expect(styleOf("text")["background-color"]).toBeUndefined();
  });

  test("ios.buttonStyle applies only in the iOS skin", () => {
    const glass = button({ ios: { buttonStyle: "glassProminent" } });
    expect(rendered([glass], { skin: "ios" }, "b").style["border-radius"]).toBe("9999px");
    expect(rendered([glass], { skin: "android" }, "b")).toEqual(
      rendered([button()], { skin: "android" }, "b"),
    );
  });

  test("the android namespace never changes the iOS skin", () => {
    const tagged = button({ android: { indication: "none" } });
    expect(rendered([tagged], { skin: "ios" }, "b")).toEqual(
      rendered([button()], { skin: "ios" }, "b"),
    );
  });

  test("the spec's own style still wins over the iOS defaults", () => {
    const styled = button({ style: { background: "#ff0000" } });
    expect(rendered([styled], { skin: "ios" }, "b").style["background-color"]).toBe(
      "rgba(255,0,0,1)",
    );
  });

  test("the iOS skin draws a native slider: system blue up to the value under a white thumb", () => {
    const ios = rendered([slider()], { skin: "ios" }, "s", { v: 2.5 });
    expect(ios.attrs["aria-valuenow"]).toBe("2.5");
    expect(part(ios, "active").style).toMatchObject({
      "background-color": "rgba(0,122,255,1)",
      height: "4px",
      width: "calc(14px + (100% - 28px) * 0.25)",
    });
    expect(part(ios, "inactive").style["background-color"]).toBe("rgba(120,120,128,0.2)");
    expect(part(ios, "thumb").style).toMatchObject({
      width: "28px",
      height: "28px",
      "background-color": "#ffffff",
    });
    expect(textOf(ios)).toBe("Volume");
    // No Material stop dot.
    expect(find(ios, (candidate) => candidate.attrs["data-part"] === "stop")).toEqual([]);
  });

  test("an iOS slider defaults to min and a max of 1, and does not snap the shown value", () => {
    const unset = rendered([slider({ max: undefined })], { skin: "ios" }, "s");
    expect(unset.attrs["aria-valuemax"]).toBe("1");
    expect(unset.attrs["aria-valuenow"]).toBe("0");
    const stepped = rendered([slider({ step: 2 })], { skin: "ios" }, "s", { v: 3 });
    expect(stepped.attrs["aria-valuenow"]).toBe("3");
    expect(
      rendered([slider({ step: 2 })], { skin: "android" }, "s", { v: 3 }).attrs["aria-valuenow"],
    ).toBe("4");
  });

  test("a dark iOS slider takes the dark system colours", () => {
    const ios = rendered([slider()], { skin: "ios", mode: "dark" }, "s", { v: 5 });
    expect(part(ios, "active").style["background-color"]).toBe("rgba(10,132,255,1)");
    expect(part(ios, "inactive").style["background-color"]).toBe("rgba(120,120,128,0.36)");
  });

  test("glass follows the skin, not the frame", () => {
    const glass = { type: "box", testTag: "g", style: { surface: "glass" } };
    const ios = rendered([glass], { frame: "iphone-16" }, "g");
    expect(rendered([glass], { frame: "pixel-9", skin: "ios" }, "g")).toEqual(ios);
    expect(rendered([glass], { frame: "pixel-9" }, "g")).not.toEqual(ios);
  });

  test("components the iOS skin leaves out draw as Material on both skins", () => {
    const chip = { type: "chip", label: "Tag", testTag: "c" };
    expect(rendered([chip], { skin: "ios" }, "c")).toEqual(
      rendered([chip], { skin: "android" }, "c"),
    );
  });
});
