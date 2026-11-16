import { describe, expect, test } from "bun:test";
import {
  lintPrototypeTopAppBarInsets,
  prototypeTopAppBarInsetWarnings,
} from "../../../src/features/prototype/prototypeTopAppBarInsetLint";

const TOP = { edges: ["top"], types: ["systemBars"] };
const bar = (extra: Record<string, unknown> = {}) => ({
  type: "topAppBar",
  title: "Feed",
  ...extra,
});
const spec = (root: unknown, window: Record<string, unknown> = {}, extra = {}) => ({
  id: "inset",
  window: { placement: { type: "fullscreen" }, ...window },
  root,
  ...extra,
});

describe("prototype topAppBar top inset lint (#18394)", () => {
  test("a bar that declares top safeAreaPadding is not reported", () => {
    expect(
      lintPrototypeTopAppBarInsets(
        spec({ type: "column", children: [bar({ safeAreaPadding: TOP })] }),
      ),
    ).toEqual([]);
  });

  test("a bar under an ancestor with top safeAreaPadding is not reported", () => {
    const root = {
      type: "column",
      safeAreaPadding: { edges: ["top", "bottom"], types: ["systemBars"] },
      children: [{ type: "column", children: [bar()] }],
    };
    expect(lintPrototypeTopAppBarInsets(spec(root))).toEqual([]);
  });

  test("padding on other edges only does not clear the bar", () => {
    const root = {
      type: "column",
      safeAreaPadding: { edges: ["bottom"], types: ["systemBars"] },
      children: [bar()],
    };
    expect(lintPrototypeTopAppBarInsets(spec(root))).toEqual(["root.children[0]"]);
  });

  test("sheet and floating placements, and an explicit host dismiss bar, are exempt", () => {
    const root = { type: "column", children: [bar()] };
    expect(
      lintPrototypeTopAppBarInsets(
        spec(root, { placement: { type: "sheet", edge: "bottom", height: 300 } }),
      ),
    ).toEqual([]);
    expect(
      lintPrototypeTopAppBarInsets(
        spec(root, { placement: { type: "floating", gravity: "center" } }),
      ),
    ).toEqual([]);
    expect(lintPrototypeTopAppBarInsets(spec(root, { chrome: "bar" }))).toEqual([]);
    expect(lintPrototypeTopAppBarInsets(spec(root, { persistence: "device" }))).toEqual([]);
    expect(
      lintPrototypeTopAppBarInsets(spec(root, { persistence: "device", chrome: "none" })),
    ).toEqual(["root.children[0]"]);
  });

  test("a missing inset is a warning naming the node path, per screen", () => {
    const root = {
      type: "stack",
      screens: {
        feed: { type: "column", children: [bar()] },
        inbox: { type: "column", safeAreaPadding: TOP, children: [bar()] },
      },
    };
    const warnings = prototypeTopAppBarInsetWarnings(spec(root));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toStartWith(
      'root.screens["feed"].children[0]: topAppBar in a fullscreen window',
    );
    expect(warnings[0]).toContain("safeAreaPadding");
  });

  test("a bar inside a component is reported at the authored path", () => {
    const authored = spec(
      { type: "column", children: [{ type: "use", component: "header" }] },
      {},
      { components: { header: { root: bar() } } },
    );
    const [warning] = prototypeTopAppBarInsetWarnings(authored);
    expect(warning).toStartWith(
      "root.children[0] (use header) → components.header.root: topAppBar",
    );
  });
});
