import { describe, expect, test } from "bun:test";
import type { ObserveResult } from "../../../../src/models/ObserveResult";
import type { ViewHierarchyResult } from "../../../../src/models";
import { viewHierarchyResultSchema } from "../../../../src/server/toolOutputSchemas";
import { diffObserveResult } from "../../../../src/features/observe/output/ObserveResultOutput";
import { isIosKeyboardClass } from "../../../../src/features/observe/ios/IosScreenIdentity";
import {
  iosKeyboardMinimizedHierarchy,
  iosKeyboardVisibleHierarchy,
} from "../../../fixtures/observe/iosKeyboardStates";
import androidPreTap from "../../../fixtures/android-focus/playground-text-field-pre-tap.json";
import androidPostTap from "../../../fixtures/android-focus/playground-text-field-post-tap.json";

/**
 * `diffObserveResult` with `collapseKeyboard` must leave the soft keyboard out of
 * `added` / `removed` / `changed` on iOS exactly as it does on Android (issue
 * #9980): the `skeleton` beside the diff already reports it as the single `<ime>`
 * row, so a row per keycap is noise.
 *
 * The hierarchies are the captured iOS keyboard-visible hierarchy (UIKeyboard at
 * [0,590,402,816] plus ~30 clickable UIKeyboardKey nodes) and the captured Android
 * pre/post-tap pair. The "no keyboard" iOS side is that same capture with the
 * `UIKeyboard` subtree pruned, so the two sides differ by the keyboard alone.
 */

const IOS_KEYBOARD_CLASS = "UIKeyboard";
const IOS_KEY_CLASS = "UIKeyboardKey";
const COLLAPSE = { collapseKeyboard: true, projectAddedRemoved: true } as const;

function observation(
  viewHierarchy: ViewHierarchyResult,
  platform: "android" | "ios",
): ObserveResult {
  return {
    updatedAt: 1,
    screenSize: { width: 402, height: 874 },
    systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
    activeWindow: { appId: "com.example", activityName: "", layoutSeqSum: 1 },
    viewHierarchy,
    screenIdentity:
      platform === "ios"
        ? {
            platform: "ios",
            source: "heuristic",
            confidence: "high",
            key: "bundle=com.example",
            components: { bundleId: "com.example" },
          }
        : undefined,
  };
}

type Json = Record<string, unknown>;
type Transform = (node: Json) => Json | undefined;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Capture children are an array or, when there is exactly one, a bare object. */
function rewriteChildren(node: Json, transform: Transform): Json {
  const children = node.node;
  if (children === undefined) {
    return node;
  }
  const list = (Array.isArray(children) ? children : [children]).filter(isRecord);
  const kept = list.flatMap((child) => {
    const next = transform(child);
    return next ? [rewriteChildren(next, transform)] : [];
  });
  const { node: _dropped, ...rest } = node;
  void _dropped;
  return kept.length === 0 ? rest : { ...rest, node: Array.isArray(children) ? kept : kept[0] };
}

function visit(node: Json, onNode: (node: Json) => void): void {
  rewriteChildren(node, (child) => {
    onNode(child);
    return child;
  });
}

function assertHierarchy(value: unknown): asserts value is ViewHierarchyResult {
  // Validate the wire shape once; the data is a captured or capture-derived hierarchy.
  viewHierarchyResultSchema.required({ hierarchy: true }).parse(value);
}

function mapHierarchy(result: ViewHierarchyResult, transform: Transform): ViewHierarchyResult {
  const derived: unknown = {
    ...result,
    hierarchy: rewriteChildren({ ...result.hierarchy }, transform),
  };
  assertHierarchy(derived);
  return derived;
}

const withoutKeyboard = mapHierarchy(iosKeyboardVisibleHierarchy, (node) =>
  node.className === IOS_KEYBOARD_CLASS ? undefined : node,
);

/** The same keyboard with every key relabelled (numbers plane / shift state). */
const relabelledKeyboard = mapHierarchy(iosKeyboardVisibleHierarchy, (node) =>
  node.className === IOS_KEY_CLASS && typeof node.text === "string"
    ? { ...node, text: node.text.toUpperCase() + "!" }
    : node,
);

const iosVisible = observation(iosKeyboardVisibleHierarchy, "ios");
const iosHidden = observation(withoutKeyboard, "ios");
const iosRelabelled = observation(relabelledKeyboard, "ios");

function asRootList(result: ViewHierarchyResult, roots: unknown[]): ViewHierarchyResult {
  const derived: unknown = { ...result, hierarchy: { ...result.hierarchy, node: roots } };
  assertHierarchy(derived);
  return derived;
}

function labelsOf(rows: readonly { attributes: Record<string, unknown> }[]): unknown[] {
  return rows.map((row) => row.attributes.text);
}

function expectNoKeyboardRows(diff: ReturnType<typeof diffObserveResult>): void {
  expect(diff.added).toEqual([]);
  expect(diff.removed).toEqual([]);
  expect(diff.changed).toEqual([]);
}

describe("diffObserveResult — iOS keyboard collapse (#9980)", () => {
  test("fixture premise: the capture holds a UIKeyboard container and many clickable keys", () => {
    let containers = 0;
    const keys: Json[] = [];
    visit({ ...iosKeyboardVisibleHierarchy.hierarchy }, (node) => {
      containers += node.className === IOS_KEYBOARD_CLASS ? 1 : 0;
      if (node.className === IOS_KEY_CLASS) {
        keys.push(node);
      }
    });
    expect(containers).toBe(1);
    expect(keys.length).toBeGreaterThanOrEqual(26);
    expect(keys.every((key) => key.clickable === "true")).toBe(true);
    expect(keys.every((key) => isIosKeyboardClass(String(key.className)))).toBe(true);
  });

  test("keyboard appearing adds no keycap rows when collapsed", () => {
    expectNoKeyboardRows(diffObserveResult(iosHidden, iosVisible, COLLAPSE));
  });

  test("keyboard disappearing removes no keycap rows when collapsed", () => {
    expectNoKeyboardRows(diffObserveResult(iosVisible, iosHidden, COLLAPSE));
  });

  test("key labels changing yields no remove/add pairs when collapsed", () => {
    expectNoKeyboardRows(diffObserveResult(iosVisible, iosRelabelled, COLLAPSE));
  });

  test("a UIKeyboardKey outside any UIKeyboard container is also skipped", () => {
    // Re-parent one captured key directly under the root, with no container around it.
    let key: Json | undefined;
    visit({ ...iosKeyboardVisibleHierarchy.hierarchy }, (node) => {
      key ??= node.className === IOS_KEY_CLASS ? node : undefined;
    });
    expect(key).toBeDefined();
    const roots = withoutKeyboard.hierarchy.node;
    const withBareKey = asRootList(withoutKeyboard, [
      ...(Array.isArray(roots) ? roots : [roots]),
      key,
    ]);
    expectNoKeyboardRows(diffObserveResult(iosHidden, observation(withBareKey, "ios"), COLLAPSE));
  });

  test("without collapseKeyboard the keys are still diffed (the flag is what gates it)", () => {
    const diff = diffObserveResult(iosHidden, iosVisible);
    expect(labelsOf(diff.added)).toContain("q");
    expect(diff.added.length).toBeGreaterThan(26);
  });

  test("non-keyboard iOS nodes still diff when collapsed", () => {
    const edited = mapHierarchy(withoutKeyboard, (node) =>
      node.className === "UITabBar" ? { ...node, text: "edited" } : node,
    );
    const diff = diffObserveResult(iosHidden, observation(edited, "ios"), COLLAPSE);
    expect(diff.added.length + diff.removed.length + diff.changed.length).toBeGreaterThan(0);
  });
});

describe("diffObserveResult — a parked iOS keyboard is not collapsed (#10027)", () => {
  // The minimized capture parks the UIKeyboard at [0,918,402,1144]; the baseline is
  // the same capture with that subtree pruned, so they differ by the keyboard alone.
  const parkedWithoutKeyboard = observation(
    mapHierarchy(iosKeyboardMinimizedHierarchy, (node) =>
      node.className === IOS_KEYBOARD_CLASS ? undefined : node,
    ),
    "ios",
  );
  const parked = observation(iosKeyboardMinimizedHierarchy, "ios");

  test("the parked keyboard has no <ime> row, so its nodes diff like any other", () => {
    const diff = diffObserveResult(parkedWithoutKeyboard, parked, { collapseKeyboard: true });
    expect(diff.added.some((row) => row.attributes.className === IOS_KEYBOARD_CLASS)).toBe(true);
    // ...whereas the visible keyboard's container never shows up under the same flag.
    const visible = diffObserveResult(iosHidden, iosVisible, { collapseKeyboard: true });
    expect(visible.added.some((row) => row.attributes.className === IOS_KEYBOARD_CLASS)).toBe(
      false,
    );
  });

  test("the same keyboard on screen still collapses (visible rule shared with the skeleton)", () => {
    expectNoKeyboardRows(diffObserveResult(iosHidden, iosVisible, COLLAPSE));
  });
});

describe("diffObserveResult — Android keyboard collapse is unchanged (#9980)", () => {
  const before = observation(androidPreTap.viewHierarchy, "android");
  const after = observation(androidPostTap.viewHierarchy, "android");

  test("the captured Android keyboard-appearing pair still yields no keyboard rows", () => {
    const diff = diffObserveResult(before, after, COLLAPSE);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toHaveLength(41);
  });
});
