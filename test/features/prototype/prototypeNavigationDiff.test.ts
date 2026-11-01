import { describe, expect, test } from "bun:test";
import {
  diffPrototypeNavigation,
  realNavigationGraphFrom,
} from "../../../src/features/prototype/prototypeNavigationDiff";
import { buildPrototypeScreenMap } from "../../../src/features/prototype/prototypeScreenMap";
import type { ExportedGraph } from "../../../src/utils/interfaces/NavigationGraph";

const button = (label: string, action: Record<string, unknown>, testTag?: string) => ({
  type: "button",
  label,
  ...(testTag ? { testTag } : {}),
  onTap: [action],
});

/** A stack with a home screen that pushes detail and settings, and a settings sheet. */
const spec = {
  id: "demo",
  root: {
    type: "stack",
    id: "nav",
    start: "home",
    screens: {
      home: {
        type: "column",
        testTag: "screen.home",
        children: [
          button("Open", { type: "push", stack: "nav", screen: "detail" }),
          button("Settings", { type: "push", stack: "nav", screen: "settings" }),
        ],
      },
      detail: { type: "column", children: [button("Back", { type: "pop", stack: "nav" })] },
      settings: { type: "text", text: "Settings" },
    },
  },
};

/** A captured-style real graph: Home and Detail exist, Settings does not, Cart is extra. */
const graph = (): ExportedGraph => ({
  appId: "com.example.app",
  currentScreen: "screen.home",
  nodes: ["screen.home", "DetailActivity", "CartActivity"].map((screenName) => ({
    screenName,
    firstSeenAt: 1,
    lastSeenAt: 2,
    visitCount: 1,
  })),
  edges: [
    {
      from: "screen.home",
      to: "DetailActivity",
      edgeType: "tool",
      timestamp: 3,
      interaction: { toolName: "tapOn", args: { text: "Open" }, timestamp: 3 },
    },
    { from: "DetailActivity", to: "screen.home", edgeType: "back", timestamp: 4 },
  ],
});

const diff = (mapping?: Record<string, string>, real: ExportedGraph = graph()) =>
  diffPrototypeNavigation(buildPrototypeScreenMap(spec), realNavigationGraphFrom(real), mapping);

describe("diffPrototypeNavigation", () => {
  test("matches by testTag first, then by normalized screen name", () => {
    expect(diff().matched).toEqual([
      { prototype: "stack:nav/home", real: "screen.home", by: "identifier" },
      { prototype: "stack:nav/detail", real: "DetailActivity", by: "name" },
    ]);
  });

  test("lists prototype screens with no real screen, and real screens not in the prototype", () => {
    const result = diff();
    expect(result.unmatchedPrototypeScreens).toEqual([
      { id: "stack:nav/settings", kind: "stackScreen", path: 'root.screens["settings"]' },
    ]);
    expect(result.unmatchedRealScreens).toEqual(["CartActivity"]);
  });

  test("classifies prototype transitions as observed, not observed, unmatched or dynamic", () => {
    const result = diff();
    expect(result.observedTransitions).toEqual([
      {
        from: "stack:nav/home",
        to: "stack:nav/detail",
        action: "push",
        real: { from: "screen.home", to: "DetailActivity" },
      },
    ]);
    expect(result.unobservedTransitions.map((t) => [t.from, t.to, t.reason])).toEqual([
      ["stack:nav/home", "stack:nav/settings", "unmatchedScreen"],
      ["stack:nav/detail", "back", "dynamicTarget"],
    ]);
  });

  test("a matched pair with no recorded real transition is notObserved", () => {
    const real = graph();
    real.edges = [];
    expect(diff(undefined, real).unobservedTransitions[0]).toMatchObject({
      to: "stack:nav/detail",
      reason: "notObserved",
      trigger: { label: "Open" },
    });
  });

  test("an explicit mapping wins over identifier and name matching, and can map the root", () => {
    const result = diff({ "stack:nav/settings": "CartActivity", root: "screen.home" });
    expect(result.matched).toContainEqual({
      prototype: "stack:nav/settings",
      real: "CartActivity",
      by: "mapping",
    });
    expect(result.matched).toContainEqual({
      prototype: "root",
      real: "screen.home",
      by: "mapping",
    });
    expect(result.unmatchedRealScreens).toEqual([]);
  });

  test("a mapping to a screen missing from the graph does not fall back to name matching", () => {
    const result = diff({ "stack:nav/detail": "NoSuchScreen" });
    expect(result.matched.map((m) => m.prototype)).toEqual(["stack:nav/home"]);
    expect(result.unmatchedPrototypeScreens).toContainEqual({
      id: "stack:nav/detail",
      kind: "stackScreen",
      path: 'root.screens["detail"]',
      reason: "mappedScreenMissing",
    });
  });

  test("mapping keys that name no prototype screen are reported, not silently dropped", () => {
    expect(diff({ "stack:nav/nope": "CartActivity" }).ignoredMappings).toEqual(["stack:nav/nope"]);
  });

  test("an unmapped root is left out of the screen lists", () => {
    const result = diff();
    expect(result.matched.some((m) => m.prototype === "root")).toBe(false);
    expect(result.unmatchedPrototypeScreens.some((s) => s.id === "root")).toBe(false);
  });

  test("names that end in a suffix word keep their full form, and keys keep their slashes", () => {
    const stack = {
      id: "words",
      root: {
        type: "stack",
        id: "nav",
        start: "Overview",
        screens: {
          Overview: { type: "text", text: "o" },
          Preview: { type: "text", text: "p" },
          "account/profile": { type: "text", text: "a" },
        },
      },
    };
    const real: ExportedGraph = {
      ...graph(),
      nodes: ["OverviewActivity", "PreviewScreen", "Profile", "account/profile"].map(
        (screenName) => ({ screenName, firstSeenAt: 1, lastSeenAt: 1, visitCount: 1 }),
      ),
      edges: [],
    };
    const result = diffPrototypeNavigation(
      buildPrototypeScreenMap(stack),
      realNavigationGraphFrom(real),
    );
    expect(result.matched).toEqual([
      { prototype: "stack:nav/Overview", real: "OverviewActivity", by: "name" },
      { prototype: "stack:nav/Preview", real: "PreviewScreen", by: "name" },
      { prototype: "stack:nav/account/profile", real: "account/profile", by: "name" },
    ]);
    expect(result.unmatchedRealScreens).toEqual(["Profile"]);
  });

  test("non-Latin names keep their letters, and an empty name never matches", () => {
    const pager = (labels: string[]) => ({
      id: "tabs",
      root: {
        type: "column",
        children: [
          {
            type: "pager",
            id: "main",
            children: labels.map((text) => ({ type: "text", text })),
          },
          {
            type: "bottomNav",
            pager: "main",
            items: labels.map((label) => ({ label, icon: "home" })),
          },
        ],
      },
    });
    const real = (names: string[]): ExportedGraph => ({
      ...graph(),
      nodes: names.map((screenName) => ({
        screenName,
        firstSeenAt: 1,
        lastSeenAt: 1,
        visitCount: 1,
      })),
      edges: [],
    });
    const result = diffPrototypeNavigation(
      buildPrototypeScreenMap(pager(["首页", "设置", "!!!"])),
      realNavigationGraphFrom(real(["个人资料", "设置Screen", "---"])),
    );
    expect(result.matched).toEqual([{ prototype: "pager:main/1", real: "设置Screen", by: "name" }]);
    expect(result.unmatchedPrototypeScreens.map((s) => s.id)).toEqual([
      "pager:main/0",
      "pager:main/2",
    ]);
    expect(result.unmatchedRealScreens).toEqual(["个人资料", "---"]);
  });

  test("pager pages match their tab label", () => {
    const tabs = {
      id: "tabs",
      root: {
        type: "column",
        children: [
          {
            type: "pager",
            id: "main",
            children: [
              { type: "text", text: "a" },
              { type: "text", text: "b" },
            ],
          },
          {
            type: "bottomNav",
            pager: "main",
            items: [
              { label: "Feed", icon: "home" },
              { label: "Profile", icon: "person" },
            ],
          },
        ],
      },
    };
    const real = graph();
    real.nodes = [{ screenName: "ProfileScreen", firstSeenAt: 1, lastSeenAt: 1, visitCount: 1 }];
    real.edges = [];
    const result = diffPrototypeNavigation(
      buildPrototypeScreenMap(tabs),
      realNavigationGraphFrom(real),
    );
    expect(result.matched).toEqual([
      { prototype: "pager:main/1", real: "ProfileScreen", by: "name" },
    ]);
  });
});
