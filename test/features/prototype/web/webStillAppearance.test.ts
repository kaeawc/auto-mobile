import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parsePrototypeHex,
  prototypeRolePalette,
} from "../../../../src/features/prototype/prototypeContrast";
import type { WebChild, WebElement } from "../../../../src/features/prototype/web/webNodes";
import {
  childEntries,
  preparedNode,
  type WebRenderScope,
} from "../../../../src/features/prototype/web/webRender";
import { renderPrototypeStill } from "../../../../src/features/prototype/web/webStill";
import {
  resolveWebStillAppearance,
  webAuthoredBackground,
} from "../../../../src/features/prototype/web/webStillAppearance";

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
});

describe("webAuthoredBackground work (#17267)", () => {
  const scope: WebRenderScope = {
    style: { mode: "light", palette: prototypeRolePalette({}, "light"), parentAxis: "column" },
    condition: { state: {}, platform: "android" },
    data: {},
    spec: {},
    format: { locale: "en-US", timeZone: "UTC", nowMs: 0 },
    instances: [],
    inBox: false,
    unsupported: [],
    screenWidth: 412,
    screenHeight: 915,
    layers: [],
  };

  /** A leaf whose `style` getter counts every read: each preparation reads it a fixed number of times. */
  function countedLeaf(): { node: Record<string, unknown>; reads: () => number } {
    let reads = 0;
    const node: Record<string, unknown> = { type: "box", testTag: "{item.id}" };
    Object.defineProperty(node, "style", {
      enumerable: true,
      get: () => {
        reads += 1;
        return { background: "#101010" };
      },
    });
    return { node, reads: () => reads };
  }

  test("each node on a repeat-bound leading chain is prepared once", () => {
    const leaf = countedLeaf();
    const root = {
      type: "column",
      repeat: { as: "item", items: [{ id: "a" }, { id: "b" }] },
      children: [leaf.node],
    };
    // One preparation of the leaf in the first row's scope, exactly as the walk reaches it.
    const prepared = preparedNode(root, scope, "root")!;
    const first = childEntries(prepared.styled, prepared.scope, "root")[0]!;
    const before = leaf.reads();
    preparedNode(first.node, first.scope, first.path);
    const once = leaf.reads() - before;
    expect(once).toBeGreaterThan(0);

    const start = leaf.reads();
    expect(webAuthoredBackground(root, scope, "root")).toEqual(parsePrototypeHex("#101010"));
    expect(leaf.reads() - start).toBe(once);
  });
});
