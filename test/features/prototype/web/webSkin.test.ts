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

  test("the iOS body style follows the frame's Dynamic Type size", () => {
    const large = { frame: "iphone-16", textSize: { contentSize: "large" } } as const;
    const largest = {
      frame: "iphone-16",
      textSize: { contentSize: "accessibility-extra-extra-extra-large" },
    } as const;
    expect(rendered([button()], large, "b").style["font-size"]).toBe("17px");
    const scaled = rendered([button()], largest, "b").style;
    expect(Number.parseFloat(scaled["font-size"]!)).toBeGreaterThan(17);
    expect(Number.parseFloat(scaled["line-height"]!)).toBeGreaterThan(22);
    const label = find(rendered([slider()], largest, "s"), (el) => el.children[0] === "Volume")[0]!;
    expect(label.style["font-size"]).toBe(scaled["font-size"]);
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
    const action = { type: "iconButton", icon: "add", testTag: "c" };
    expect(rendered([action], { skin: "ios" }, "c")).toEqual(
      rendered([action], { skin: "android" }, "c"),
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

  test("the iOS text styles scale with the frame's Dynamic Type size", () => {
    const row = (options: PrototypeStillOptions) =>
      rendered([{ type: "listItem", headline: "Inbox", testTag: "l" }], options, "l");
    const headline = (element: WebElement) =>
      ((element.children[0] as WebElement).children[0] as WebElement).style["font-size"];
    expect(headline(row({ frame: "iphone-16" }))).toBe("17px");
    const larger = headline(
      row({ frame: "iphone-16", textSize: { contentSize: "accessibility-large" } }),
    );
    expect(Number.parseFloat(larger!)).toBeGreaterThan(17);
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

describe("iOS skin text field, navigation bars and sheet (#16646)", () => {
  const ios: PrototypeStillOptions = { skin: "ios" };
  const field = (extra: Record<string, unknown>, state: Record<string, unknown> = {}) =>
    rendered([{ type: "textField", stateKey: "n", testTag: "f", ...extra }], ios, "f", state);
  const input = (element: WebElement) =>
    find(element, (candidate) => candidate.attrs.role === "textbox")[0]!;
  const slot = (element: WebElement, name: string) =>
    find(element, (candidate) => candidate.attrs["data-slot"] === name)[0];

  test("a text field's label sits above a filled input in .footnote, 4 pt apart, never inside", () => {
    const filled = field({ label: "Name" }, { n: "Ada" });
    expect(filled.style).toMatchObject({ "flex-direction": "column", gap: "4px" });
    expect(filled.children[0]).toBe(slot(filled, "label")!);
    expect(slot(filled, "label")!.style).toMatchObject({
      "font-size": "13px",
      color: "rgba(73,69,79,1)",
    });
    expect(input(filled).style).toMatchObject({
      padding: "12px",
      "font-size": "17px",
      "border-radius": "4px 4px 0 0",
      "border-bottom": "1px solid rgba(121,116,126,1)",
      "background-color": "rgba(230,224,233,1)",
    });
    expect(textOf(input(filled))).toBe("Ada");
    // An empty field shows only its placeholder; the label stays above it.
    const empty = field({ label: "Name" });
    expect(textOf(input(empty))).toBe("");
    expect(textOf(input(field({ label: "Name", placeholder: "Your name" })))).toBe("Your name");
    // An empty field keeps one body line, so typing into it moves nothing below it.
    const line = (element: WebElement) => (input(element).children[0] as WebElement).style;
    expect(line(empty)["min-height"]).toBe("22px");
    expect(line(field({ label: "Notes", multiline: true, minLines: 3 }))["min-height"]).toBe(
      "66px",
    );
  });

  test("an outlined field is a 1 pt 4 pt-radius outline stroke, red on an error", () => {
    const outlined = input(field({ variant: "outlined" }));
    expect(outlined.style).toMatchObject({
      padding: "12px",
      "border-radius": "4px",
      border: "1px solid rgba(121,116,126,1)",
    });
    expect(outlined.style["background-color"]).toBeUndefined();
    const errored = field(
      { variant: "outlined", errorWhen: { key: "bad", equals: true }, errorText: "Required" },
      { bad: true },
    );
    expect(input(errored).style.border).toBe("1px solid rgba(255,59,48,1)");
    const alert = find(errored, (candidate) => candidate.attrs.role === "alert")[0]!;
    expect(textOf(alert)).toBe("Required");
    expect(alert.style).toMatchObject({ "font-size": "12px", color: "rgba(255,59,48,1)" });
  });

  test("supporting text and the counter share a .caption row; an error hides the supporting text", () => {
    const counted = field({ label: "Bio", supportingText: "Short", maxLength: 4 }, { n: "Hello" });
    const caption = slot(counted, "caption")!;
    expect(caption.style).toMatchObject({ "font-size": "12px", color: "rgba(73,69,79,1)" });
    expect(textOf(caption)).toBe("Short4/4");
    expect(textOf(input(counted))).toBe("Hell");
    const errored = field(
      { supportingText: "Short", errorWhen: { key: "bad", equals: true } },
      { bad: true },
    );
    expect(textOf(slot(errored, "caption")!)).toBe("");
    expect(textOf(find(errored, (candidate) => candidate.attrs.role === "alert")[0]!)).toBe(
      "Short",
    );
  });

  test("without drawn chrome a field is a rounded-border input; icons sit beside the field", () => {
    const plain = field({ placeholder: "Search" });
    expect(slot(plain, "label")).toBeUndefined();
    expect(input(plain).style).toMatchObject({ "border-radius": "5px", padding: "6px 7px" });
    const secure = field({ label: "PIN", secure: true }, { n: "1234" });
    expect(textOf(input(secure))).toBe("••••");
    const iconed = field({
      label: "Email",
      leadingIcon: "mail",
      trailingIcon: { icon: "close", label: "Clear", onTap: [{ type: "set", key: "n" }] },
    });
    const row = iconed.children[0] as WebElement;
    expect(row.style).toMatchObject({ display: "flex", gap: "4px" });
    expect(row.children).toHaveLength(3);
    const clear = find(iconed, (candidate) => candidate.attrs.role === "button")[0]!;
    expect(clear.attrs["aria-label"]).toBe("Clear");
    expect(clear.style).toMatchObject({ width: "48px", height: "48px" });
  });

  const nav = (type: string, extra: Record<string, unknown> = {}) =>
    rendered(
      [
        {
          type,
          stateKey: "tab",
          testTag: "n",
          items: [
            { label: "Home", icon: "home" },
            { label: "Search", icon: "search" },
          ],
          ...extra,
        },
      ],
      ios,
      "n",
      { tab: 1 },
    );
  const tabs = (element: WebElement) =>
    find(element, (candidate) => candidate.attrs.role === "tab");

  test("a bottom nav spaces items 8 pt with a 64x32 capsule over a .caption label", () => {
    const bar = nav("bottomNav");
    expect(bar.style).toMatchObject({
      gap: "8px",
      "padding-inline": "8px",
      "padding-top": "12px",
      "min-height": "80px",
      "background-color": "rgba(243,237,247,1)",
    });
    expect(bar.style["padding-bottom"]).toContain("4px");
    const [home, search] = tabs(bar);
    expect(search!.attrs["aria-selected"]).toBe("true");
    expect(search!.style).toMatchObject({ gap: "4px", "min-height": "64px" });
    expect(part(search!, "indicator").style).toMatchObject({ width: "64px", height: "32px" });
    expect(part(search!, "indicator").style["background-color"]).toBeDefined();
    expect(part(home!, "indicator").style["background-color"]).toBeUndefined();
    const label = (tab: WebElement) => tab.children[1] as WebElement;
    expect(label(search!).style).toMatchObject({ "font-size": "12px", "font-weight": "600" });
    expect(label(home!).style["font-weight"]).toBe("500");
    expect(search!.style.color).not.toBe(home!.style.color);
  });

  test("a tab bar has no divider or background, 44 pt tabs and a capsule on the selected one", () => {
    const bar = nav("tabBar");
    expect(bar.style["border-bottom"]).toBeUndefined();
    expect(bar.style["background-color"]).toBeUndefined();
    const [home, search] = tabs(bar);
    expect(home!.style).toMatchObject({ gap: "2px", "min-height": "44px", "font-size": "12px" });
    expect(home!.style["background-color"]).toBeUndefined();
    expect(search!.style).toMatchObject({ "border-radius": "9999px" });
    expect(search!.style["background-color"]).toBeDefined();
    expect(tabs(nav("tabBar", { onScroll: "minimize" }))[0]!.style["min-height"]).toBe("64px");
  });

  test("a bottom sheet has a 36x5 handle 6 pt down, 8 pt spacing and a 16 pt radius", () => {
    const sheet = (options: PrototypeStillOptions, extra: Record<string, unknown> = {}) =>
      rendered(
        [
          {
            type: "bottomSheet",
            testTag: "sheet",
            openWhen: { key: "open", equals: true },
            child: { type: "text", text: "Details" },
            ...extra,
          },
        ],
        options,
        "sheet",
        { open: true },
      );
    const drawn = sheet(ios);
    expect(drawn.style).toMatchObject({
      gap: "8px",
      "border-radius": "16px",
      "align-items": "center",
      "background-color": "rgba(254,247,255,1)",
    });
    expect(part(drawn, "handle").style).toMatchObject({
      width: "36px",
      height: "5px",
      "margin-top": "6px",
    });
    // The iOS renderer ignores ios.sheet.sizing, so the skin does too.
    expect(sheet(ios, { ios: { sheet: { sizing: "fitted" } } })).toEqual(drawn);
    const android = sheet({ skin: "android" });
    expect(part(android, "handle").style).toMatchObject({ width: "32px", height: "4px" });
    expect(android.style["border-radius"]).toBeUndefined();
  });
});
