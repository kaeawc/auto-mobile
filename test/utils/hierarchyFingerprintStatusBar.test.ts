import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { hierarchyChanged, hierarchyFingerprint } from "../../src/utils/hierarchyFingerprint";
import type { ViewHierarchyResult } from "../../src/models";
import { STATUS_BAR_ROOT_IDS } from "../../src/utils/androidStatusBar";
import { observeResultFromJsonText } from "../helpers/observeFixture";

/**
 * The screen-change fingerprint ignores the SystemUI status bar (#13561): a clock tick or a new
 * notification icon is not a screen change, but any app-window change still is.
 */

const FIXTURE = "test/fixtures/android-settings/open-by-default-radio-rows.observe.json";

type Json = Record<string, unknown>;

// Parsed once: the capture is large, and each test edits its own clone.
let parsed: ViewHierarchyResult | undefined;

function loadHierarchy(): ViewHierarchyResult {
  if (!parsed) {
    parsed = observeResultFromJsonText(readFileSync(FIXTURE, "utf8"), FIXTURE).viewHierarchy;
  }
  if (!parsed) {
    throw new Error(`${FIXTURE} has no view hierarchy`);
  }
  return structuredClone(parsed);
}

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Visit every node (object with a resource-id) in depth-first order. */
function forEachNode(value: unknown, visit: (node: Json) => void): void {
  if (Array.isArray(value)) {
    value.forEach((child) => forEachNode(child, visit));
  } else if (isRecord(value)) {
    if ("resource-id" in value) {
      visit(value);
    }
    Object.values(value).forEach((child) => forEachNode(child, visit));
  }
}

function edit(hierarchy: ViewHierarchyResult, resourceId: string, change: (node: Json) => void) {
  let found = false;
  forEachNode(hierarchy.hierarchy, (node) => {
    if (node["resource-id"] === resourceId) {
      change(node);
      found = true;
    }
  });
  expect(found).toBe(true);
}

describe("hierarchyFingerprint ignores the SystemUI status bar (#13561)", () => {
  test("a clock tick is not a screen change", () => {
    const before = loadHierarchy();
    const after = loadHierarchy();
    edit(after, "com.android.systemui:id/clock", (node) => {
      node.text = "12:59";
      node["content-desc"] = "12:59 PM";
    });

    expect(hierarchyChanged(before, after)).toBe(false);
  });

  test.each([
    ["battery", "com.android.systemui:id/battery", "Battery 99 percent."],
    ["signal", "com.android.systemui:id/mobile_combo", "T-Mobile, one bar."],
  ])("a %s status change is not a screen change", (_name, resourceId, description) => {
    const before = loadHierarchy();
    const after = loadHierarchy();
    edit(after, resourceId, (node) => {
      node["content-desc"] = description;
    });

    expect(hierarchyChanged(before, after)).toBe(false);
  });

  test("an app-window change is still a screen change", () => {
    const before = loadHierarchy();
    const after = loadHierarchy();
    edit(after, "com.android.settings:id/action_bar", (node) => {
      node["content-desc"] = "changed";
    });

    expect(hierarchyChanged(before, after)).toBe(true);
  });

  test("the status bar subtree is dropped, not the rest of the tree", () => {
    const hierarchy = loadHierarchy();
    const stripped = loadHierarchy();
    edit(stripped, "com.android.systemui:id/status_bar_container", (node) => {
      for (const key of Object.keys(node)) {
        if (key !== "resource-id") {
          delete node[key];
        }
      }
    });

    expect(hierarchyFingerprint(stripped)).toBe(hierarchyFingerprint(hierarchy));
    expect(hierarchyFingerprint(hierarchy)).not.toBeNull();
  });

  test.each([...STATUS_BAR_ROOT_IDS])("%s is dropped from the fingerprint", (resourceId) => {
    const before = loadHierarchy();
    const after = loadHierarchy();
    forEachNode(after.hierarchy, (node) => {
      if (node["resource-id"] === resourceId) {
        node["content-desc"] = "edited while ignored";
      }
    });

    expect(hierarchyChanged(before, after)).toBe(false);
  });

  test("removing the status-bar window entirely still counts as a change", () => {
    const before = loadHierarchy();
    const after = loadHierarchy();
    forEachNode(after.hierarchy, (node) => {
      if (node["resource-id"] === "com.android.systemui:id/status_bar_container") {
        node["resource-id"] = "com.example:id/replaced";
      }
    });

    expect(hierarchyChanged(before, after)).toBe(true);
  });

  test("a change in another SystemUI subtree (e.g. the shade) still counts", () => {
    const before = loadHierarchy();
    const after = loadHierarchy();
    forEachNode(after.hierarchy, (node) => {
      if (node["resource-id"] === "com.android.systemui:id/status_bar_container") {
        node["resource-id"] = "com.android.systemui:id/notification_stack_scroller";
      }
    });

    expect(hierarchyChanged(before, after)).toBe(true);
  });
});
