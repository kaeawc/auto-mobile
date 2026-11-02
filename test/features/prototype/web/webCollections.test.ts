import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  toHtml,
  type WebChild,
  type WebElement,
} from "../../../../src/features/prototype/web/webNodes";
import { renderPrototypeStill } from "../../../../src/features/prototype/web/webStill";

type Spec = Record<string, unknown>;

const fixture = (name: string): Spec =>
  JSON.parse(
    readFileSync(
      join(import.meta.dir, `../../../fixtures/prototype-spec/valid/${name}.json`),
      "utf8",
    ),
  ) as Spec;

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
const byTag = (element: WebElement, tag: string) =>
  find(element, (candidate) => candidate.attrs["data-testid"] === tag);
const byNode = (element: WebElement, type: string) =>
  find(element, (candidate) => candidate.attrs["data-node"] === type);
const byPart = (element: WebElement, part: string) =>
  find(element, (candidate) => candidate.attrs["data-part"] === part);
const rootOf = (root: Spec, extra: Spec = {}) => ({ id: "s", root, ...extra });

// Material 3 baseline light roles, as rgba() strings.
const PRIMARY = "rgba(103,80,164,1)";
const SECONDARY_CONTAINER = "rgba(232,222,248,1)";
const OUTLINE_VARIANT = "rgba(202,196,208,1)";

describe("web still pager (#16382)", () => {
  test("draws only the initial page, filling the pager, with indicator dots over it", () => {
    const still = renderPrototypeStill(fixture("pager-indicator-dots"));
    expect(still.unsupportedNodes).toEqual([]);
    const pager = byNode(still.element, "pager")[0]!;
    expect(textOf(pager)).toBe("A");
    const page = byPart(pager, "page")[0]!;
    expect(page.style).toMatchObject({ flex: "1 1 auto", "align-self": "stretch" });
    const dots = byPart(pager, "dot");
    expect(dots).toHaveLength(2);
    expect(dots[0]!.style).not.toHaveProperty("opacity");
    expect(dots[1]!.style.opacity).toBe("0.38");
    expect(byPart(pager, "indicator")[0]!.style.position).toBe("absolute");
  });

  test("opens at its state key's page, clamped and truncated as on the devices", () => {
    const at = (page: number) => {
      const spec = { ...fixture("pager-state-key-indicator"), state: { page } };
      return textOf(byNode(renderPrototypeStill(spec).element, "pager")[0]!);
    };
    expect(at(0)).toBe("First");
    expect(at(1)).toBe("Second");
    expect(at(1.7)).toBe("Second");
    expect(at(9)).toBe("Second");
    expect(at(-3)).toBe("First");
  });

  test("draws no dots without an indicator, and a 22px strip when placed below", () => {
    const pagerOf = (extra: Spec) =>
      byNode(
        renderPrototypeStill(
          rootOf({ type: "pager", id: "p", children: [{ type: "text", text: "A" }], ...extra }),
        ).element,
        "pager",
      )[0]!;
    expect(byPart(pagerOf({}), "dot")).toEqual([]);
    const strip = byPart(pagerOf({ indicator: "dots", indicatorPlacement: "below" }), "indicator");
    expect(strip[0]!.style).toMatchObject({ height: "22px" });
    expect(strip[0]!.style).not.toHaveProperty("position");
    const vertical = byPart(pagerOf({ indicator: "dots", axis: "vertical" }), "indicator")[0]!;
    expect(vertical.style).toMatchObject({ "flex-direction": "column", right: "8px" });
  });

  test("page content binds the pager's one-based page and page count", () => {
    const pager = byNode(
      renderPrototypeStill(
        rootOf(
          {
            type: "pager",
            id: "p",
            stateKey: "page_index",
            children: [
              { type: "text", text: "Page {page} of {pageCount}" },
              { type: "text", text: "Page {page} of {pageCount}" },
            ],
          },
          { state: { page_index: 1 } },
        ),
      ).element,
      "pager",
    )[0]!;
    expect(textOf(pager)).toBe("Page 2 of 2");
  });

  test("page placeholders leave control state alone, even for a pager keyed `page`", () => {
    const still = renderPrototypeStill(
      rootOf(
        {
          type: "pager",
          id: "p",
          stateKey: "page",
          children: [
            {
              type: "column",
              children: [
                { type: "text", testTag: "label", text: "Page {page} of {pageCount}" },
                {
                  type: "tabBar",
                  testTag: "tabs",
                  pager: "p",
                  items: [{ label: "One" }, { label: "Two" }],
                },
              ],
            },
            { type: "text", text: "second" },
          ],
        },
        { state: { page: 0 } },
      ),
    ).element;
    expect(textOf(byTag(still, "label")[0]!)).toBe("Page 1 of 2");
    const tabs = find(byTag(still, "tabs")[0]!, (element) => element.attrs.role === "tab");
    expect(tabs.map((tab) => tab.attrs["aria-selected"])).toEqual(["true", "false"]);
  });

  test("visibleWhen and styleWhen inside a page read the pager's page, not global state", () => {
    const still = renderPrototypeStill(
      rootOf(
        {
          type: "pager",
          id: "p",
          stateKey: "page_index",
          children: [
            { type: "text", text: "first" },
            {
              type: "column",
              children: [
                {
                  type: "text",
                  testTag: "shown",
                  text: "on two",
                  visibleWhen: { key: "page", equals: 2 },
                },
                {
                  type: "text",
                  testTag: "styled",
                  text: "styled",
                  styleWhen: [{ when: { key: "page", equals: 2 }, style: { color: "#FF0000" } }],
                },
              ],
            },
          ],
        },
        { state: { page: 0, page_index: 1 } },
      ),
    ).element;
    expect(byTag(still, "shown")).toHaveLength(1);
    expect(byTag(still, "styled")[0]!.style.color).toBe("rgba(255,0,0,1)");
  });

  test("enabledWhen and errorWhen inside a page read the pager's page too", () => {
    const still = renderPrototypeStill(
      rootOf(
        {
          type: "pager",
          id: "p",
          stateKey: "p",
          children: [
            { type: "text", text: "first" },
            {
              type: "column",
              children: [
                {
                  type: "chip",
                  testTag: "chip",
                  label: "Page {page}",
                  enabledWhen: { key: "page", equals: 2 },
                },
                {
                  type: "textField",
                  testTag: "field",
                  stateKey: "name",
                  errorWhen: { key: "page", equals: 2 },
                  errorText: "on page two",
                },
              ],
            },
          ],
        },
        { state: { page: 0, p: 1, name: "" } },
      ),
    ).element;
    const chip = byTag(still, "chip")[0]!;
    expect(textOf(chip)).toBe("Page 2");
    expect(chip.attrs["aria-disabled"]).toBeUndefined();
    const alerts = find(still, (element) => element.attrs.role === "alert");
    expect(alerts.map(textOf)).toEqual(["on page two"]);
  });

  test("a pager's own visibleWhen and styleWhen read its page", () => {
    const pager = byNode(
      renderPrototypeStill(
        rootOf(
          {
            type: "pager",
            id: "p",
            stateKey: "selected",
            visibleWhen: { key: "page", equals: 2 },
            styleWhen: [
              { when: { key: "pageCount", equals: 2 }, style: { background: "#FF0000" } },
            ],
            children: [
              { type: "text", text: "first" },
              { type: "text", text: "second" },
            ],
          },
          { state: { page: 0, selected: 1 } },
        ),
      ).element,
      "pager",
    );
    expect(pager).toHaveLength(1);
    expect(pager[0]!.style["background-color"]).toBe("rgba(255,0,0,1)");
    expect(textOf(pager[0]!)).toBe("second");
  });

  test("a parent's fill inference sees a pager's locals, as rendering does", () => {
    const wrapper = byTag(
      renderPrototypeStill(
        rootOf(
          {
            type: "column",
            style: { width: "fill" },
            children: [
              {
                type: "column",
                testTag: "wrapper",
                children: [
                  {
                    type: "pager",
                    id: "p",
                    stateKey: "selected",
                    style: { height: { dp: 100 } },
                    visibleWhen: { key: "page", equals: 2 },
                    children: [
                      { type: "text", text: "first" },
                      { type: "slider", stateKey: "v" },
                    ],
                  },
                ],
              },
            ],
          },
          { state: { page: 0, selected: 1 } },
        ),
      ).element,
      "wrapper",
    )[0]!;
    expect(wrapper.style).toMatchObject({ "align-self": "stretch", width: "100%" });
  });

  test("applies peek padding and a fixed page size on the pager's axis", () => {
    const pager = byNode(
      renderPrototypeStill(
        rootOf({
          type: "pager",
          id: "p",
          peek: { start: 24, end: 16 },
          pageSize: { dp: 200 },
          children: [{ type: "text", text: "A" }],
        }),
      ).element,
      "pager",
    )[0]!;
    expect(byPart(pager, "viewport")[0]!.style).toMatchObject({
      "padding-inline-start": "24px",
      "padding-inline-end": "16px",
    });
    expect(byPart(pager, "page")[0]!.style).toMatchObject({ width: "200px" });
  });

  test("peek insets add to the pager's own padding instead of replacing it", () => {
    const pager = byNode(
      renderPrototypeStill(
        rootOf({
          type: "pager",
          id: "p",
          peek: { start: 24, end: 16 },
          style: { padding: { start: 12, end: 8 } },
          children: [{ type: "text", text: "A" }],
        }),
      ).element,
      "pager",
    )[0]!;
    expect(pager.style).toMatchObject({
      "padding-inline-start": "12px",
      "padding-inline-end": "8px",
    });
    expect(byPart(pager, "viewport")[0]!.style).toMatchObject({
      "padding-inline-start": "24px",
      "padding-inline-end": "16px",
    });
  });

  test("a tab bar linked to a pager selects the pager's page", () => {
    const spec = fixture("template-tabbed-home");
    const still = renderPrototypeStill(spec);
    const tabs = find(byTag(still.element, "bottom_nav")[0]!, (e) => e.attrs.role === "tab");
    expect(tabs.map((tab) => tab.attrs["aria-selected"])).toEqual(["true", "false", "false"]);
    const linked = renderPrototypeStill(
      rootOf(
        {
          type: "column",
          children: [
            {
              type: "tabBar",
              stateKey: "other",
              pager: "p",
              items: [{ label: "A" }, { label: "B" }],
            },
            {
              type: "pager",
              id: "p",
              stateKey: "pg",
              children: [
                { type: "text", text: "A" },
                { type: "text", text: "B" },
              ],
            },
          ],
        },
        { state: { pg: 1, other: 0 } },
      ),
    ).element;
    const selected = find(linked, (e) => e.attrs.role === "tab").map(
      (t) => t.attrs["aria-selected"],
    );
    expect(selected).toEqual(["false", "true"]);
  });
});

describe("web still grid (#16382)", () => {
  test("a grid cell fills its cell width even when the child authors a maxWidth", () => {
    const grid = byNode(
      renderPrototypeStill(
        rootOf({
          type: "grid",
          columns: 2,
          children: [
            { type: "text", text: "A", style: { maxWidth: 20 } },
            { type: "text", text: "B" },
          ],
        }),
      ).element,
      "grid",
    )[0]!;
    expect((grid.children[0] as WebElement).style).not.toHaveProperty("max-width");
  });

  test("lays a fixed-column grid out with spans and spacing", () => {
    const still = renderPrototypeStill(fixture("grid-fixed-columns-span"));
    expect(still.unsupportedNodes).toEqual([]);
    const grid = byNode(still.element, "grid")[0]!;
    expect(grid.style).toMatchObject({
      display: "grid",
      "grid-template-columns": "repeat(3, minmax(0, 1fr))",
      "column-gap": "8px",
      "row-gap": "16px",
    });
    const spans = grid.children.map((cell) => (cell as WebElement).style["grid-column"]);
    expect(spans).toEqual(["span 2", "span 2", "span 3"]);
  });

  test("clamps spans to the column count, and row spacing defaults to spacing", () => {
    const grid = byNode(
      renderPrototypeStill(
        rootOf({
          type: "grid",
          columns: 2,
          style: { spacing: 4 },
          children: [
            { type: "text", text: "A", span: 5 },
            { type: "text", text: "B" },
          ],
        }),
      ).element,
      "grid",
    )[0]!;
    expect(grid.style["row-gap"]).toBe("4px");
    const spans = grid.children.map((cell) => (cell as WebElement).style["grid-column"]);
    expect(spans).toEqual(["span 2", "span 1"]);
  });

  test("an adaptive grid fits minimum-width columns to the screen and clamps spans to them", () => {
    const spec = fixture("grid-adaptive-min-width");
    const gridOf = (orientation: "portrait" | "landscape") =>
      byNode(renderPrototypeStill(spec, { frame: "pixel-9", orientation }).element, "grid")[0]!;
    const portrait = gridOf("portrait");
    // 411 dp wide: floor(411 / 100) = 4 columns, so a 12-column span fills one row.
    expect(portrait.style["grid-template-columns"]).toBe("repeat(4, minmax(0, 1fr))");
    expect(portrait.children.map((cell) => (cell as WebElement).style["grid-column"])).toEqual([
      "span 4",
      "span 4",
    ]);
    expect(textOf(portrait)).toBe("OneTwo");
    // The root grid fills the window; its rows stay at the top instead of sharing the height.
    expect(portrait.style["align-content"]).toBe("start");
    expect((gridOf("landscape").children[0] as WebElement).style["grid-column"]).toBe("span 9");
  });
});

describe("web still carousel (#16382)", () => {
  test("draws its items in a clipped row at the item width and spacing", () => {
    const still = renderPrototypeStill(fixture("carousel-multi-browse"));
    expect(still.unsupportedNodes).toEqual([]);
    const carousel = byNode(still.element, "carousel")[0]!;
    expect(carousel.style).toMatchObject({
      display: "flex",
      "flex-direction": "row",
      overflow: "hidden",
      gap: "8px",
    });
    const items = byPart(carousel, "item");
    expect(items.map(textOf)).toEqual(["One", "Two", "Three"]);
    expect(items[0]!.style).toMatchObject({
      flex: "0 0 186px",
      "border-radius": "28px",
      overflow: "hidden",
    });
  });

  test("expands its repeat", () => {
    const carousel = byNode(
      renderPrototypeStill(fixture("carousel-hero-repeat")).element,
      "carousel",
    )[0]!;
    const items = byPart(carousel, "item");
    expect(items.length).toBeGreaterThan(1);
    // Each repeat row binds its own item, not a copy of the first.
    expect(new Set(items.map(textOf)).size).toBe(items.length);
  });

  test("keeps an empty item slot for a hidden child, as Android does", () => {
    const carousel = byNode(
      renderPrototypeStill(
        rootOf(
          {
            type: "carousel",
            itemWidth: 200,
            itemSpacing: 8,
            children: [
              { type: "text", text: "Hidden", visibleWhen: { key: "show", equals: true } },
              { type: "text", text: "Shown" },
            ],
          },
          { state: { show: false } },
        ),
      ).element,
      "carousel",
    )[0]!;
    const items = byPart(carousel, "item");
    expect(items.map(textOf)).toEqual(["", "Shown"]);
    expect(items[0]!.style).toMatchObject({ flex: "0 0 200px" });
  });
});

describe("web still navigation bars (#16382)", () => {
  const nav = (type: string, extra: Spec = {}, state: Spec = {}) =>
    byTag(
      renderPrototypeStill(
        rootOf(
          {
            type: "column",
            children: [
              {
                type,
                testTag: "bar",
                stateKey: "tab",
                items: [{ label: "Home", icon: "home" }, { label: "Search" }],
                ...extra,
              },
            ],
          },
          { state },
        ),
      ).element,
      "bar",
    )[0]!;
  const tabsOf = (bar: WebElement) => find(bar, (element) => element.attrs.role === "tab");

  test("a bottom nav draws each item's icon and label, highlighting the state's item", () => {
    const bar = nav("bottomNav", {}, { tab: 1 });
    expect(bar.attrs.role).toBe("tablist");
    expect(bar.style).toMatchObject({ "min-height": "80px", "align-self": "stretch" });
    const tabs = tabsOf(bar);
    expect(tabs.map((tab) => tab.attrs["aria-selected"])).toEqual(["false", "true"]);
    expect(find(tabs[0]!, (element) => element.attrs.title === "home")).toHaveLength(1);
    // An item without an icon draws the 24px placeholder square, as Android does.
    expect(byPart(tabs[1]!, "placeholder")[0]!.style).toMatchObject({ width: "24px" });
    expect(byPart(tabs[1]!, "indicator")[0]!.style["background-color"]).toBe(SECONDARY_CONTAINER);
    expect(byPart(tabs[0]!, "indicator")[0]!.style).not.toHaveProperty("background-color");
    expect(textOf(tabs[1]!)).toBe("Search");
  });

  test("a bottom nav pads its bottom edge by the safe area unless an ancestor took it", () => {
    expect(nav("bottomNav").style["padding-bottom"]).toContain("var(--safe-bottom)");
    const consumed = byTag(
      renderPrototypeStill(
        rootOf({
          type: "column",
          safeAreaPadding: { edges: ["bottom"], types: ["systemBars"] },
          children: [
            { type: "bottomNav", testTag: "bar", items: [{ label: "A" }, { label: "B" }] },
          ],
        }),
      ).element,
      "bar",
    )[0]!;
    expect(JSON.stringify(consumed.style)).not.toContain("--safe-bottom");
  });

  test("a bottom nav keeps an authored IME-only edge apart from its own bottom inset", () => {
    const bar = nav("bottomNav", { safeAreaPadding: { edges: ["top"], types: ["ime"] } });
    expect(bar.style["padding-bottom"]).toContain("var(--safe-bottom)");
    expect(JSON.stringify(bar.style)).not.toContain("--safe-top");
  });

  test("a bottom nav asking for its bottom inset itself takes it only once", () => {
    const bar = nav("bottomNav", {
      safeAreaPadding: { edges: ["bottom"], types: ["systemBars"] },
    });
    expect(bar.style["padding-bottom"]!.match(/--safe-bottom/g)).toHaveLength(1);
  });

  test("a tab bar marks the selected tab with the primary colour and indicator", () => {
    const bar = nav("tabBar", { items: [{ label: "One" }, { label: "Two" }] }, { tab: 1 });
    expect(bar.style).toMatchObject({ "min-height": "48px" });
    const tabs = tabsOf(bar);
    expect(tabs.map((tab) => tab.attrs["aria-selected"])).toEqual(["false", "true"]);
    expect(tabs[1]!.style.color).toBe(PRIMARY);
    expect(tabs[1]!.style["box-shadow"]).toContain(PRIMARY);
    expect(tabs[0]!.style).not.toHaveProperty("box-shadow");
    expect(tabs.map(textOf)).toEqual(["One", "Two"]);
  });

  test("a tab bar with icons is 72px tall; a scrollable one starts after its edge padding", () => {
    expect(nav("tabBar").style["min-height"]).toBe("72px");
    const scrollable = nav("tabBar", { scrollable: true });
    expect(scrollable.style).toMatchObject({ "padding-inline-start": "52px", overflow: "hidden" });
    expect(tabsOf(scrollable)[0]!.style).toMatchObject({ "min-width": "90px" });
  });

  test("an item image falls back to its icon, or the placeholder, since assets are not inlined", () => {
    const still = renderPrototypeStill(fixture("media-tab-item-data"));
    expect(still.unsupportedNodes).toEqual([]);
    const tabs = find(still.element, (element) => element.attrs.role === "tab");
    expect(tabs.map((tab) => byPart(tab, "placeholder").length)).toEqual([1, 1]);
  });
});

describe("web still icon buttons (#16382)", () => {
  const iconButton = (extra: Spec = {}, state: Spec = {}) =>
    byTag(
      renderPrototypeStill(
        rootOf(
          {
            type: "column",
            children: [{ type: "iconButton", testTag: "b", icon: "favorite", ...extra }],
          },
          { state },
        ),
      ).element,
      "b",
    )[0]!;
  const containerOf = (button: WebElement) => byPart(button, "container")[0]!;

  test("draws the icon placeholder in a 40px circle inside a 48px target", () => {
    const button = iconButton();
    expect(button.attrs).toMatchObject({ role: "button", "aria-label": "favorite" });
    expect(button.style).toMatchObject({ width: "48px", height: "48px" });
    expect(containerOf(button).style).toMatchObject({
      width: "40px",
      height: "40px",
      "border-radius": "50%",
    });
    expect(containerOf(button).style).not.toHaveProperty("background-color");
    expect(find(button, (element) => element.attrs.title === "favorite")).toHaveLength(1);
  });

  test("filled, tonal and outlined variants take their Material 3 roles", () => {
    expect(containerOf(iconButton({ variant: "filled" })).style["background-color"]).toBe(PRIMARY);
    expect(containerOf(iconButton({ variant: "tonal" })).style["background-color"]).toBe(
      SECONDARY_CONTAINER,
    );
    expect(containerOf(iconButton({ variant: "outlined" })).style.border).toBe(
      `1px solid ${OUTLINE_VARIANT}`,
    );
  });

  test("an authored label wins over the icon name, and enabledWhen false draws it disabled", () => {
    const button = iconButton(
      { contentDescription: "Like", enabledWhen: { key: "on", equals: true } },
      { on: false },
    );
    expect(button.attrs).toMatchObject({ "aria-label": "Like", "aria-disabled": "true" });
    expect(button.style.opacity).toBe("0.38");
  });

  test("the feed template's tonal like button draws", () => {
    const still = renderPrototypeStill(fixture("template-feed-detail"));
    expect(still.unsupportedNodes.map((node) => node.type)).not.toContain("iconButton");
  });
});

describe("web still chips and sliders (#16382)", () => {
  const still = renderPrototypeStill(fixture("material-slider-chip-card"));

  test("the slider and chip fixture draws without placeholders", () => {
    expect(still.unsupportedNodes).toEqual([]);
  });

  test("a chip without a state key is an outlined 32px assist chip", () => {
    const chip = byTag(still.element, "add_label_chip")[0]!;
    expect(chip.attrs.role).toBe("button");
    const body = byPart(chip, "chip")[0]!;
    expect(body.style).toMatchObject({
      height: "32px",
      "border-radius": "8px",
      border: `1px solid ${OUTLINE_VARIANT}`,
    });
    expect(textOf(chip)).toBe("Add label");
  });

  test("a chip with a state key is a filter chip: tonal with a check when selected", () => {
    const selected = byTag(still.element, "mon_chip")[0]!;
    expect(selected.attrs).toMatchObject({ role: "checkbox", "aria-checked": "true" });
    expect(byPart(selected, "chip")[0]!.style["background-color"]).toBe(SECONDARY_CONTAINER);
    expect(find(selected, (element) => element.attrs.title === "check")).toHaveLength(1);
    const row = byNode(still.element, "chip");
    const tue = row.find((chip) => textOf(chip).includes("Tue"))!;
    expect(tue.attrs["aria-checked"]).toBe("false");
    expect(byPart(tue, "chip")[0]!.style.border).toBe(`1px solid ${OUTLINE_VARIANT}`);
    expect(find(tue, (element) => element.attrs.title === "check")).toEqual([]);
  });

  test("a slider whose enabledWhen is false draws disabled", () => {
    const slider = byNode(
      renderPrototypeStill(
        rootOf(
          {
            type: "slider",
            stateKey: "v",
            min: 0,
            max: 1,
            enabledWhen: { key: "on", equals: true },
          },
          { state: { on: false } },
        ),
      ).element,
      "slider",
    )[0]!;
    expect(slider.attrs["aria-disabled"]).toBe("true");
    expect(slider.style.opacity).toBe("0.38");
  });

  test("an unsized box around a slider grows to its parent's width, as Compose's Box does", () => {
    const root = renderPrototypeStill(
      rootOf({
        type: "column",
        children: [
          { type: "box", testTag: "box", children: [{ type: "slider", stateKey: "v" }] },
          {
            type: "box",
            testTag: "sized",
            style: { width: { dp: 120 } },
            children: [{ type: "slider", stateKey: "v" }],
          },
        ],
      }),
    ).element;
    expect(byTag(root, "box")[0]!.style).toMatchObject({ "align-self": "stretch", width: "100%" });
    // An authored width still wins.
    expect(byTag(root, "sized")[0]!.style.width).toBe("120px");
  });

  test("a chip's authored foreground colour wins over its Material role", () => {
    const chip = byNode(
      renderPrototypeStill(rootOf({ type: "chip", label: "X", style: { color: "#FF0000" } }))
        .element,
      "chip",
    )[0]!;
    expect(byPart(chip, "chip")[0]!.style.color).toBe("rgba(255,0,0,1)");
  });

  test("control labels follow the theme's type scale", () => {
    const scaled = renderPrototypeStill(
      rootOf(
        {
          type: "column",
          children: [
            { type: "chip", testTag: "chip", label: "X" },
            { type: "bottomNav", testTag: "nav", items: [{ label: "A" }, { label: "B" }] },
            { type: "tabBar", testTag: "tabs", items: [{ label: "A" }, { label: "B" }] },
          ],
        },
        { theme: { typography: { scale: 2 } } },
      ),
    ).element;
    expect(byPart(byTag(scaled, "chip")[0]!, "chip")[0]!.style).toMatchObject({
      "font-size": "28px",
      "line-height": "40px",
    });
    const navLabel = find(byTag(scaled, "nav")[0]!, (e) => e.style["font-size"] !== undefined)[0]!;
    expect(navLabel.style["font-size"]).toBe("24px");
    const tab = find(byTag(scaled, "tabs")[0]!, (e) => e.attrs.role === "tab")[0]!;
    expect(tab.style["font-size"]).toBe("28px");
    const slider = renderPrototypeStill(
      rootOf(
        { type: "slider", testTag: "s", stateKey: "v", label: "Volume" },
        { theme: { typography: { scale: 2, fontFamily: "serif" } } },
      ),
    ).element;
    const label = find(byTag(slider, "s")[0]!, (e) => e.style["font-size"] !== undefined)[0]!;
    // A plain label takes Material 3's default text style, bodyLarge (16/24), scaled.
    expect(label.style).toMatchObject({ "font-size": "32px", "font-family": "serif" });
  });

  test("an authored fill on a child grows its unsized parent like a default fill", () => {
    const wrapper = byTag(
      renderPrototypeStill(
        rootOf({
          type: "column",
          style: { width: "fill" },
          children: [
            {
              type: "column",
              testTag: "wrapper",
              children: [{ type: "slider", stateKey: "v", style: { width: "fill" } }],
            },
          ],
        }),
      ).element,
      "wrapper",
    )[0]!;
    expect(wrapper.style).toMatchObject({ "align-self": "stretch", width: "100%" });
  });

  test("an unsized column around an unsized column passes a slider's fill up to its parent", () => {
    const outer = byTag(
      renderPrototypeStill(
        rootOf({
          type: "column",
          style: { width: "fill" },
          children: [
            {
              type: "column",
              testTag: "outer",
              children: [{ type: "column", children: [{ type: "slider", stateKey: "v" }] }],
            },
          ],
        }),
      ).element,
      "outer",
    )[0]!;
    expect(outer.style).toMatchObject({ "align-self": "stretch", width: "100%" });
  });

  test("a chip whose enabledWhen is false draws disabled", () => {
    const chip = byNode(
      renderPrototypeStill(
        rootOf(
          { type: "chip", label: "X", enabledWhen: { key: "on", equals: true } },
          { state: { on: false } },
        ),
      ).element,
      "chip",
    )[0]!;
    expect(chip.attrs["aria-disabled"]).toBe("true");
    expect(chip.style.opacity).toBe("0.38");
  });

  test("a slider draws its label, track and thumb at its state value", () => {
    const slider = byTag(still.element, "volume_slider")[0]!;
    expect(slider.attrs).toMatchObject({
      role: "slider",
      "aria-valuenow": "7",
      "aria-valuemin": "0",
      "aria-valuemax": "10",
    });
    expect(textOf(slider)).toBe("Volume");
    expect(byPart(slider, "thumb")[0]!.style["inset-inline-start"]).toBe("calc(70% - 2px)");
    expect(byPart(slider, "active")[0]!.style["background-color"]).toBe(PRIMARY);
    expect(byPart(slider, "inactive")[0]!.style["background-color"]).toBe(SECONDARY_CONTAINER);
    const snooze = byNode(still.element, "slider")[1]!;
    expect(byPart(snooze, "thumb")[0]!.style["inset-inline-start"]).toBe("calc(20% - 2px)");
  });

  test("a slider value snaps to its step and clamps to its range; no value reads as min", () => {
    const thumbAt = (state: Spec, step?: number) =>
      byPart(
        renderPrototypeStill(
          rootOf(
            { type: "slider", stateKey: "v", min: 10, max: 20, ...(step ? { step } : {}) },
            { state },
          ),
        ).element,
        "thumb",
      )[0]!.style["inset-inline-start"];
    expect(thumbAt({ v: 14.4 }, 2)).toBe("calc(40% - 2px)");
    expect(thumbAt({ v: 99 })).toBe("calc(100% - 2px)");
    expect(thumbAt({})).toBe("calc(0% - 2px)");
  });

  test("a card or line around a slider grows to its parent's width, as a Compose parent does", () => {
    const card = byTag(still.element, "alarm_card")[0]!;
    expect(card.style).toMatchObject({ "align-self": "stretch", width: "100%" });
    const line = byTag(
      renderPrototypeStill(
        rootOf({
          type: "column",
          children: [
            {
              type: "row",
              testTag: "line",
              children: [{ type: "slider", stateKey: "v", min: 0, max: 1 }],
            },
          ],
        }),
      ).element,
      "line",
    )[0]!;
    expect(line.style).toMatchObject({ "align-self": "stretch", width: "100%" });
    expect(line.style).not.toHaveProperty("flex");
  });

  test("the same input renders the same bytes", () => {
    expect(toHtml(renderPrototypeStill(fixture("material-slider-chip-card")).element)).toBe(
      toHtml(still.element),
    );
  });
});
