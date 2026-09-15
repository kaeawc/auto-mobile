import { describe, expect, test } from "bun:test";
import type { BootedDevice, ViewHierarchyNode, ViewHierarchyResult } from "../../../src/models";
import { TapOnElement } from "../../../src/features/action/TapOnElement";
import { DragAndDrop } from "../../../src/features/action/DragAndDrop";
import { PinchOn } from "../../../src/features/action/PinchOn";
import { DefaultElementFinder } from "../../../src/features/utility/ElementFinder";
import { DefaultElementSelector } from "../../../src/features/utility/DefaultElementSelector";
import { FakeAdbClient } from "../../fakes/FakeAdbClient";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeTapStrategy } from "../../fakes/FakeTapStrategy";

const node = (id: string, children: ViewHierarchyNode[] = [], left = 10): ViewHierarchyNode => ({
  $: {
    "resource-id": id,
    text: id,
    clickable: true,
    bounds: { left, top: 10, right: left + 5, bottom: 30 },
  },
  node: children,
});
const hierarchy: ViewHierarchyResult = {
  hierarchy: {
    node: node("root", [
      node("cart_B", [node("item_42", [node("remove", [], 70)])]),
      node("cart_A", [
        node("item_73", [node("remove", [], 50)]),
        node("", [node("item_42", [node("", [node("remove", [], 20)])])]),
      ]),
    ]),
  },
  screenWidth: 100,
  screenHeight: 100,
};
const container = { elementId: "item_42", container: { elementId: "cart_A" } };
const query = { elementId: "remove", container, selectionStrategy: "unique" as const };

describe.each(["android", "ios"] as const)("%s scoped action conformance", (platform) => {
  const device = { deviceId: `nested-${platform}`, name: "nested", platform } as BootedDevice;
  const adb = new FakeAdbClient();
  const timer = new FakeTimer();
  const finder = new DefaultElementFinder();

  test.each([true, false])("focus verifies a fresh scoped field, focused=%s", async (focused) => {
    const focusTimer = new FakeTimer();
    focusTimer.enableAutoAdvance();
    const tap = new TapOnElement(device, adb, {
      timer: focusTimer,
      tapStrategy: new FakeTapStrategy(),
      elementSelector: new DefaultElementSelector(finder),
    });
    const after = structuredClone(hierarchy);
    finder.resolveQuery(after, query).node!.$.focused = focused;
    const action = tap as any;
    let reads = 0;
    const initial = { viewHierarchy: hierarchy, screenSize: { width: 100, height: 100 } };
    action.observedInteraction = async (block: (value: unknown) => Promise<unknown>) => ({
      ...(await block(initial)),
      observation: initial,
    });
    action.refreshViewHierarchy = async () => (++reads === 1 ? hierarchy : after);
    action.prepareSelectionCapture = async () => null;
    action.executeAndroidTap = async () => undefined;
    action.executeiOSTap = async () => undefined;
    const result = await tap.execute({ ...query, action: "focus" });
    expect(reads).toBe(2);
    expect(result.success).toBe(focused);
    if (!focused) {
      expect(result.error).toContain("no text was sent");
    }
  });

  test.each(["tap", "doubleTap", "longPress", "focus"] as const)(
    "%s resolves the same descendant",
    (action) => {
      const tap = new TapOnElement(device, adb, {
        timer,
        elementSelector: new DefaultElementSelector(finder),
      });
      const result = (tap as any).findElementInHierarchy({ ...query, action }, hierarchy);
      expect(result.selection.element.bounds.left).toBe(20);
      expect(
        result.selection.query.levels.map((level: { matchCount: number }) => level.matchCount),
      ).toEqual([1, 1, 1]);
    },
  );

  test("drag endpoints and pinch agree with tap while preserving independent scopes", () => {
    const drag = new DragAndDrop(device, adb);
    const pinch = new PinchOn(device, adb, { finder });
    const source = (drag as any).resolveTarget(hierarchy, query, "source");
    const destination = (drag as any).resolveTarget(
      hierarchy,
      {
        ...query,
        container: { ...container, container: { elementId: "cart_B" } },
      },
      "target",
    );
    expect(source.bounds.left).toBe(20);
    expect(destination.bounds.left).toBe(70);
    expect((pinch as any).findContainerElement(query, hierarchy).bounds.left).toBe(20);
    expect(() =>
      (drag as any).resolveTarget(
        hierarchy,
        {
          ...query,
          container: { elementId: "missing" },
        },
        "target",
      ),
    ).toThrow("container_not_found");
  });

  test("sibling resolution retains the chosen scope and cannot reach a peer row", () => {
    const scopedHierarchy: ViewHierarchyResult = {
      ...hierarchy,
      hierarchy: {
        node: node("root", [
          node("cart_A", [node("item_42", [node("label", [], 20), node("remove", [], 30)])]),
          node("cart_B", [node("item_42", [node("label", [], 60), node("remove", [], 70)])]),
        ]),
      },
    };
    const selector = new DefaultElementSelector(finder);
    expect(
      selector.selectClickableSiblingOfResourceId(scopedHierarchy, "label", {
        container,
        strategy: "unique",
      }).element?.bounds.left,
    ).toBe(30);
    expect(
      selector.selectClickableSiblingOfResourceId(scopedHierarchy, "missing", {
        container,
        strategy: "unique",
      }).element,
    ).toBeNull();
  });

  test.each([false, true])(
    "pre-dispatch refresh follows the logical row after recycling (removed=%s)",
    async (removed) => {
      const tap = new TapOnElement(device, adb, {
        timer,
        tapStrategy: new FakeTapStrategy(),
        elementSelector: new DefaultElementSelector(finder),
      });
      const fresh: ViewHierarchyResult = {
        ...hierarchy,
        hierarchy: {
          node: node("root", [
            node("cart_B", [node("item_42", [node("remove", [], 20)])]),
            node("cart_A", removed ? [] : [node("item_42", [node("remove", [], 40)])]),
          ]),
        },
      };
      const calls: number[] = [];
      const action = tap as any;
      action.observedInteraction = async (block: (value: unknown) => Promise<unknown>) =>
        block({ viewHierarchy: hierarchy, screenSize: { width: 100, height: 100 } });
      action.refreshViewHierarchy = async () => fresh;
      action.prepareSelectionCapture = async () => null;
      action.executeAndroidTap = async (_kind: string, x: number) => {
        calls.push(x);
      };
      action.executeiOSTap = async (_kind: string, x: number) => {
        calls.push(x);
      };
      const result = await tap.execute({ ...query, action: "tap" });
      expect(result.success).toBe(!removed);
      expect(calls).toEqual(removed ? [] : [42]);
      if (removed) {
        expect(result.error).toContain("container_not_found");
      }
    },
  );
});

test("a native scoped tap rejection preserves its frame identity and sends no ADB fallback", async () => {
  const adb = new FakeAdbClient();
  const tap = new TapOnElement(
    { deviceId: "scoped-native", platform: "android", name: "test" },
    adb,
    {
      timer: new FakeTimer(),
      tapStrategy: new FakeTapStrategy(),
    },
  );
  const calls: unknown[][] = [];
  const action = tap as any;
  action.accessibilityService = {
    requestTapCoordinates: async (...args: unknown[]) => {
      calls.push(args);
      return { success: false, error: "Stale frame context" };
    },
  };
  await expect(action.executeScopedCoordinateTap("tap", 20, 30, 50, "capture-42")).rejects.toThrow(
    "scoped gesture rejected",
  );
  expect(calls).toEqual([[20, 30, 50, 5000, undefined, "capture-42"]]);
  expect(adb.getCommandCalls()).toHaveLength(0);
});
