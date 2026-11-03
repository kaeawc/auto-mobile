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
const byNode = (element: WebElement, type: string) =>
  find(element, (candidate) => candidate.attrs["data-node"] === type);
const byPart = (element: WebElement, part: string) =>
  find(element, (candidate) => candidate.attrs["data-part"] === part);
const windowOf = (element: WebElement) =>
  find(element, (candidate) => candidate.attrs["data-window"] !== undefined)[0]!;

const sheet = (extra: Spec = {}): Spec => ({
  type: "bottomSheet",
  testTag: "sheet",
  openWhen: { key: "open", equals: true },
  detents: ["half"],
  child: { type: "text", text: "Details" },
  ...extra,
});
/** A sheet inside a column, open unless the state says otherwise. */
const specWith = (node: Spec, extra: Spec = {}): Spec => ({
  id: "s",
  state: { open: true },
  root: { type: "column", children: [{ type: "text", text: "Body" }, node] },
  ...extra,
});

// Material 3 baseline roles, as rgba() strings.
const SURFACE_LIGHT = "rgba(254,247,255,1)";
const SURFACE_DARK = "rgba(20,18,24,1)";
const ON_SURFACE_VARIANT_LIGHT = "rgba(73,69,79,1)";
const ON_SURFACE_VARIANT_DARK = "rgba(202,196,208,1)";
const PRIMARY = "rgba(103,80,164,1)";
const DEFAULT_SCRIM = "rgba(0,0,0,0.4)";

describe("web still bottomSheet (#16382)", () => {
  test("a closed sheet draws nothing, in the common specs' initial state", () => {
    const cases: [string, Record<string, string>][] = [
      ["template-checkout", { screen: "details" }],
      ["doc-example-1", {}],
      ["floating-element-anchor", {}],
    ];
    for (const [name, options] of cases) {
      const still = renderPrototypeStill(fixture(name), options);
      expect(still.unsupportedNodes.map((node) => node.type)).not.toContain("bottomSheet");
      expect(byNode(still.element, "bottomSheet")).toEqual([]);
      expect(byPart(still.element, "scrim")).toEqual([]);
    }
  });

  test("an open sheet is a window layer: a 0.4 scrim role under a half-height surface", () => {
    const spec = { ...fixture("doc-example-1"), state: { query: "", open: true } };
    const still = renderPrototypeStill(spec);
    expect(still.unsupportedNodes.map((node) => node.type)).not.toContain("bottomSheet");
    const window = windowOf(still.element);
    const layer = window.children.at(-1) as WebElement;
    expect(layer.attrs["data-part"]).toBe("sheetLayer");
    expect(layer.style).toMatchObject({
      position: "absolute",
      inset: "0",
      display: "flex",
      "flex-direction": "column",
      "justify-content": "flex-end",
    });
    const [scrim, drawn] = layer.children as WebElement[];
    expect(scrim!.attrs["data-part"]).toBe("scrim");
    expect(scrim!.style).toMatchObject({
      position: "absolute",
      inset: "0",
      "background-color": DEFAULT_SCRIM,
    });
    expect(drawn!.attrs).toMatchObject({ "data-node": "bottomSheet", "data-part": "sheet" });
    expect(drawn!.style).toMatchObject({
      position: "relative",
      width: "100%",
      height: "50%",
      "max-height": "100%",
      "background-color": SURFACE_LIGHT,
      display: "flex",
      "flex-direction": "column",
    });
    // Android's sheet is a plain full-width column: no corner shape and no shadow.
    expect(drawn!.style).not.toHaveProperty("border-radius");
    expect(drawn!.style).not.toHaveProperty("box-shadow");
    expect(textOf(drawn!)).toBe("Details");
  });

  test("draws a centred 32x4 onSurfaceVariant handle with 8 px around it, unless turned off", () => {
    const handleOf = (extra: Spec, mode?: "dark") =>
      byPart(renderPrototypeStill(specWith(sheet(extra)), mode ? { mode } : {}).element, "handle");
    const [handle] = handleOf({});
    expect(handle!.style).toMatchObject({
      width: "32px",
      height: "4px",
      margin: "8px",
      "border-radius": "2px",
      "align-self": "center",
      "background-color": ON_SURFACE_VARIANT_LIGHT,
    });
    expect(handleOf({ dragHandle: true })).toHaveLength(1);
    expect(handleOf({ dragHandle: false })).toEqual([]);
    expect(handleOf({}, "dark")[0]!.style["background-color"]).toBe(ON_SURFACE_VARIANT_DARK);
  });

  test("hoists a sheet nested deep in the tree to the window, with the content left in place", () => {
    const nested = specWith({
      type: "box",
      children: [{ type: "card", children: [sheet()] }],
    });
    const still = renderPrototypeStill(nested);
    const window = windowOf(still.element);
    const [content, layer] = window.children as WebElement[];
    expect(byNode(content!, "bottomSheet")).toEqual([]);
    expect(textOf(content!)).toBe("Body");
    expect(byNode(layer!, "bottomSheet")).toHaveLength(1);
    // Hoisted out of the box grid, the sheet takes no grid cell.
    expect(byNode(layer!, "bottomSheet")[0]!.style).not.toHaveProperty("grid-area");
  });

  test("layers follow tree order, a sheet before the sheets inside it", () => {
    const inner = sheet({ testTag: "inner", child: { type: "text", text: "Inner" } });
    const outer = sheet({ testTag: "outer", child: { type: "column", children: [inner] } });
    const later = sheet({ testTag: "later", child: { type: "text", text: "Later" } });
    const spec = {
      id: "s",
      state: { open: true },
      root: { type: "column", children: [outer, later] },
    };
    const layers = windowOf(renderPrototypeStill(spec).element).children.slice(1) as WebElement[];
    expect(layers.map((layer) => byPart(layer, "sheet")[0]!.attrs["data-testid"])).toEqual([
      "outer",
      "inner",
      "later",
    ]);
  });

  test("opens only when its key holds exactly the boolean equals value", () => {
    const open = (state: Spec, equals: boolean) =>
      byNode(
        renderPrototypeStill(specWith(sheet({ openWhen: { key: "open", equals } }), { state }))
          .element,
        "bottomSheet",
      ).length === 1;
    expect(open({ open: true }, true)).toBe(true);
    expect(open({ open: false }, false)).toBe(true);
    expect(open({ open: false }, true)).toBe(false);
    expect(open({ open: "true" }, true)).toBe(false);
    // A missing key is not false: the devices compare the stored value, so the sheet stays shut.
    expect(open({}, false)).toBe(false);
    // A hidden sheet draws nothing even while open.
    const hidden = specWith(sheet({ visibleWhen: { key: "open", equals: false } }));
    expect(byPart(renderPrototypeStill(hidden).element, "scrim")).toEqual([]);
  });

  test("sizes the sheet from its first detent, capped at the window", () => {
    const heightOf = (detents: unknown[]) =>
      byNode(renderPrototypeStill(specWith(sheet({ detents }))).element, "bottomSheet")[0]!.style
        .height;
    expect(heightOf(["half", "full"])).toBe("50%");
    expect(heightOf(["full", "half"])).toBe("100%");
    expect(heightOf([{ dp: 240 }, "full"])).toBe("min(240px, 100%)");
  });

  test("resolves an authored scrim like a scrim slot: the scrim role dims, others are exact", () => {
    const scrimOf = (scrim: unknown, mode?: "dark") =>
      byPart(
        renderPrototypeStill(specWith(sheet({ scrim })), mode ? { mode } : {}).element,
        "scrim",
      )[0]!.style["background-color"];
    expect(scrimOf("scrim")).toBe(DEFAULT_SCRIM);
    expect(scrimOf("#80FF0000")).toBe("rgba(255,0,0,0.502)");
    expect(scrimOf("primary")).toBe(PRIMARY);
    const pair = { light: "#33000000", dark: "scrim" };
    expect(scrimOf(pair)).toBe("rgba(0,0,0,0.2)");
    expect(scrimOf(pair, "dark")).toBe(DEFAULT_SCRIM);
  });

  test("the surface follows dark mode, and an authored background or gradient replaces it", () => {
    const sheetOf = (extra: Spec, mode?: "dark") =>
      byNode(
        renderPrototypeStill(specWith(sheet(extra)), mode ? { mode } : {}).element,
        "bottomSheet",
      )[0]!;
    expect(sheetOf({}, "dark").style["background-color"]).toBe(SURFACE_DARK);
    expect(byPart(sheetOf({}, "dark"), "handle")).toHaveLength(1);
    expect(sheetOf({ style: { background: "primary" } }).style["background-color"]).toBe(PRIMARY);
    const gradient = { type: "linear", angle: 90, stops: ["#FF0000", "#0000FF"] };
    expect(sheetOf({ style: { gradient } }).style).not.toHaveProperty("background-color");
  });

  test("covers a sheet window's own region, not the whole screen", () => {
    const placed = (state: Spec) =>
      renderPrototypeStill(
        specWith(sheet(), { state, window: { placement: { type: "sheet", height: 400 } } }),
      ).element;
    const region = windowOf(placed({ open: true })).children[0] as WebElement;
    expect(region.style.position).toBe("relative");
    expect(byPart(region.children.at(-1) as WebElement, "scrim")).toHaveLength(1);
    // Without an open sheet the window is drawn exactly as before.
    const closed = windowOf(placed({ open: false })).children[0] as WebElement;
    expect(closed.style).not.toHaveProperty("position");
  });

  test("renders deterministically", () => {
    const spec = specWith(sheet());
    expect(toHtml(renderPrototypeStill(spec).element)).toBe(
      toHtml(renderPrototypeStill(spec).element),
    );
  });
});
