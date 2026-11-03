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
    const field = { type: "textField", label: "Name", stateKey: "n", testTag: "c" };
    expect(rendered([field], { skin: "ios" }, "c")).toEqual(
      rendered([field], { skin: "android" }, "c"),
    );
  });
});

describe("iOS skin defaults for the Material components (#16599)", () => {
  const ios: PrototypeStillOptions = { skin: "ios" };

  test("a switch is the iOS renderer's 51x31 track after a body label that fills the row", () => {
    const on = rendered(
      [{ type: "switch", label: "Wi-Fi", stateKey: "w", testTag: "t" }],
      ios,
      "t",
      {
        w: true,
      },
    );
    expect(on.attrs).toMatchObject({ role: "switch", "aria-checked": "true" });
    expect(on.style).toMatchObject({ "min-height": "44px", gap: "8px", "font-size": "17px" });
    expect(on.children[0]).toMatchObject({ style: { flex: "1 1 auto" } });
    expect(part(on, "track").style).toMatchObject({
      width: "51px",
      height: "31px",
      "justify-content": "flex-end",
      "background-color": "rgba(51,102,153,1)",
    });
    expect(part(on, "thumb").style).toMatchObject({ width: "27px", height: "27px" });
    const off = rendered([{ type: "switch", stateKey: "w", testTag: "t" }], ios, "t");
    expect(part(off, "track").style["justify-content"]).toBe("flex-start");
    expect(part(off, "track").style["background-color"]).not.toBe("rgba(51,102,153,1)");
  });

  test("a checkbox is a check square 8 pt before its label, filled when checked", () => {
    const box = (state: Record<string, unknown>) =>
      rendered(
        [{ type: "checkbox", label: "Agree", stateKey: "a", testTag: "x" }],
        ios,
        "x",
        state,
      );
    const checked = box({ a: true });
    expect(checked.attrs).toMatchObject({ role: "checkbox", "aria-checked": "true" });
    expect(checked.style).toMatchObject({ gap: "8px", "min-height": "44px" });
    expect(checked.children[0]).toBe(part(checked, "box"));
    expect(textOf(checked)).toBe("Agree");
    expect(part(checked, "box").style["background-color"]).toBe("currentColor");
    expect(part(box({}), "box").style["background-color"]).toBeUndefined();
  });

  test("a list row uses body and subheadline text and grows to 72 pt with a supporting line", () => {
    const row = (extra: Record<string, unknown>) =>
      rendered([{ type: "listItem", headline: "Inbox", testTag: "l", ...extra }], ios, "l");
    expect(row({}).style["min-height"]).toBe("56px");
    const two = row({ supporting: "3 unread", trailing: { type: "switch", stateKey: "s" } });
    expect(two.style["min-height"]).toBe("72px");
    const texts = two.children[0] as WebElement;
    expect(texts.style.gap).toBe("2px");
    expect((texts.children[0] as WebElement).style["font-size"]).toBe("17px");
    expect((texts.children[1] as WebElement).style).toMatchObject({
      "font-size": "15px",
      color: "rgba(73,69,79,1)",
    });
    expect(part(two, "track").style.width).toBe("51px");
    const checked = row({ trailing: { type: "checkbox", stateKey: "c" } });
    expect(part(checked, "box")).toBeDefined();
  });

  test("a chip is padded 12 pt in the medium subheadline style inside a 44 pt target", () => {
    const chip = (state: Record<string, unknown>) =>
      rendered([{ type: "chip", label: "Tag", stateKey: "f", testTag: "c" }], ios, "c", state);
    const plain = chip({});
    expect(plain.style["min-height"]).toBe("44px");
    expect(part(plain, "chip").style).toMatchObject({
      height: "32px",
      "padding-inline": "12px",
      "font-size": "15px",
      "font-weight": "500",
      "border-radius": "8px",
    });
    expect(part(plain, "chip").style.border).not.toContain("transparent");
    const selected = part(chip({ f: true }), "chip");
    expect(selected.style).toMatchObject({
      "padding-inline": "12px",
      border: "1px solid transparent",
    });
    expect(selected.style["background-color"]).toBeDefined();
    expect(selected.children).toHaveLength(2);
  });

  test("a small top app bar leads with a .title3 semibold title in a 64 pt row of 48 pt buttons", () => {
    const bar = rendered(
      [
        {
          type: "topAppBar",
          title: "Mail",
          navigationIcon: { icon: "arrow_back", label: "Back" },
          actions: [{ icon: "search", label: "Search" }],
          ios: { navigationTitle: "inline" },
          testTag: "a",
        },
      ],
      ios,
      "a",
    );
    const row = bar.children[0] as WebElement;
    expect(row.style).toMatchObject({ "min-height": "64px", "padding-inline": "4px" });
    const [back, title, search] = row.children as WebElement[];
    expect(back!.style).toMatchObject({ width: "48px", height: "48px" });
    expect(back!.attrs["aria-label"]).toBe("Back");
    expect(title!.style).toMatchObject({
      "font-size": "20px",
      "font-weight": "600",
      "padding-inline-start": "4px",
    });
    expect(search!.attrs["aria-label"]).toBe("Search");
    // The iOS renderer draws its own bar, so ios.navigationTitle changes nothing.
    const plain = rendered(
      [
        {
          type: "topAppBar",
          title: "Mail",
          navigationIcon: { icon: "arrow_back", label: "Back" },
          actions: [{ icon: "search", label: "Search" }],
          testTag: "a",
        },
      ],
      ios,
      "a",
    );
    expect(bar).toEqual(plain);
  });

  test("medium and large bars put a .title or .largeTitle line below the row", () => {
    const bar = (variant: string) =>
      rendered([{ type: "topAppBar", title: "Mail", variant, testTag: "a" }], ios, "a");
    const large = bar("large").children[1] as WebElement;
    expect(large.style).toMatchObject({ "font-size": "34px", padding: "0 16px 28px" });
    const medium = bar("medium").children[1] as WebElement;
    expect(medium.style).toMatchObject({ "font-size": "28px", padding: "0 16px 20px" });
    const centred = bar("centerAligned").children[0] as WebElement;
    expect((centred.children[0] as WebElement).style).toMatchObject({
      position: "absolute",
      "padding-inline": "56px",
      "text-align": "center",
    });
    expect(bar("small").children).toHaveLength(1);
  });

  test("a scroll-aware medium or large bar frames its title line at 48 or 88 pt", () => {
    const framed = (variant: string, onScroll: string) =>
      rendered([{ type: "topAppBar", title: "Mail", variant, onScroll, testTag: "a" }], ios, "a");
    expect(part(framed("large", "exitUntilCollapsed"), "expanded-title").style).toMatchObject({
      height: "88px",
      "justify-content": "flex-end",
    });
    expect(part(framed("medium", "enterAlways"), "expanded-title").style.height).toBe("48px");
    const pinned = framed("large", "pinned");
    expect(find(pinned, (candidate) => candidate.attrs["data-part"] === "expanded-title")).toEqual(
      [],
    );
  });

  test("a card takes the iOS renderer's container: surfaceContainerHigh, outline and shadow", () => {
    const card = (variant?: string) =>
      rendered(
        [{ type: "card", testTag: "k", ...(variant ? { variant } : {}), children: [] }],
        ios,
        "k",
      );
    const android = rendered([{ type: "card", testTag: "k", children: [] }], {}, "k");
    expect(card().style["background-color"]).toBe("rgba(236,230,240,1)");
    expect(card().style["background-color"]).not.toBe(android.style["background-color"]);
    expect(card("outlined").style.border).toBe("1px solid rgba(202,196,208,1)");
    expect(card("elevated").style["box-shadow"]).toBe("0 1px 2px rgba(0,0,0,0.2)");
    expect(card("elevated").style.border).toBeUndefined();
    const authored = rendered(
      [{ type: "card", testTag: "k", style: { background: "#ff0000" }, children: [] }],
      ios,
      "k",
    );
    expect(authored.style["background-color"]).toBe("rgba(255,0,0,1)");
  });
});
