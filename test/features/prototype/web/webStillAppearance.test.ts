import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parsePrototypeHex } from "../../../../src/features/prototype/prototypeContrast";
import type { WebChild, WebElement } from "../../../../src/features/prototype/web/webNodes";
import { renderPrototypeStill } from "../../../../src/features/prototype/web/webStill";
import { resolveWebStillAppearance } from "../../../../src/features/prototype/web/webStillAppearance";

const PURPLE = parsePrototypeHex("#6200EE")!;
const PALE = parsePrototypeHex("#FAFAFA")!;

function find(node: WebChild, predicate: (element: WebElement) => boolean): WebElement[] {
  if (typeof node === "string") {
    return [];
  }
  return [
    ...(predicate(node) ? [node] : []),
    ...node.children.flatMap((child) => find(child, predicate)),
  ];
}

const byTag = (element: WebElement, tag: string) =>
  find(element, (node) => node.attrs["data-testid"] === tag)[0]!;
const screenOf = (element: WebElement) =>
  find(element, (node) => node.attrs["data-chrome"] === "screen")[0]!;

describe("resolveWebStillAppearance (#16654)", () => {
  test("an explicit mode wins over every other step", () => {
    const spec = { theme: { mode: "light", colors: { background: "#000000" } } };
    expect(resolveWebStillAppearance(spec, PURPLE, "dark")).toEqual({
      mode: "light",
      source: "explicit",
    });
  });

  test("mode system skips the role and authored steps", () => {
    const spec = { theme: { mode: "system", colors: { background: "#000000" } } };
    expect(resolveWebStillAppearance(spec, undefined, "light")).toEqual({
      mode: "light",
      source: "system",
    });
  });

  test("a flat background override, else surface, decides by its luminance", () => {
    expect(
      resolveWebStillAppearance({ theme: { colors: { background: "#101010" } } }, PALE, "light"),
    ).toEqual({ mode: "dark", source: "roleLuminance" });
    expect(
      resolveWebStillAppearance({ theme: { colors: { surface: "#F0F0F0" } } }, undefined, "dark"),
    ).toEqual({ mode: "light", source: "roleLuminance" });
  });

  test("per-mode role maps never decide the mode", () => {
    const spec = { theme: { colors: { dark: { background: "#000000" } } } };
    expect(resolveWebStillAppearance(spec, undefined, "light").source).toBe("system");
  });

  test("the authored background decides next and is painted over a matching scheme", () => {
    expect(resolveWebStillAppearance({}, PURPLE, "light")).toEqual({
      mode: "dark",
      source: "authoredBackground",
      surface: PURPLE,
    });
  });

  test("an authored colour of the other polarity is not painted", () => {
    const spec = { theme: { mode: "light" } };
    expect(resolveWebStillAppearance(spec, PURPLE, "light").surface).toBeUndefined();
  });

  test("with nothing authored the caller's mode is the system setting", () => {
    expect(resolveWebStillAppearance({}, undefined, "dark")).toEqual({
      mode: "dark",
      source: "system",
    });
  });
});

describe("prototype web still mode resolution (#16654)", () => {
  const column = (children: unknown[], style: Record<string, unknown> = {}) => ({
    type: "column",
    testTag: "root",
    style,
    children,
  });
  const text = (tag: string, style: Record<string, unknown> = {}, extra = {}) => ({
    type: "text",
    text: tag,
    testTag: tag,
    style,
    ...extra,
  });

  test("the corner-tokens fixture resolves dark with the authored surface painted", () => {
    const spec: unknown = JSON.parse(
      readFileSync(
        join(
          import.meta.dir,
          "../../../fixtures/prototype-spec/valid/color-role-and-corner-tokens.json",
        ),
        "utf8",
      ),
    );
    const element = renderPrototypeStill(spec, { frame: "pixel-9" }).element;
    const root = find(element, (node) => node.attrs["data-node"] === "column")[0]!;
    expect(root.style["background-color"]).toBe("rgba(98,0,238,1)");
    expect(screenOf(element).style["background-color"]).toBe("rgba(98,0,238,1)");
    expect(JSON.stringify(root.style)).toContain("rgba(147,143,153,1)");
  });

  test("a role or pair background is skipped; a hidden child is passed over", () => {
    const spec = {
      id: "chain",
      root: column(
        [
          text("hidden", { background: "#FFFFFF" }, { visibleWhen: { key: "open", equals: true } }),
          text("first", { background: "#202020" }),
        ],
        { background: { light: "#FFFFFF", dark: "#000000" } },
      ),
      state: { open: false },
    };
    const element = renderPrototypeStill(spec, { frame: "pixel-9", mode: "light" }).element;
    expect(screenOf(element).style["background-color"]).toBe("rgba(32,32,32,1)");
  });

  test("a pager's current page continues the chain", () => {
    const spec = {
      id: "pager",
      state: { page: 1 },
      root: {
        type: "pager",
        stateKey: "page",
        children: [
          text("light", { background: "#FFFFFF" }),
          text("dark", { background: "#111111" }),
        ],
      },
    };
    const element = renderPrototypeStill(spec, { frame: "pixel-9", mode: "light" }).element;
    expect(screenOf(element).style["background-color"]).toBe("rgba(17,17,17,1)");
  });

  test("a translucent background does not decide the mode", () => {
    const spec = { id: "veil", root: column([], { background: "#80000000" }) };
    const element = renderPrototypeStill(spec, { frame: "pixel-9", mode: "light" }).element;
    expect(screenOf(element).style["background-color"]).toBe("rgba(254,247,255,1)");
  });

  test("a role override wins over the painted authored surface", () => {
    const spec = {
      id: "override",
      theme: { colors: { surface: "#222222" } },
      root: column([text("body", { background: "surface" })], { background: "#111111" }),
    };
    const element = renderPrototypeStill(spec, { frame: "pixel-9" }).element;
    expect(byTag(element, "body").style["background-color"]).toBe("rgba(34,34,34,1)");
    expect(screenOf(element).style["background-color"]).toBe("rgba(17,17,17,1)");
  });

  test("a repeat's template decides only through the rows it draws", () => {
    const repeated = (items: unknown[]) => ({
      id: "repeat",
      root: {
        type: "column",
        repeat: { as: "item", items },
        children: [text("row", { background: "#000000" })],
      },
    });
    const empty = renderPrototypeStill(repeated([]), { frame: "pixel-9", mode: "light" });
    expect(screenOf(empty.element).style["background-color"]).toBe("rgba(254,247,255,1)");
    const drawn = renderPrototypeStill(repeated([{ id: "a" }]), {
      frame: "pixel-9",
      mode: "light",
    });
    expect(screenOf(drawn.element).style["background-color"]).toBe("rgba(0,0,0,1)");
  });

  test("a scroll's child continues the chain (#16670)", () => {
    const spec = {
      id: "scroll",
      root: { type: "scroll", child: column([], { background: "#111111" }) },
    };
    const element = renderPrototypeStill(spec, { frame: "pixel-9", mode: "light" }).element;
    expect(screenOf(element).style["background-color"]).toBe("rgba(17,17,17,1)");
  });

  test("a stack continues through the screen it draws (#16670)", () => {
    const spec = {
      id: "stack",
      root: {
        type: "stack",
        id: "nav",
        start: "home",
        screens: {
          home: column([], { background: "#111111" }),
          detail: column([], { background: "#FAFAFA" }),
        },
      },
    };
    const start = renderPrototypeStill(spec, { frame: "pixel-9", mode: "light" });
    expect(screenOf(start.element).style["background-color"]).toBe("rgba(17,17,17,1)");
    const chosen = renderPrototypeStill(spec, { frame: "pixel-9", mode: "dark", screen: "detail" });
    expect(screenOf(chosen.element).style["background-color"]).toBe("rgba(250,250,250,1)");
    expect(chosen.stack?.screen).toBe("detail");
  });

  test("a nested stack draws its own start, not the chosen screen (#16670)", () => {
    const inner = {
      type: "stack",
      id: "inner",
      start: "a",
      screens: {
        a: column([], { background: "#111111" }),
        b: column([], { background: "#FAFAFA" }),
      },
    };
    const spec = {
      id: "nested",
      root: { type: "stack", id: "outer", start: "b", screens: { b: inner } },
    };
    const element = renderPrototypeStill(spec, { frame: "pixel-9", mode: "light", screen: "b" });
    expect(screenOf(element.element).style["background-color"]).toBe("rgba(17,17,17,1)");
  });

  test("a closed sheet is not the first drawn child; an open one is (#16670)", () => {
    const sheeted = (open: boolean) => ({
      id: "sheet",
      state: { open },
      root: column([
        {
          type: "bottomSheet",
          openWhen: { key: "open", equals: true },
          style: { background: "#000000" },
          child: text("inside"),
        },
        text("body", { background: "#FAFAFA" }),
      ]),
    });
    const closed = renderPrototypeStill(sheeted(false), { frame: "pixel-9", mode: "dark" });
    expect(screenOf(closed.element).style["background-color"]).toBe("rgba(250,250,250,1)");
    const open = renderPrototypeStill(sheeted(true), { frame: "pixel-9", mode: "light" });
    expect(screenOf(open.element).style["background-color"]).toBe("rgba(0,0,0,1)");
  });

  test("a closed dialog or snackbar is not the first drawn child (#16670)", () => {
    const layered = (layer: Record<string, unknown>) => ({
      id: "layer",
      state: { open: false },
      root: {
        type: "scroll",
        child: column([
          { ...layer, openWhen: { key: "open", equals: true }, style: { background: "#000000" } },
          text("body", { background: "#FAFAFA" }),
        ]),
      },
    });
    for (const layer of [
      { type: "dialog", title: "Delete?", confirm: { label: "Delete" } },
      { type: "snackbar", text: "Saved" },
    ]) {
      const element = renderPrototypeStill(layered(layer), { frame: "pixel-9", mode: "dark" });
      expect(screenOf(element.element).style["background-color"]).toBe("rgba(250,250,250,1)");
    }
  });
});
