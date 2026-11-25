import { describe, expect, test } from "bun:test";
import {
  ANCHORED_LAYERS_PAGE_CSS,
  webAnchorName,
  webMenuParentPath,
} from "../../../../src/features/prototype/web/webMenu";
import type { WebChild, WebElement } from "../../../../src/features/prototype/web/webNodes";
import { renderPrototypeStill } from "../../../../src/features/prototype/web/webStill";

function find(node: WebChild, predicate: (element: WebElement) => boolean): WebElement[] {
  if (typeof node === "string") {
    return [];
  }
  return [...(predicate(node) ? [node] : []), ...node.children.flatMap((c) => find(c, predicate))];
}
const part = (root: WebElement, name: string) =>
  find(root, (element) => element.attrs["data-part"] === name);

const spec = (root: unknown, state: Record<string, unknown> = { open: true }) => ({
  id: "layers",
  window: { placement: { type: "fullscreen" } },
  state,
  root,
});
const menu = {
  type: "menu",
  testTag: "overflow",
  openWhen: { key: "open", equals: true },
  items: [
    { label: "Share", icon: "share", trailingText: "Send" },
    { type: "divider" },
    { label: "Unavailable", enabled: false },
  ],
};
const menuSpec = (state?: Record<string, unknown>) =>
  spec(
    {
      type: "column",
      children: [
        { type: "row", children: [{ type: "text", text: "Title" }, menu] },
        { type: "text", text: "Body" },
      ],
    },
    state,
  );

describe("web menu layer (#16536)", () => {
  test("a closed menu draws nothing, in its parent's flow or in the window", () => {
    const still = renderPrototypeStill(menuSpec({ open: false }), { frame: "pixel-9" });
    expect(part(still.element, "menu")).toEqual([]);
    expect(still.unsupportedNodes).toEqual([]);
  });

  test("an open menu anchors to its parent's bottom-end and falls back above, then clamped", () => {
    const still = renderPrototypeStill(menuSpec(), { frame: "pixel-9" });
    const [surface] = part(still.element, "menu");
    const name = webAnchorName("menu", "root.children[0]");
    expect(surface!.style).toMatchObject({
      position: "absolute",
      "position-anchor": name,
      top: "anchor(bottom)",
      "inset-inline-end": "anchor(end)",
      "position-try-fallbacks": "flip-block, --pa-menu-clamp",
      "min-width": "112px",
      "border-radius": "4px",
    });
    // The parent row, not the trigger sibling, carries the name, as Android anchors menus.
    const anchored = find(still.element, (element) => element.style["anchor-name"] === name);
    expect(anchored.map((element) => element.attrs["data-node"])).toEqual(["row"]);
    // The layer itself takes no box, so the surface's containing block stays the window.
    expect(part(still.element, "menuLayer")[0]!.style).toEqual({ display: "contents" });
    expect(ANCHORED_LAYERS_PAGE_CSS).toContain("@position-try --pa-menu-clamp{");
  });

  test("rows carry the icon, label and trailing text; a divider separates; disabled dims", () => {
    const still = renderPrototypeStill(menuSpec(), { frame: "pixel-9" });
    const rows = part(still.element, "item");
    expect(rows.map((row) => row.attrs["data-testid"])).toEqual(["overflow.0", "overflow.2"]);
    expect(rows[0]!.style).toMatchObject({ "min-height": "48px", padding: "0 16px", gap: "12px" });
    expect(part(rows[0]!, "trailing")).toHaveLength(1);
    expect(rows[1]!.style.opacity).toBe("0.38");
    expect(part(still.element, "divider")[0]!.style).toMatchObject({ height: "1px" });
  });

  test("the iOS skin draws the iOS renderer's raised panel", () => {
    const still = renderPrototypeStill(menuSpec(), { frame: "iphone-16" });
    expect(part(still.element, "menu")[0]!.style).toMatchObject({
      width: "min(280px, 100%)",
      "border-radius": "8px",
      "box-shadow": "0 0 3px rgba(0,0,0,0.2)",
    });
  });

  test("a menu's anchor is its parent's path", () => {
    expect(webMenuParentPath('root.screens["cart"].children[5]')).toBe('root.screens["cart"]');
    expect(webMenuParentPath("root")).toBe("root");
  });

  test("anchor names are short, valid dashed idents, stable per key", () => {
    const name = webAnchorName("id", "a b/<c>");
    expect(name).toMatch(/^--pa-id-[0-9a-f]{8}$/);
    expect(webAnchorName("id", "a b/<c>")).toBe(name);
    expect(webAnchorName("id", "other")).not.toBe(name);
  });
});

const tooltip = (fields: Record<string, unknown>) => ({
  type: "tooltip",
  testTag: "help",
  text: "Helpful hint",
  openWhen: { key: "open", equals: true },
  ...fields,
});
const tooltipSpec = (fields: Record<string, unknown>) =>
  spec({
    type: "column",
    children: [{ type: "button", id: "target", label: "Help" }, tooltip(fields)],
  });

describe("web tooltip layer (#16536)", () => {
  test("anchorTo names the target node, which carries the anchor name", () => {
    const still = renderPrototypeStill(tooltipSpec({ anchorTo: "target" }), { frame: "pixel-9" });
    const name = webAnchorName("id", "target");
    const anchored = find(still.element, (element) => element.style["anchor-name"] === name);
    expect(anchored.map((element) => element.attrs["data-node"])).toEqual(["button"]);
    const [bubble] = part(still.element, "tooltip");
    expect(bubble!.style).toMatchObject({
      "position-anchor": name,
      "position-area": "block-end",
      "margin-top": "8px",
      padding: "12px",
      "border-radius": "8px",
    });
    expect(part(still.element, "caret")[0]!.style).toMatchObject({
      "position-anchor": name,
      top: "anchor(bottom)",
      width: "12px",
      height: "12px",
    });
    // No spotlight unless the spec asks for one.
    expect(part(still.element, "spotlight")).toEqual([]);
  });

  test("the caret names the bubble's side of its target", () => {
    const area = (caret: string) =>
      part(
        renderPrototypeStill(tooltipSpec({ anchorTo: "target", caret }), { frame: "pixel-9" })
          .element,
        "tooltip",
      )[0]!.style["position-area"];
    expect(area("auto")).toBe("block-end");
    expect(area("top")).toBe("block-end");
    expect(area("bottom")).toBe("block-start");
    expect(area("start")).toBe("inline-end");
    expect(area("end")).toBe("inline-start");
  });

  test("a spotlight cuts the target, grown by its padding, out of a window-wide scrim", () => {
    const still = renderPrototypeStill(
      tooltipSpec({ anchorTo: "target", spotlight: { padding: 4 } }),
      { frame: "pixel-9" },
    );
    const [hole] = part(still.element, "spotlight");
    expect(hole!.attrs["data-testid"]).toBe("help.close");
    expect(hole!.style).toMatchObject({
      top: "calc(anchor(top) - 4px)",
      right: "calc(anchor(right) - 4px)",
      "border-radius": "12px",
    });
    expect(hole!.style["box-shadow"]).toMatch(/^0 0 0 9999px rgba\(/);
  });

  test("a bounds anchor places an anchor box at its window bounds, offset applied", () => {
    const anchor = {
      type: "bounds",
      bounds: { x: 10, y: 20, width: 30, height: 40 },
      offset: { x: 5, y: -5 },
    };
    const still = renderPrototypeStill(tooltipSpec({ anchor }), { frame: "pixel-9" });
    expect(part(still.element, "anchor")[0]!.style).toMatchObject({
      left: "15px",
      top: "15px",
      width: "30px",
      height: "40px",
    });
    expect(part(still.element, "tooltip")).toHaveLength(1);
  });

  test("an element anchor the still cannot place draws nothing, as on Android", () => {
    const anchor = { type: "element", selector: { text: "Help" } };
    const still = renderPrototypeStill(tooltipSpec({ anchor }), { frame: "pixel-9" });
    expect(part(still.element, "tooltip")).toEqual([]);
    expect(still.unsupportedNodes).toEqual([]);
  });

  test("the iOS skin draws the iOS bubble: 12 px corners, 280 px wide, no shadow", () => {
    const still = renderPrototypeStill(tooltipSpec({ anchorTo: "target" }), {
      frame: "iphone-16",
    });
    const style = part(still.element, "tooltip")[0]!.style;
    expect(style).toMatchObject({
      "border-radius": "12px",
      "max-width": "min(280px, calc(100% - 16px))",
    });
    expect(style).not.toHaveProperty("box-shadow");
  });
});
