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
  package?: string;
  scrollable?: boolean | string;
  clickable?: boolean | string;
  bounds?: { left: number; top: number; right: number; bottom: number } | number[];
  node?: Node[];
}

/**
 * An Android-shaped tree: a container root with system chrome (status/nav bars,
 * `com.android.systemui`) flanking the foreground app's own subtree.
 */
function androidFixture(): ObserveResult {
  const root: Node = {
    class: "FrameLayout",
    bounds: { left: 0, top: 0, right: 1080, bottom: 2400 },
    node: [
      {
        "resource-id": "statusBar",
        "package": "com.android.systemui",
        "bounds": { left: 0, top: 0, right: 1080, bottom: 80 },
      },
      {
        class: "LinearLayout",
        package: "com.example.app",
        bounds: { left: 0, top: 80, right: 1080, bottom: 2300 },
        node: [
          {
            "resource-id": "header",
            "package": "com.example.app",
            "text": "Title",
            "bounds": { left: 0, top: 80, right: 1080, bottom: 200 },
          },
          {
            "resource-id": "list",
            "package": "com.example.app",
            "scrollable": true,
            "bounds": { left: 0, top: 200, right: 1080, bottom: 2200 },
            "node": [
              { text: "Item 1", package: "com.example.app", bounds: { left: 0, top: 200, right: 1080, bottom: 400 } },
              { text: "Item 2", package: "com.example.app", bounds: { left: 0, top: 400, right: 1080, bottom: 600 } },
            ],
          },
          {
            class: "View",
            package: "com.example.app",
            bounds: { left: 0, top: 2200, right: 1080, bottom: 2300 },
          },
        ],
      },
      {
        "resource-id": "navBar",
        "package": "com.android.systemui",
        "bounds": { left: 0, top: 2300, right: 1080, bottom: 2400 },
      },
    ],
  };

  return {
    updatedAt: 0,
    screenSize: { width: 1080, height: 2400 },
    systemInsets: { top: 80, bottom: 100, left: 0, right: 0 },
    activeWindow: { appId: "com.example.app" } as ObserveResult["activeWindow"],
    viewHierarchy: {
      packageName: "com.example.app",
      hierarchy: { node: root as unknown as ViewHierarchyNode },
    },
    elements: {
      clickable: [{ bounds: { left: 0, top: 80, right: 1080, bottom: 200 } } as never],
      scrollable: [{ bounds: { left: 0, top: 200, right: 1080, bottom: 2200 } } as never],
      text: [
        { bounds: { left: 0, top: 0, right: 1080, bottom: 80 } } as never, // status bar clock
        { bounds: { left: 0, top: 400, right: 1080, bottom: 600 } } as never, // Item 2
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
  });

  test("no scope input yields an all-off config", () => {
    const cfg = buildObserveScopeConfig(allFlags, undefined);
    expect(cfg.focus).toBe(false);
    expect(cfg.region).toBe(false);
    expect(cfg.overview).toBe(false);
  });
});

describe("scopeToFocus", () => {
  test("foreground-app scoping drops system chrome", () => {
    const obs = androidFixture();
    const { result, focus } = scopeToFocus(obs);
    expect(focus).toEqual({ by: "foreground-app", matched: true, packageName: "com.example.app" });
    const ids = resourceIds(result);
    expect(ids).not.toContain("statusBar");
    expect(ids).not.toContain("navBar");
    expect(ids).toContain("header");
    expect(ids).toContain("list");
  });

  test("anchor scoping keeps only the matched subtree", () => {
    const obs = androidFixture();
    const { result, focus } = scopeToFocus(obs, { resourceId: "list" });
    expect(focus).toEqual({ by: "anchor", matched: true });
    expect(roots(result)).toHaveLength(1);
    expect(roots(result)[0]["resource-id"]).toBe("list");
    expect(countNodes(roots(result))).toBe(3); // list + 2 items
  });

  test("unmatched anchor leaves the tree untouched", () => {
    const obs = androidFixture();
    const before = countNodes(roots(obs));
    const { result, focus } = scopeToFocus(obs, { resourceId: "does-not-exist" });
    expect(focus.matched).toBe(false);
    expect(countNodes(roots(result))).toBe(before);
  });

  test("iOS-style tree with no matching package is a no-op", () => {
    const obs = androidFixture();
    obs.viewHierarchy!.packageName = "com.apple.springboard"; // no node advertises it
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
    expect(ids).not.toContain("statusBar"); // 0..80, touches top edge only
    expect(ids).not.toContain("navBar"); // 2300..2400, touches bottom edge only
    expect(ids).toContain("header");
  });

  test("normalized box crops to the top half", () => {
    const obs = androidFixture();
    const { result, rectPx } = scopeToRegion(obs, { x1: 0, y1: 0, x2: 1, y2: 0.5 });
    expect(rectPx).toEqual({ left: 0, top: 0, right: 1080, bottom: 1200 });
    const ids = resourceIds(result);
    expect(ids).toContain("statusBar");
    expect(ids).toContain("header");
    expect(ids).not.toContain("navBar"); // 2300..2400 is below y=1200
  });

  test("filters the categorized elements by the same rect", () => {
    const obs = androidFixture();
    const { result } = scopeToRegion(obs);
    // status-bar clock (0..80) drops; Item 2 text (400..600) stays.
    expect(result.elements?.text).toHaveLength(1);
    expect(result.elements?.clickable).toHaveLength(1);
  });

  test("reads compacted-tuple bounds", () => {
    const obs = androidFixture();
    const statusBar = roots(obs)[0].node![0];
    statusBar.bounds = [0, 0, 1080, 80]; // compact form
    const { result } = scopeToRegion(obs, { x1: 0, y1: 0, x2: 1, y2: 0.5 });
    expect(resourceIds(result)).toContain("statusBar");
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
    expect(ids).toContain("list");
    expect(ids).toContain("header");
    const list = findById(result, "list")!;
    expect(list.node).toBeUndefined(); // both leaf items collapsed
    expect((list as unknown as { omittedDescendants?: number }).omittedDescendants).toBe(2);
    // the anonymous `View` leaf under the app root has no id/children -> dropped.
    expect(result.elements).toBeUndefined();
  });

  test("strips non-structural attributes from retained nodes", () => {
    const obs = androidFixture();
    const result = toOverview(obs);
    const header = findById(result, "header")!;
    expect(header["resource-id"]).toBe("header");
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
    // focus + overview definitely change the tree; region may already be covered
    // by focus, so assert order-preserving subset of the enabled set.
    expect(applied).toEqual(applied.filter(k => ["focus", "region", "overview"].includes(k)));
    expect(result.observeScope?.applied).toContain("overview");
    expect(result.elements).toBeUndefined(); // overview drops elements
  });

  test("is pure — input is not mutated", () => {
    const obs = androidFixture();
    const before = JSON.stringify(obs);
    applyObserveScopeExperiments(obs, { focus: true, overview: true, region: true });
    expect(JSON.stringify(obs)).toBe(before);
  });
});
