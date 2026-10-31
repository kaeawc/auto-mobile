import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { AccessibilityNode } from "../../../../src/features/observe/android/types";
import type { Hierarchy } from "../../../../src/models/ViewHierarchyResult";
import {
  createAndroidHierarchyConverter,
  wireHierarchyFrom,
} from "../../../helpers/androidHierarchyConverter";

interface FixtureNode {
  bounds?: AccessibilityNode["bounds"];
  "resource-id"?: string;
  text?: string;
  "content-desc"?: string;
  clickable?: boolean | string;
  "long-clickable"?: boolean | string;
  node?: FixtureNode | FixtureNode[];
}

function flattenNodes(root: FixtureNode | FixtureNode[] | undefined): FixtureNode[] {
  if (!root) {
    return [];
  }
  if (Array.isArray(root)) {
    return root.flatMap(flattenNodes);
  }
  return [root, ...flattenNodes(root.node)];
}

function selector(node: FixtureNode) {
  return {
    bounds: node.bounds,
    resourceId: node["resource-id"] ?? "",
    text: node.text ?? "",
    contentDesc: node["content-desc"] ?? "",
  };
}

function isSelectorBearing(node: FixtureNode): boolean {
  return Boolean(
    node["resource-id"] ||
    node.text ||
    node["content-desc"] ||
    node.clickable === true ||
    node.clickable === "true" ||
    node["long-clickable"] === true ||
    node["long-clickable"] === "true",
  );
}

// These are capture-time status-bar changes, with exactly one unmatched OFF node each.
const CAPTURE_DRIFT_ALLOWLIST: Record<number, ReturnType<typeof selector>[]> = {
  33: [
    {
      bounds: { left: 50, top: 1, right: 127, bottom: 128 },
      resourceId: "com.android.systemui:id/clock",
      text: "3:46",
      contentDesc: "3:46 PM",
    },
  ],
  36: [
    {
      bounds: { left: 865, top: 35, right: 969, bottom: 93 },
      resourceId: "com.android.systemui:id/mobile_combo",
      text: "",
      contentDesc: "T-Mobile, two bars.",
    },
  ],
};

const EXPECTED_COUNTS = [
  { api: 30, on: 56, off: 67 },
  { api: 31, on: 58, off: 68 },
  { api: 32, on: 41, off: 46 },
  { api: 33, on: 42, off: 46 },
  { api: 34, on: 34, off: 49 },
  { api: 35, on: 35, off: 50 },
  { api: 36, on: 35, off: 50 },
];

function loadCapture(api: number, mode: "on" | "off") {
  const path = new URL(
    `../../../fixtures/android-wrapper-pruning/a${api}-${mode}.json`,
    import.meta.url,
  );
  const message: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (
    typeof message !== "object" ||
    message === null ||
    !("type" in message) ||
    message.type !== "hierarchy_update" ||
    !("data" in message)
  ) {
    throw new Error(`API ${api} ${mode} is not a hierarchy_update message`);
  }
  return wireHierarchyFrom(message.data, `API ${api} ${mode}`);
}

// Parse each capture once, outside the timed test bodies.
const captures = EXPECTED_COUNTS.map((counts) => ({
  ...counts,
  onCapture: loadCapture(counts.api, "on"),
  offCapture: loadCapture(counts.api, "off"),
}));

describe("Android wrapper pruning captures", () => {
  test.each(captures)("API $api preserves selectors through host conversion", (pair) => {
    const converter = createAndroidHierarchyConverter();
    // The recorded counts include the hierarchy container as well as its window-root nodes.
    const offHierarchy: Pick<Hierarchy, "node"> = converter.convertToViewHierarchyResult(
      pair.offCapture,
    ).hierarchy;
    const onHierarchy: Pick<Hierarchy, "node"> = converter.convertToViewHierarchyResult(
      pair.onCapture,
    ).hierarchy;
    const off = flattenNodes(offHierarchy);
    const on = flattenNodes(onHierarchy);
    expect(off).toHaveLength(pair.off);
    expect(on).toHaveLength(pair.on);
    expect(on.length).toBeLessThan(off.length);

    const rawOffSelectors = flattenNodes(pair.offCapture.hierarchy?.node)
      .filter(isSelectorBearing)
      .map(selector);
    expect(off.filter(isSelectorBearing).map(selector)).toEqual(rawOffSelectors);

    // Stable ids of nodes that keep pruned wrapper children may drift by design, because
    // the id derives from child structure (src/features/observe/android/StableNodeIdentity.ts:403).
    // Compare bounds plus the selector tuple instead; consume matches to preserve multiplicity.
    const remaining = on.map((node) => JSON.stringify(selector(node)));
    const unmatched = rawOffSelectors.filter((entry) => {
      const index = remaining.indexOf(JSON.stringify(entry));
      if (index < 0) {
        return true;
      }
      remaining.splice(index, 1);
      return false;
    });
    expect(unmatched).toEqual(CAPTURE_DRIFT_ALLOWLIST[pair.api] ?? []);
  });
});
