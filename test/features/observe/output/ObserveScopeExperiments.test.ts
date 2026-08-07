import { describe, expect, test } from "bun:test";
import type { ObserveResult } from "../../../../src/models/ObserveResult";
import type { ViewHierarchyNode } from "../../../../src/models/ViewHierarchyResult";
import {
  applyObserveScopeExperiments,
  buildObserveScopeConfig,
  readBounds,
  scopeToFocus,
  scopeToRegion,
  toOverview,
} from "../../../../src/features/observe/output/ObserveScopeExperiments";

/**
 * Unit tests for the `observe` progressive-disclosure scoping experiments
 * (issue #4344). Each transform is PURE and OUTPUT-ONLY: it returns a deep copy
 * and never mutates the caller's `ObserveResult`. Fixtures are hand-built so the
 * suite stays well under the 100ms budget.
 */

interface Node {
  "resource-id"?: string;
  text?: string;
  class?: string;
  "content-desc"?: string;
  scrollable?: boolean | string;
  clickable?: boolean | string;
  bounds?: { left: number; top: number; right: number; bottom: number } | number[];
  node?: Node[];
}

const SYSUI = "com.android.systemui";
const APP = "com.example.app";
// Package-qualified resource-ids — the app-vs-chrome signal that SURVIVES
// `cleanNodeProperties` (per-node `package` does not). System chrome carries
// `com.android.systemui:id/...`; app nodes carry `com.example.app:id/...`; app
// leaves (list items) carry NO id, as on real Compose/list surfaces.
const STATUS_BAR = `${SYSUI}:id/status_bar`;
const NAV_BAR = `${SYSUI}:id/navigation_bar`;
const HEADER = `${APP}:id/header`;
const LIST = `${APP}:id/list`;

/**
 * An Android-shaped tree: a container root with system chrome (status/nav bars,
 * `com.android.systemui`) flanking the foreground app's own subtree. App leaf
 * rows deliberately carry NO resource-id, so FOCUS must keep them (it only drops
 * identifiable FOREIGN packages, never id-less content).
 */
function androidFixture(): ObserveResult {
  const root: Node = {
    class: "FrameLayout",
    bounds: { left: 0, top: 0, right: 1080, bottom: 2400 },
    node: [
      {
        "resource-id": STATUS_BAR,
        "bounds": { left: 0, top: 0, right: 1080, bottom: 80 },
      },
      {
        class: "LinearLayout",
        bounds: { left: 0, top: 80, right: 1080, bottom: 2300 },
        node: [
          {
            "resource-id": HEADER,
            "text": "Title",
            "bounds": { left: 0, top: 80, right: 1080, bottom: 200 },
          },
          {
            "resource-id": LIST,
            "scrollable": true,
            "bounds": { left: 0, top: 200, right: 1080, bottom: 2200 },
            "node": [
              { text: "Item 1", bounds: { left: 0, top: 200, right: 1080, bottom: 400 } },
              { text: "Item 2", bounds: { left: 0, top: 400, right: 1080, bottom: 600 } },
            ],
          },
          {
            class: "View",
            bounds: { left: 0, top: 2200, right: 1080, bottom: 2300 },
          },
        ],
      },
      {
        "resource-id": NAV_BAR,
        "bounds": { left: 0, top: 2300, right: 1080, bottom: 2400 },
      },
    ],
  };

  return {
    updatedAt: 0,
    screenSize: { width: 1080, height: 2400 },
    systemInsets: { top: 80, bottom: 100, left: 0, right: 0 },
    activeWindow: { appId: APP } as ObserveResult["activeWindow"],
    viewHierarchy: {
      packageName: APP,
      hierarchy: { node: root as unknown as ViewHierarchyNode },
    },
    elements: {
      clickable: [{ "resource-id": HEADER, "bounds": { left: 0, top: 80, right: 1080, bottom: 200 } } as never],
      scrollable: [{ "resource-id": LIST, "bounds": { left: 0, top: 200, right: 1080, bottom: 2200 } } as never],
      text: [
        { "resource-id": `${SYSUI}:id/clock`, "bounds": { left: 0, top: 0, right: 1080, bottom: 80 } } as never, // chrome
        { "bounds": { left: 0, top: 400, right: 1080, bottom: 600 } } as never, // Item 2 (app, no id)
      ],
      media: [],
    },
  };
}

function toNodeArray(node: unknown): Node[] {
  if (!node) {
    return [];
  }
  return (Array.isArray(node) ? node : [node]) as Node[];
}

function countNodes(node: unknown): number {
  return toNodeArray(node).reduce((sum, n) => sum + 1 + countNodes(n.node), 0);
}

function roots(obs: ObserveResult): Node[] {
  return toNodeArray(obs.viewHierarchy?.hierarchy?.node);
}

function findById(obs: ObserveResult, id: string): Node | undefined {
  let found: Node | undefined;
  const walk = (nodes: Node[]): void => {
    for (const n of nodes) {
      if (n["resource-id"] === id) {
        found = n;
        return;
      }
      walk(toNodeArray(n.node));
    }
  };
  walk(roots(obs));
  return found;
}

function resourceIds(obs: ObserveResult): string[] {
  const out: string[] = [];
  const walk = (nodes: Node[]): void => {
    for (const n of nodes) {
      if (n["resource-id"]) {
        out.push(n["resource-id"]);
      }
      walk(toNodeArray(n.node));
    }
  };
  walk(roots(obs));
  return out;
}

describe("readBounds", () => {
  test("reads the object shape", () => {
    expect(readBounds({ left: 1, top: 2, right: 3, bottom: 4 })).toEqual({ left: 1, top: 2, right: 3, bottom: 4 });
  });
  test("reads the compacted tuple shape", () => {
    expect(readBounds([1, 2, 3, 4])).toEqual({ left: 1, top: 2, right: 3, bottom: 4 });
  });
  test("returns null for unreadable values", () => {
    expect(readBounds(undefined)).toBeNull();
    expect(readBounds([1, 2, 3])).toBeNull();
    expect(readBounds({ left: 1 })).toBeNull();
    expect(readBounds("[0,0][1,1]")).toBeNull();
  });
});

describe("buildObserveScopeConfig", () => {
  const allFlags = { focus: true, overview: true, region: true };

  test("intersects per-call scope with flags (anchor + box)", () => {
    const cfg = buildObserveScopeConfig(allFlags, {
      focus: { resourceId: "list" },
      region: { x1: 0, y1: 0, x2: 1, y2: 0.5 },
      overview: true,
    });
    expect(cfg.focus).toBe(true);
    expect(cfg.focusAnchor).toEqual({ resourceId: "list" });
    expect(cfg.region).toBe(true);
    expect(cfg.regionBox).toEqual({ x1: 0, y1: 0, x2: 1, y2: 0.5 });
    expect(cfg.overview).toBe(true);
  });

  test("focus:true / region:true request the flag defaults (no anchor / no box)", () => {
    const cfg = buildObserveScopeConfig(allFlags, { focus: true, region: true });
    expect(cfg.focus).toBe(true);
    expect(cfg.focusAnchor).toBeUndefined(); // foreground app
    expect(cfg.region).toBe(true);
    expect(cfg.regionBox).toBeUndefined(); // content rect
    expect(cfg.overview).toBe(false);
  });

  test("a dimension the call did not request is off even when its flag is on", () => {
    const cfg = buildObserveScopeConfig(allFlags, { region: { x1: 0, y1: 0, x2: 1, y2: 1 } });
    expect(cfg.focus).toBe(false);
    expect(cfg.overview).toBe(false);
    expect(cfg.region).toBe(true);
  });

  test("a dimension the flag disabled is off even when the call requested it", () => {
    const cfg = buildObserveScopeConfig(
      { focus: false, overview: false, region: false },
      { focus: { resourceId: "x" }, region: true, overview: true }
    );
    expect(cfg.focus).toBe(false);
    expect(cfg.region).toBe(false);
    expect(cfg.overview).toBe(false);
    expect(cfg.gatedOff).toEqual(["focus", "region", "overview"]);
  });

  test("no scope input yields an all-off config", () => {
    const cfg = buildObserveScopeConfig(allFlags, undefined);
    expect(cfg.focus).toBe(false);
    expect(cfg.region).toBe(false);
    expect(cfg.overview).toBe(false);
  });
});

describe("scopeToFocus", () => {
  test("foreground-app scoping drops identifiable foreign chrome (by resource-id package)", () => {
    const obs = androidFixture();
    const { result, focus } = scopeToFocus(obs);
    expect(focus).toEqual({ by: "foreground-app", matched: true, packageName: APP });
    const ids = resourceIds(result);
    expect(ids.some(id => id.startsWith(SYSUI))).toBe(false); // status/nav bars gone
    expect(ids).toContain(HEADER);
    expect(ids).toContain(LIST);
  });

  test("foreground-app scoping keeps id-less app leaves (never drops content for lacking an id)", () => {
    const obs = androidFixture();
    const { result } = scopeToFocus(obs);
    // The two id-less list rows and the anonymous View survive.
    const texts: string[] = [];
    const walk = (nodes: Node[]): void => {
      for (const n of nodes) { if (n.text) { texts.push(n.text); } walk(toNodeArray(n.node)); }
    };
    walk(roots(result));
    expect(texts).toContain("Item 1");
    expect(texts).toContain("Item 2");
  });

  test("foreground-app scoping filters elements with a foreign package resource-id", () => {
    const obs = androidFixture();
    const { result } = scopeToFocus(obs);
    // The com.android.systemui:id/clock text element drops; the id-less Item 2 stays.
    expect(result.elements?.text).toHaveLength(1);
    expect(result.elements?.clickable).toHaveLength(1); // app header element kept
  });

  test("foreground-app scoping KEEPS android: framework ids (app content, not chrome)", () => {
    const obs = androidFixture();
    // android:id/content is the setContentView host in every app window; an
    // AlertDialog's buttons are android:id/button1 etc. All belong to app content.
    roots(obs)[0].node!.push({
      "resource-id": "android:id/content",
      "bounds": { left: 0, top: 300, right: 1080, bottom: 500 },
      "node": [
        { "resource-id": `${APP}:id/ok`, "text": "OK", "bounds": { left: 0, top: 300, right: 200, bottom: 500 } },
        { "resource-id": "android:id/button1", "text": "Cancel", "bounds": { left: 200, top: 300, right: 400, bottom: 500 } },
      ],
    });
    const ids = resourceIds(scopeToFocus(obs).result);
    expect(ids).toContain("android:id/content"); // framework host kept
    expect(ids).toContain("android:id/button1"); // dialog button kept
    expect(ids).toContain(`${APP}:id/ok`); // app child under a framework host kept
    expect(ids.some(id => id.startsWith(SYSUI))).toBe(false); // real chrome still dropped
  });

  test("foreground-app scoping drops a dotted foreign IME package subtree", () => {
    const obs = androidFixture();
    roots(obs)[0].node!.push({
      "resource-id": "com.google.android.inputmethod.latin:id/keyboard",
      "bounds": { left: 0, top: 1800, right: 1080, bottom: 2300 },
    });
    const ids = resourceIds(scopeToFocus(obs).result);
    expect(ids.some(id => id.startsWith("com.google.android.inputmethod"))).toBe(false);
  });

  test("foreground-app scoping is a no-op on iOS-style colon identifiers (undotted prefix)", () => {
    const iosRoot: Node = {
      class: "XCUIElementTypeApplication",
      node: [
        { "resource-id": "row:0", "text": "First", "bounds": { left: 0, top: 0, right: 400, bottom: 100 } },
        { "resource-id": "section:2:cell:1", "text": "Second", "bounds": { left: 0, top: 100, right: 400, bottom: 200 } },
      ],
    };
    const obs = {
      updatedAt: 0,
      screenSize: { width: 400, height: 800 },
      systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
      viewHierarchy: { packageName: "com.example.iosapp", hierarchy: { node: iosRoot as unknown as ViewHierarchyNode } },
    } as ObserveResult;
    const before = countNodes(roots(obs));
    const { result, focus } = scopeToFocus(obs);
    expect(focus.matched).toBe(false); // undotted prefixes are never foreign
    expect(countNodes(roots(result))).toBe(before);
    expect(resourceIds(result)).toContain("row:0");
  });

  test("anchor scoping by resource-id keeps only the matched subtree", () => {
    const obs = androidFixture();
    const { result, focus } = scopeToFocus(obs, { resourceId: LIST });
    expect(focus).toEqual({ by: "anchor", matched: true });
    expect(roots(result)).toHaveLength(1);
    expect(roots(result)[0]["resource-id"]).toBe(LIST);
    expect(countNodes(roots(result))).toBe(3); // list + 2 items
  });

  test("anchor scoping by substring text keeps the matching node's subtree", () => {
    const obs = androidFixture();
    const { result, focus } = scopeToFocus(obs, { text: "Title" });
    expect(focus).toEqual({ by: "anchor", matched: true });
    expect(roots(result)).toHaveLength(1);
    expect(roots(result)[0]["resource-id"]).toBe(HEADER);
  });

  test("unmatched anchor leaves the tree untouched", () => {
    const obs = androidFixture();
    const before = countNodes(roots(obs));
    const { result, focus } = scopeToFocus(obs, { resourceId: "does-not-exist" });
    expect(focus.matched).toBe(false);
    expect(countNodes(roots(result))).toBe(before);
  });

  test("iOS-style tree (no package-qualified ids) is a no-op", () => {
    const obs = androidFixture();
    // Strip the qualified ids so no node looks foreign — the real iOS shape.
    const strip = (nodes: Node[]): void => {
      for (const n of nodes) { delete n["resource-id"]; strip(toNodeArray(n.node)); }
    };
    strip(roots(obs));
    const before = countNodes(roots(obs));
    const { result, focus } = scopeToFocus(obs);
    expect(focus.matched).toBe(false);
    expect(countNodes(roots(result))).toBe(before);
  });

  test("is pure — input is not mutated", () => {
    const obs = androidFixture();
    const before = JSON.stringify(obs);
    scopeToFocus(obs);
    expect(JSON.stringify(obs)).toBe(before);
  });
});

describe("scopeToRegion", () => {
  test("default content rect drops off-content chrome", () => {
    const obs = androidFixture();
    const { result, rectPx } = scopeToRegion(obs);
    // insets top:80 bottom:100 -> content rect [0,80,1080,2300].
    expect(rectPx).toEqual({ left: 0, top: 80, right: 1080, bottom: 2300 });
    const ids = resourceIds(result);
    expect(ids).not.toContain(STATUS_BAR); // 0..80, touches top edge only
    expect(ids).not.toContain(NAV_BAR); // 2300..2400, touches bottom edge only
    expect(ids).toContain(HEADER);
  });

  test("normalized box crops to the top half", () => {
    const obs = androidFixture();
    const { result, rectPx } = scopeToRegion(obs, { x1: 0, y1: 0, x2: 1, y2: 0.5 });
    expect(rectPx).toEqual({ left: 0, top: 0, right: 1080, bottom: 1200 });
    const ids = resourceIds(result);
    expect(ids).toContain(STATUS_BAR);
    expect(ids).toContain(HEADER);
    expect(ids).not.toContain(NAV_BAR); // 2300..2400 is below y=1200
  });

  test("filters the categorized elements by the same rect", () => {
    const obs = androidFixture();
    const { result } = scopeToRegion(obs);
    // status-bar clock (0..80) drops; Item 2 text (400..600) stays.
    expect(result.elements?.text).toHaveLength(1);
    expect(result.elements?.clickable).toHaveLength(1);
  });

  test("keeps a leaf with no readable bounds (never geometrically excluded)", () => {
    const obs = androidFixture();
    // A bounds-less node the crop cannot place must survive, per the contract.
    roots(obs)[0].node!.push({ "resource-id": `${APP}:id/boundless` });
    const { result } = scopeToRegion(obs, { x1: 0, y1: 0, x2: 0.1, y2: 0.1 });
    expect(resourceIds(result)).toContain(`${APP}:id/boundless`);
  });

  test("reads compacted-tuple bounds", () => {
    const obs = androidFixture();
    const statusBar = roots(obs)[0].node![0];
    statusBar.bounds = [0, 0, 1080, 80]; // compact form
    const { result } = scopeToRegion(obs, { x1: 0, y1: 0, x2: 1, y2: 0.5 });
    expect(resourceIds(result)).toContain(STATUS_BAR);
  });

  test("is pure — input is not mutated", () => {
    const obs = androidFixture();
    const before = JSON.stringify(obs);
    scopeToRegion(obs);
    expect(JSON.stringify(obs)).toBe(before);
  });
});

describe("toOverview", () => {
  test("keeps structural nodes, drops anonymous leaves, counts omissions, drops elements", () => {
    const obs = androidFixture();
    const result = toOverview(obs);
    const ids = resourceIds(result);
    // list is addressable + scrollable -> kept; its two anonymous item leaves drop.
    expect(ids).toContain(LIST);
    expect(ids).toContain(HEADER);
    const list = findById(result, LIST)!;
    expect(list.node).toBeUndefined(); // both leaf items collapsed
    expect((list as unknown as { omittedDescendants?: number }).omittedDescendants).toBe(2);
    // the anonymous `View` leaf under the app root has no id/children -> dropped.
    expect(result.elements).toBeUndefined();
  });

  test("keeps id-less but addressable leaves (clickable / content-desc)", () => {
    const obs = androidFixture();
    // A tappable, id-less control (Compose/iOS shape) with an a11y label.
    roots(obs)[0].node![1].node!.push({
      "clickable": true,
      "content-desc": "Add item",
      "bounds": { left: 0, top: 2100, right: 200, bottom: 2200 },
    });
    const result = toOverview(obs);
    const labels: string[] = [];
    const walk = (nodes: Node[]): void => {
      for (const n of nodes) { if (n["content-desc"]) { labels.push(n["content-desc"]); } walk(toNodeArray(n.node)); }
    };
    walk(roots(result));
    expect(labels).toContain("Add item"); // NOT collapsed into omittedDescendants
  });

  test("strips non-structural attributes from retained nodes", () => {
    const obs = androidFixture();
    const result = toOverview(obs);
    const header = findById(result, HEADER)!;
    expect(header["resource-id"]).toBe(HEADER);
    expect(header.text).toBeUndefined(); // leaf detail dropped
    expect(header.bounds).toBeDefined(); // structural attr kept
  });

  test("is pure — input is not mutated", () => {
    const obs = androidFixture();
    const before = JSON.stringify(obs);
    toOverview(obs);
    expect(JSON.stringify(obs)).toBe(before);
  });
});

describe("applyObserveScopeExperiments", () => {
  test("no flags on returns the input unchanged (same reference)", () => {
    const obs = androidFixture();
    const result = applyObserveScopeExperiments(obs, { focus: false, overview: false, region: false });
    expect(result).toBe(obs);
    expect(result.observeScope).toBeUndefined();
  });

  test("records applied transforms and node counts in observeScope", () => {
    const obs = androidFixture();
    const before = countNodes(roots(obs));
    const result = applyObserveScopeExperiments(obs, { focus: true, overview: false, region: false });
    expect(result.observeScope?.applied).toEqual(["focus"]);
    expect(result.observeScope?.nodesBefore).toBe(before);
    expect(result.observeScope?.nodesAfter).toBeLessThan(before);
    expect(result.observeScope?.focus?.by).toBe("foreground-app");
  });

  test("composes focus -> region -> overview", () => {
    const obs = androidFixture();
    const result = applyObserveScopeExperiments(obs, { focus: true, overview: true, region: true });
    const applied = result.observeScope?.applied ?? [];
    // `applied` must be a subsequence of the canonical stage order (focus, region,
    // overview) — i.e. each entry's stage index strictly increases. This catches a
    // real regression (a stage recorded out of order) the type system cannot.
    const order = ["focus", "region", "overview"];
    const indices = applied.map(k => order.indexOf(k));
    expect(indices).toEqual([...indices].sort((a, b) => a - b));
    expect(new Set(applied).size).toBe(applied.length); // no duplicate stages
    expect(applied).toContain("overview");
    expect(result.elements).toBeUndefined(); // overview drops elements
  });

  test("is pure — input is not mutated", () => {
    const obs = androidFixture();
    const before = JSON.stringify(obs);
    applyObserveScopeExperiments(obs, { focus: true, overview: true, region: true });
    expect(JSON.stringify(obs)).toBe(before);
  });
});

describe("applyObserveScopeExperiments — co-scopes layoutWarnings (issue #5074)", () => {
  type Bounds = { left: number; top: number; right: number; bottom: number };
  type Warning = NonNullable<ObserveResult["layoutWarnings"]>["warnings"][number];

  // A warning anchored to a node's bounds. Only `element.bounds` matters here —
  // co-scoping keys on the element's location surviving in the pruned tree.
  function warningAt(bounds: Bounds | number[]): Warning {
    return {
      type: "important-content-under-inset",
      severity: "warning",
      element: { bounds: bounds as Bounds },
      categories: ["text"],
      insetTypes: ["systemBars"],
      sides: ["top"],
      overflowPx: { top: 10 },
      insetPx: { top: 80 },
      overlapPercent: 100,
      confidence: "medium",
    };
  }

  const STATUS_BAR_BOUNDS: Bounds = { left: 0, top: 0, right: 1080, bottom: 80 };
  const HEADER_BOUNDS: Bounds = { left: 0, top: 80, right: 1080, bottom: 200 };
  const ITEM2_BOUNDS: Bounds = { left: 0, top: 400, right: 1080, bottom: 600 };
  const NAV_BAR_BOUNDS: Bounds = { left: 0, top: 2300, right: 1080, bottom: 2400 };

  const boundsOf = (result: ObserveResult): Bounds[] =>
    (result.layoutWarnings?.warnings ?? []).map(w => w.element.bounds as Bounds);

  test("REGION drops a warning whose element falls outside the crop, marking scope 'scoped'", () => {
    const obs = androidFixture();
    obs.layoutWarnings = { scope: "full", warnings: [warningAt(HEADER_BOUNDS), warningAt(NAV_BAR_BOUNDS)] };
    // Top-half crop keeps HEADER (top:80), prunes NAV_BAR (top:2300 > 1200).
    const result = applyObserveScopeExperiments(obs, {
      focus: false, overview: false, region: true, regionBox: { x1: 0, y1: 0, x2: 1, y2: 0.5 },
    });
    expect(result.layoutWarnings?.scope).toBe("scoped");
    expect(result.layoutWarnings?.warnings).toHaveLength(1);
    expect(result.layoutWarnings?.warnings[0].element.bounds).toEqual(HEADER_BOUNDS);
  });

  test("FOCUS drops a warning for pruned foreign chrome", () => {
    const obs = androidFixture();
    obs.layoutWarnings = { scope: "full", warnings: [warningAt(STATUS_BAR_BOUNDS), warningAt(HEADER_BOUNDS)] };
    // Foreground-app focus prunes com.android.systemui chrome (status/nav bars).
    const result = applyObserveScopeExperiments(obs, { focus: true, overview: false, region: false });
    expect(boundsOf(result)).toContainEqual(HEADER_BOUNDS);
    expect(boundsOf(result)).not.toContainEqual(STATUS_BAR_BOUNDS);
  });

  test("OVERVIEW alone retains warnings (matched before the structural collapse)", () => {
    const obs = androidFixture();
    // Item 2 is a leaf OVERVIEW collapses into the list. Its warning is matched
    // against the pre-collapse tree, so it is retained — the location is still
    // shown, represented by the kept `list` ancestor. Nothing is spatially
    // removed, so scope stays "full".
    obs.layoutWarnings = { scope: "full", warnings: [warningAt(HEADER_BOUNDS), warningAt(ITEM2_BOUNDS)] };
    const result = applyObserveScopeExperiments(obs, { focus: false, overview: true, region: false });
    expect(boundsOf(result)).toContainEqual(HEADER_BOUNDS);
    expect(boundsOf(result)).toContainEqual(ITEM2_BOUNDS);
    expect(result.layoutWarnings?.scope).toBe("full");
  });

  test("OVERVIEW does not strip iOS `$`-bag warnings (finding 9)", () => {
    // iOS nodes hold bounds/identity in a `$` bag that OVERVIEW strips. Matching
    // against the pre-overview tree keeps them; reading the post-overview tree
    // would drop every iOS warning.
    const B: Bounds = { left: 0, top: 80, right: 300, bottom: 140 };
    const obs = androidFixture();
    obs.viewHierarchy!.hierarchy.node = {
      "$": { "resource-id": `${APP}:id/ios-root`, "bounds": { left: 0, top: 0, right: 1080, bottom: 2400 } },
      "node": [{ $: { "resource-id": `${APP}:id/ios-cell`, "clickable": "true", "bounds": B } }],
    } as never;
    obs.layoutWarnings = { scope: "full", warnings: [{ ...warningAt(B), element: { resourceId: `${APP}:id/ios-cell`, bounds: B } }] };
    const result = applyObserveScopeExperiments(obs, { focus: false, overview: true, region: false });
    expect(result.layoutWarnings?.warnings).toHaveLength(1);
  });

  test("matches against compacted-tuple node bounds", () => {
    const obs = androidFixture();
    // NAV_BAR node in compact tuple form; the warning element also compacted.
    roots(obs)[0].node![2].bounds = [0, 2300, 1080, 2400];
    obs.layoutWarnings = { scope: "full", warnings: [warningAt([0, 2300, 1080, 2400])] };
    // Full-screen region keeps everything, so the tuple-bounds warning survives.
    const result = applyObserveScopeExperiments(obs, {
      focus: false, overview: false, region: true, regionBox: { x1: 0, y1: 0, x2: 1, y2: 1 },
    });
    expect(result.layoutWarnings?.warnings).toHaveLength(1);
  });

  test("downgrades a truncated list to 'scoped' and drops total when scoping removes warnings", () => {
    const obs = androidFixture();
    obs.layoutWarnings = { scope: "truncated", total: 137, warnings: [warningAt(HEADER_BOUNDS), warningAt(NAV_BAR_BOUNDS)] };
    const result = applyObserveScopeExperiments(obs, {
      focus: false, overview: false, region: true, regionBox: { x1: 0, y1: 0, x2: 1, y2: 0.5 },
    });
    expect(result.layoutWarnings?.scope).toBe("scoped");
    expect(result.layoutWarnings?.total).toBeUndefined();
    expect(result.layoutWarnings?.warnings).toHaveLength(1);
  });

  test("leaves the envelope untouched (scope + total) when every warning survives", () => {
    const obs = androidFixture();
    obs.layoutWarnings = { scope: "truncated", total: 137, warnings: [warningAt(HEADER_BOUNDS)] };
    // Full-screen region prunes nothing at HEADER, so the warning survives.
    const result = applyObserveScopeExperiments(obs, {
      focus: false, overview: false, region: true, regionBox: { x1: 0, y1: 0, x2: 1, y2: 1 },
    });
    expect(result.layoutWarnings?.scope).toBe("truncated");
    expect(result.layoutWarnings?.total).toBe(137);
    expect(result.layoutWarnings?.warnings).toHaveLength(1);
  });

  test("retains an OVERVIEW-collapsed child's warning, matched before the collapse", () => {
    const B: Bounds = { left: 0, top: 0, right: 1080, bottom: 200 };
    const obs = androidFixture();
    // A card with a text child at identical bounds; OVERVIEW collapses the child.
    obs.viewHierarchy!.hierarchy.node = {
      "resource-id": `${APP}:id/root`, "bounds": { left: 0, top: 0, right: 1080, bottom: 2400 },
      "node": [{ "resource-id": `${APP}:id/card`, "clickable": true, "bounds": B, "node": [{ text: "Buried", bounds: B }] }],
    } as never;
    obs.layoutWarnings = { scope: "full", warnings: [{ ...warningAt(B), element: { text: "Buried", bounds: B } }] };
    const result = applyObserveScopeExperiments(obs, { focus: false, overview: true, region: false });
    // Matched against the pre-collapse tree, where the "Buried" child is present
    // and uniquely identified by its text — so the warning is retained (its
    // location is shown, summarized into the kept card).
    expect(result.layoutWarnings?.warnings).toHaveLength(1);
    expect(result.layoutWarnings?.scope).toBe("full");
  });

  test("downgrades a truncated list to 'scoped' and drops total once the hierarchy is pruned (finding 2)", () => {
    const obs = androidFixture();
    // Every shown warning survives the crop, but the list was truncated and the
    // crop prunes nodes — so a capped-away warning could be out of view.
    obs.layoutWarnings = { scope: "truncated", total: 137, warnings: [warningAt(HEADER_BOUNDS)] };
    const result = applyObserveScopeExperiments(obs, {
      focus: false, overview: false, region: true, regionBox: { x1: 0, y1: 0, x2: 1, y2: 0.5 },
    });
    expect(result.layoutWarnings?.scope).toBe("scoped");
    expect(result.layoutWarnings?.total).toBeUndefined();
    expect(result.layoutWarnings?.warnings).toHaveLength(1);
  });

  test("rejects a same-bounds survivor whose strong id conflicts with the warning (finding 8)", () => {
    const B: Bounds = { left: 0, top: 100, right: 400, bottom: 160 };
    const obs = androidFixture();
    // Two siblings share an exact rectangle and the same text but differ by
    // resource-id. Anchor focus keeps only `kept`; `dropped` is pruned.
    obs.viewHierarchy!.hierarchy.node = {
      "resource-id": `${APP}:id/root`, "bounds": { left: 0, top: 0, right: 1080, bottom: 2400 },
      "node": [
        { "resource-id": `${APP}:id/kept`, "text": "OK", "bounds": B },
        { "resource-id": `${APP}:id/dropped`, "text": "OK", "bounds": B },
      ],
    } as never;
    const warn = (rid: string): Warning => ({ ...warningAt(B), element: { resourceId: rid, text: "OK", bounds: B } });
    obs.layoutWarnings = { scope: "full", warnings: [warn(`${APP}:id/kept`), warn(`${APP}:id/dropped`)] };

    const result = applyObserveScopeExperiments(obs, {
      focus: true, focusAnchor: { resourceId: `${APP}:id/kept` }, overview: false, region: false,
    });

    // The shared text must NOT keep the pruned node's warning: its resource-id
    // conflicts with the sole survivor's, so only `kept`'s warning remains.
    const rids = (result.layoutWarnings?.warnings ?? []).map(w => w.element.resourceId);
    expect(rids).toEqual([`${APP}:id/kept`]);
  });

  test("rejects a same-bounds survivor whose content-desc conflicts (finding 10)", () => {
    const B: Bounds = { left: 0, top: 100, right: 400, bottom: 160 };
    const obs = androidFixture();
    // Same bounds and text, but different content-desc and no resource-id.
    obs.viewHierarchy!.hierarchy.node = {
      "resource-id": `${APP}:id/root`, "bounds": { left: 0, top: 0, right: 1080, bottom: 2400 },
      "node": [
        { "resource-id": `${APP}:id/anchor`, "content-desc": "kept", "text": "OK", "bounds": B },
        { "content-desc": "dropped", "text": "OK", "bounds": B },
      ],
    } as never;
    const warn = (cd: string): Warning => ({ ...warningAt(B), element: { contentDesc: cd, text: "OK", bounds: B } });
    obs.layoutWarnings = { scope: "full", warnings: [warn("kept"), warn("dropped")] };

    const result = applyObserveScopeExperiments(obs, {
      focus: true, focusAnchor: { resourceId: `${APP}:id/anchor` }, overview: false, region: false,
    });

    // Anchor focus keeps only the `kept` node; the shared text must not retain the
    // `dropped` warning, because its content-desc conflicts with the survivor's.
    const descs = (result.layoutWarnings?.warnings ?? []).map(w => w.element.contentDesc);
    expect(descs).toEqual(["kept"]);
  });

  test("is pure — does not mutate the caller's layoutWarnings", () => {
    const obs = androidFixture();
    obs.layoutWarnings = { scope: "full", warnings: [warningAt(HEADER_BOUNDS), warningAt(NAV_BAR_BOUNDS)] };
    const before = JSON.stringify(obs);
    applyObserveScopeExperiments(obs, {
      focus: false, overview: false, region: true, regionBox: { x1: 0, y1: 0, x2: 1, y2: 0.5 },
    });
    expect(JSON.stringify(obs)).toBe(before);
  });
});
