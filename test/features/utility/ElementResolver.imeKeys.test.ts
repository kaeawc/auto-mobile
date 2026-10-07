import { describe, expect, test } from "bun:test";
import postTap from "../../fixtures/android-focus/playground-text-field-post-tap.json";
import preTap from "../../fixtures/android-focus/playground-text-field-pre-tap.json";
import type { ViewHierarchyNode, ViewHierarchyResult } from "../../../src/models";
import { DefaultObserveElementCollector } from "../../../src/features/observe/ObserveElementCollector";
import { linkWindowRoots } from "../../../src/features/observe/linkWindowRoots";
import { projectSkeleton } from "../../../src/features/observe/output/SkeletonProjection";
import { ResolverElementSelector } from "../../../src/features/utility/ResolverElementSelector";
import { SearchableHierarchy, isImeKeyEntry } from "../../../src/features/utility/SearchableNode";

/**
 * Issue #10225: a text selector that also matches a soft-keyboard key used to tap the
 * key, because the input-method window ranks above the app. `observe` folds the whole
 * keyboard into one `<ime>` row, so the client never saw the key it hit.
 *
 * Both fixtures are real Playground captures. `post-tap` has Gboard open (window type 2,
 * `automobile:imePackage` on its root); its toolbar `Settings` button collides with the
 * Playground's `Settings` tab, and it has keys labelled `Delete`, `Space`, `Enter`, `Back`.
 * `pre-tap` is the same screen with no keyboard.
 */

const GBOARD = "com.google.android.inputmethod.latin";
const TAB_SETTINGS = { left: 826, top: 2127, right: 1080, bottom: 2337 };
const KEY_SETTINGS = { left: 620, top: 1517, right: 780, bottom: 1633 };

type Capture = { viewHierarchy: unknown };

/**
 * The capture as the device client delivers it: `windows[].hierarchy` is the very node
 * object inside `hierarchy` (`linkWindowRoots`). The JSON file serializes the shared
 * subtree twice, so the unlinked shape is exercised too.
 */
function load(fixture: Capture, linked: boolean): ViewHierarchyResult {
  const capture = structuredClone(fixture.viewHierarchy) as ViewHierarchyResult;
  if (linked) {
    capture.windows = linkWindowRoots(capture.hierarchy, capture.windows);
  }
  return capture;
}

function selectText(capture: ViewHierarchyResult, text: string, index?: number) {
  return new ResolverElementSelector().selectByText(capture, text, {
    partialMatch: true,
    caseSensitive: false,
    intentAction: "inspect",
    selectionIntent: "tap",
    index,
  });
}

describe.each([true, false])(
  "keyboard keys are not text-selector targets (linked=%p)",
  (linked) => {
    test("`Settings` resolves the Playground tab, not Gboard's toolbar button", () => {
      const result = selectText(load(postTap, linked), "Settings");
      expect(result.element?.bounds).toEqual(TAB_SETTINGS);
      expect(result.element?.bounds).not.toEqual(KEY_SETTINGS);
      expect(result.onlyKeyboardKeyMatch).toBeUndefined();
    });

    test.each(["Delete", "Space"])("`%s` matches only a key, so it names the keyboard", (label) => {
      const result = selectText(load(postTap, linked), label);
      expect(result.element).toBeNull();
      expect(result.onlyKeyboardKeyMatch).toBe(true);
    });

    test("a key no longer locks substring matching to exact: `Enter` finds the app's `Enter some text...`", () => {
      const result = selectText(load(postTap, linked), "Enter");
      expect(result.element?.bounds).toEqual({ left: 84, top: 1115, right: 996, bottom: 1262 });
      expect(result.element?.["resource-id"]).toBeUndefined();
    });

    test("the keyboard's framework chrome stays targetable, as it stays in the skeleton", () => {
      const result = selectText(load(postTap, linked), "Back");
      expect(result.element?.["resource-id"]).toBe("android:id/input_method_nav_back");
    });

    test("a key stays reachable by its resource id", () => {
      const result = new ResolverElementSelector().selectByResourceId(
        load(postTap, linked),
        `${GBOARD}:id/key_pos_del`,
        { intentAction: "inspect" },
      );
      expect(result.element?.["content-desc"]).toBe("Delete");
    });
  },
);

describe("explicit index numbering matches the skeleton", () => {
  test("`Settings` has one candidate, so index 1 is a plain miss, not a keyboard error", () => {
    const result = selectText(load(postTap, true), "Settings", 1);
    expect(result.element).toBeNull();
    expect(result.onlyKeyboardKeyMatch).toBeUndefined();
  });

  /**
   * Real app rows (the captured `Tap` and `Swipe` tabs) relabelled `Delete`, a Gboard
   * key's label, and left id-less: the skeleton numbers only id-less rows that share a label.
   */
  function withAppRowsLabelledDelete(): ViewHierarchyResult {
    const capture = load(postTap, true);
    const relabel = (node: ViewHierarchyNode, insideRow: boolean): void => {
      const isRow = node.text === "Tap" || node.text === "Swipe";
      const row =
        insideRow || node["collection-column-index"] === 0 || node["collection-column-index"] === 1;
      if (isRow) {
        node.text = "Delete";
      }
      if (row && node["view-id"] !== undefined) {
        delete node["view-id"];
      }
      for (const child of [node.node ?? []].flat()) {
        relabel(child, row);
      }
    };
    relabel(capture.hierarchy as ViewHierarchyNode, false);
    return capture;
  }

  test("each skeleton `Delete` index selects that row, and the key takes no index slot", () => {
    const capture = withAppRowsLabelledDelete();
    const elements = new DefaultObserveElementCollector().collect(capture, "android")!;
    const rows = projectSkeleton(elements).skeleton.filter((row) => row.label === "Delete");
    expect(rows.map((row) => row.index)).toEqual([0, 1]);
    for (const row of rows) {
      const picked = selectText(capture, "Delete", row.index);
      expect([
        picked.element?.bounds.left,
        picked.element?.bounds.top,
        picked.element?.bounds.right,
        picked.element?.bounds.bottom,
      ]).toEqual(row.bounds);
      expect(picked.element?.["resource-id"]).toBeUndefined();
    }
    expect(selectText(capture, "Delete", 2).element).toBeNull();
  });

  test("an unindexed `Delete` resolves an app row, never the key", () => {
    const picked = selectText(withAppRowsLabelledDelete(), "Delete");
    expect(picked.element?.["resource-id"]).toBeUndefined();
    expect(picked.onlyKeyboardKeyMatch).toBeUndefined();
  });
});

describe("what is flagged as a keyboard key", () => {
  test("no keyboard window: nothing is flagged and every lookup is unchanged", () => {
    const capture = load(preTap, true);
    const entries = new SearchableHierarchy().project(capture);
    expect(entries.some((entry) => entry.inputMethod !== undefined)).toBe(false);
    for (const label of ["Settings", "Tap", "Enter", "Delete"]) {
      expect(selectText(capture, label).onlyKeyboardKeyMatch).toBeUndefined();
    }
    expect(selectText(capture, "Settings").element?.bounds).toEqual(TAB_SETTINGS);
  });

  test("the keyboard window's own subtree is flagged, the app's is not", () => {
    const entries = new SearchableHierarchy().project(load(postTap, true));
    const keys = entries.filter(isImeKeyEntry);
    expect(keys.length).toBeGreaterThan(40);
    expect(keys.every((entry) => entry.inputMethod?.package === GBOARD)).toBe(true);
    expect(keys.some((entry) => entry.nativeId === `${GBOARD}:id/key_pos_del`)).toBe(true);
    expect(
      entries.filter((entry) => entry.label === "Settings" && !isImeKeyEntry(entry)),
    ).not.toEqual([]);
  });

  test("without the window type or the imePackage extra, the key_pos_* family still identifies the keyboard", () => {
    const capture = load(postTap, false);
    const strip = (node: ViewHierarchyNode): void => {
      delete node.extras?.["automobile:imePackage"];
      for (const child of [node.node ?? []].flat()) {
        strip(child);
      }
    };
    strip(capture.hierarchy as ViewHierarchyNode);
    for (const window of capture.windows ?? []) {
      delete window.type;
      strip(window.hierarchy as ViewHierarchyNode);
    }
    const result = selectText(capture, "Delete");
    expect(result.element).toBeNull();
    expect(result.onlyKeyboardKeyMatch).toBe(true);
    expect(selectText(capture, "Settings").element?.bounds).toEqual(TAB_SETTINGS);
  });
});
