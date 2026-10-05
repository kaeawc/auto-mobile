import { describe, expect, test, spyOn } from "bun:test";
import { TapOnElement } from "../../../src/features/action/TapOnElement";
import { TapAnyElement } from "../../../src/features/action/TapAnyElement";
import { ResolverElementSelector } from "../../../src/features/utility/ResolverElementSelector";
import { ElementResolver } from "../../../src/features/utility/ElementResolver";
import type { AdbClient } from "../../../src/utils/android-cmdline-tools/AdbClient";
import type { Element, TapOnElementOptions, ViewHierarchyResult } from "../../../src/models";
import {
  encodeAndroidFlat,
  encodeIosDollar,
  type LogicalNode,
} from "../../fixtures/hierarchyArbitraries";
import { FakeAdbClient } from "../../fakes/FakeAdbClient";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeTapStrategy } from "../../fakes/FakeTapStrategy";
import { FakeAccessibilityDetector } from "../../fakes/FakeAccessibilityDetector";

import { FakeTalkBackTapStrategy } from "../../fakes/FakeTalkBackTapStrategy";
import { FakeTalkBackNavigationDriver } from "../../fakes/FakeTalkBackNavigationDriver";
import { FakeIOSCtrlProxy } from "../../fakes/FakeIOSCtrlProxy";
import { FakeIosVoiceOverDetector } from "../../fakes/FakeIosVoiceOverDetector";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android/AndroidCtrlProxyClient";
import { IOSCtrlProxyClient } from "../../../src/features/observe/ios/IOSCtrlProxyClient";

const scope = { elementId: "item_42", container: { elementId: "cart_A" } };
function node(id: string, children: LogicalNode[] = [], top = 0): LogicalNode {
  return {
    attrs: { "resource-id": id, text: id, clickable: id === "remove" },
    bounds: { left: 0, top, right: 100, bottom: top + 20 },
    children,
  };
}
function capture(
  duplicate: "none" | "cart" | "item" | "target" | "missing-target" = "none",
): ViewHierarchyResult {
  const item = node("item_42", [node("", [node("remove", [], 40)])]);
  if (duplicate === "missing-target") {
    item.children = [];
  }
  const items = [node("", [item]), node("item_73", [node("remove", [], 80)])];
  if (duplicate === "item") {
    items.push(node("item_42"));
  }
  if (duplicate === "target") {
    item.children.push(...Array.from({ length: 6 }, (_, i) => node("remove", [], 100 + i * 20)));
  }
  const carts = [
    node("cart_A", items),
    node("cart_B", [node("item_42", [node("remove", [], 250)])]),
  ];
  if (duplicate === "cart") {
    carts.push(node("cart_A"));
  }
  return {
    screenWidth: 500,
    screenHeight: 500,
    hierarchy: { node: encodeAndroidFlat(node("", carts)) },
  };
}
class RecordingTapOn extends TapOnElement {
  readonly taps: Element[] = [];
  override async prepareSelectionCapture() {
    return null;
  }
  override async executeAndroidTap(
    _action: string,
    _x: number,
    _y: number,
    _duration: number,
    element: Element,
  ) {
    this.taps.push(element);
    return undefined;
  }
}
class RecordingSelector extends ResolverElementSelector {
  readonly clickableOptions: Parameters<ResolverElementSelector["selectClickable"]>[1][] = [];
  override selectClickable(
    capture: ViewHierarchyResult,
    options: Parameters<ResolverElementSelector["selectClickable"]>[1] = {},
  ) {
    this.clickableOptions.push(options);
    return super.selectClickable(capture, options);
  }
}
function harness(kind: "tapOn" | "tapAny", hierarchy: ViewHierarchyResult) {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const adb = new FakeAdbClient();
  const device = { name: "nested-test", deviceId: "fake-device", platform: "android" as const };
  const selector = new RecordingSelector(new ElementResolver(() => 0));
  const detector = new FakeAccessibilityDetector();
  const talkBack = new FakeTalkBackTapStrategy();
  const driver = new FakeTalkBackNavigationDriver();
  const nativeActions: string[] = [];
  const coordinateTaps: { x: number; y: number }[] = [];
  const accessibilityService = {
    requestTapCoordinates: async (x: number, y: number) => {
      coordinateTaps.push({ x, y });
      return { success: true, totalTimeMs: 1 };
    },
    requestAction: async (action: string) => {
      nativeActions.push(action);
      return { success: true, action, totalTimeMs: 1 };
    },
    requestNodeAction: async (action: string) => {
      nativeActions.push(action);
      return { success: true, action, totalTimeMs: 1 };
    },
    supportsNodeActionSelectors: async () => true,
  };
  const action =
    kind === "tapOn"
      ? new RecordingTapOn(device, adb as AdbClient, {
          timer,
          elementSelector: selector,
          tapStrategy: new FakeTapStrategy(),
        })
      : new TapAnyElement(device, adb as AdbClient, {
          timer,
          elementSelector: selector,
          accessibilityDetector: detector,
          talkBackStrategy: talkBack,
          talkBackDriverFactory: { createDriver: () => driver },
          accessibilityService,
        });
  if (action instanceof TapAnyElement) {
    action.setRefreshViewHierarchyForTesting(async () => null);
  }
  action.observedInteraction = (callback) =>
    callback({ viewHierarchy: hierarchy, screenSize: { width: 500, height: 500 } });
  const execute = (options: Partial<TapOnElementOptions> = {}) => {
    const request = {
      elementId: "remove",
      action: "tap" as const,
      container: scope,
      selectionStrategy: "unique" as const,
      verification: { refresh: async () => null },
      ...options,
    };
    return action.execute(request);
  };
  const taps = () =>
    action instanceof RecordingTapOn
      ? action.taps.length
      : coordinateTaps.length +
        adb
          .getCommandCalls()
          .filter(
            ({ command }) =>
              command.includes("input tap") ||
              command.includes("input touchscreen tap") ||
              command.includes("input touchscreen swipe"),
          ).length;
  return { action, execute, taps, selector, detector, talkBack, nativeActions };
}
for (const kind of ["tapOn", "tapAny"] as const) {
  describe(`${kind} nested containers`, () => {
    test("unique traverses anonymous wrappers and excludes other items/carts", async () => {
      const h = harness(kind, capture());
      const result = await h.execute();
      expect(result.success).toBe(true);
      expect(result.element.bounds.top).toBe(40);
      expect(h.taps()).toBe(1);
    });
    test.each(["cart", "item", "target"] as const)(
      "ambiguous %s fails before dispatch with candidates",
      async (duplicate) => {
        const h = harness(kind, capture(duplicate));
        const result = await h.execute();
        expect(result.success).toBe(false);
        expect(result.error).toContain(
          duplicate === "target"
            ? "Target ambiguous: 7 matches"
            : `Container level ${duplicate === "cart" ? 1 : 2} ambiguous:`,
        );
        expect(result.error).toContain("Candidates:");
        expect(result.error).toContain("bounds=");
        expect(h.taps()).toBe(0);
      },
    );
    test.each([
      [
        { elementId: "item_42", container: { elementId: "missing" } },
        "Container level 1 not found: missing",
      ],
      [
        { elementId: "missing", container: { elementId: "cart_A" } },
        "Container level 2 not found: missing",
      ],
    ] as const)("missing scope %p fails without global fallback", async (container, error) => {
      const h = harness(kind, capture());
      const result = await h.execute({ container });
      expect(result.success).toBe(false);
      expect(result.error).toContain(error);
      expect(h.taps()).toBe(0);
    });
    test("missing target stays within the selected item despite outside duplicates", async () => {
      const h = harness(kind, capture("missing-target"));
      const result = await h.execute();
      expect(result.success).toBe(false);
      expect(result.error).toContain("Target not found within container");
      expect(h.taps()).toBe(0);
    });
    test("default first still selects the first scoped candidate", async () => {
      const h = harness(kind, capture("target"));
      const result = await h.execute({ selectionStrategy: undefined });
      expect(result.success).toBe(true);
      expect(result.element.bounds.top).toBe(40);
      expect(h.taps()).toBe(1);
    });
    test("indexed containers disambiguate only their own level", async () => {
      const h = harness(kind, capture("item"));
      const result = await h.execute({ container: { ...scope, index: 0 } });
      expect(result.success).toBe(true);
      expect(h.taps()).toBe(1);
    });
  });
}
test("target missing within a resolved container is distinct and never taps", async () => {
  const h = harness("tapOn", capture());
  const result = await h.execute({ elementId: "missing" });
  expect(result.error).toContain("Target not found within container");
  expect(h.taps()).toBe(0);
});
test("unique cannot be weakened by a per-container first strategy", async () => {
  const h = harness("tapOn", capture("cart"));
  const result = await h.execute({
    container: {
      ...scope,
      selectionStrategy: "first",
      container: { elementId: "cart_A", selectionStrategy: "first" },
    },
  });
  expect(result.error).toContain("Container level 1 ambiguous:");
  expect(h.taps()).toBe(0);
});
test("ambiguity lists at most five resource IDs, texts and bounds", () => {
  const h = harness("tapOn", capture("target"));
  expect(() =>
    h.selector.selectByResourceId(capture("target"), "remove", {
      container: scope,
      strategy: "unique",
    }),
  ).toThrow(/Candidates:.*resourceId=.*text=.*bounds=/);
  try {
    h.selector.selectByResourceId(capture("target"), "remove", {
      container: scope,
      strategy: "unique",
    });
  } catch (error) {
    expect(String(error).match(/bounds=/g)).toHaveLength(5);
    return;
  }
  throw new Error("Expected target ambiguity");
});

test("tapAny re-resolves the full scoped unique selector on retry", async () => {
  const hierarchy = capture();
  const h = harness("tapAny", hierarchy);
  if (!(h.action instanceof TapAnyElement)) {
    throw new Error("Expected tapAny");
  }
  h.action.setRefreshViewHierarchyForTesting(async () => hierarchy);
  const result = await h.execute();
  expect(result.success).toBe(true);
  expect(h.selector.clickableOptions).toHaveLength(2);
  for (const options of h.selector.clickableOptions) {
    expect(options).toMatchObject({ container: scope, strategy: "unique" });
  }
  expect(h.taps()).toBe(2);
});
for (const action of ["tap", "longPress", "doubleTap"] as const) {
  test(`tapOn ${action} re-finds nested unique scope during stability polling`, async () => {
    const hierarchy = capture();
    const h = harness("tapOn", hierarchy);
    if (!(h.action instanceof TapOnElement)) {
      throw new Error("Expected tapOn");
    }
    let refreshes = 0;
    const result = await h.action.resolveAndroidStableTapTargetAfterRefreshes(
      {
        action,
        elementId: "remove",
        container: scope,
        selectionStrategy: "unique",
        verification: {
          refresh: async () => {
            refreshes += 1;
            return capture();
          },
        },
      },
      { viewHierarchy: hierarchy },
      action,
      false,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.tapElement.bounds.top).toBe(40);
    }
    expect(refreshes).toBeGreaterThan(1);
    expect(h.taps()).toBe(0);
  });
}
test("tapOn stability polling fails if a refreshed container becomes ambiguous", async () => {
  const h = harness("tapOn", capture());
  if (!(h.action instanceof TapOnElement)) {
    throw new Error("Expected tapOn");
  }
  await expect(
    h.action.resolveAndroidStableTapTargetAfterRefreshes(
      {
        action: "tap",
        elementId: "remove",
        container: scope,
        selectionStrategy: "unique",
        verification: { refresh: async () => capture("item") },
      },
      { viewHierarchy: capture() },
      "tap",
      false,
    ),
  ).rejects.toThrow("Container level 2 ambiguous");
  expect(h.taps()).toBe(0);
});
test("adapter resolves semantic owners through the same nested container path", () => {
  const selector = new ResolverElementSelector();
  expect(selector.resolveContainer(capture(), scope, "unique")?.["resource-id"]).toBe("item_42");
  expect(() => selector.resolveContainer(capture("item"), scope, "unique")).toThrow(
    "Container level 2 ambiguous",
  );
});
test("a leaf index overrides uniqueness while unindexed outer scopes stay unique", async () => {
  const h = harness("tapOn", capture("target"));
  expect((await h.execute({ index: 1 })).success).toBe(true);
  expect(h.taps()).toBe(1);
  const ambiguous = harness("tapOn", capture("cart"));
  expect((await ambiguous.execute({ index: 0 })).error).toContain("Container level 1 ambiguous");
  expect(ambiguous.taps()).toBe(0);
});

test("unique finds an inert leaf but refuses bounds outside its container", async () => {
  const leaf = node("remove", [], 40);
  leaf.attrs.clickable = false;
  const item = node("item_42", [node("", [leaf])]);
  item.attrs.clickable = true;
  const hierarchy = { hierarchy: { node: encodeAndroidFlat(node("cart_A", [item])) } };
  const h = harness("tapOn", hierarchy);
  const result = await h.execute();
  expect(result.success).toBe(false);
  expect(result.error).toContain("has no visible tap area");
  expect(h.taps()).toBe(0);
});
test("unbounded containers remain valid scope nodes across anonymous wrappers", async () => {
  const item = node("item_42", [node("", [node("remove", [], 40)])]);
  delete item.bounds;
  const cart = node("cart_A", [node("", [item])]);
  delete cart.bounds;
  const h = harness("tapOn", { hierarchy: { node: encodeAndroidFlat(cart) } });
  expect((await h.execute()).success).toBe(true);
  expect(h.taps()).toBe(1);
});

test("unique ensureChecked refreshes the scoped toggle and skips an already-checked target", async () => {
  const toggle = node("remove", [], 40);
  toggle.attrs.checkable = true;
  toggle.attrs.checked = true;
  const hierarchy = {
    hierarchy: { node: encodeAndroidFlat(node("cart_A", [node("item_42", [toggle])])) },
  };
  const h = harness("tapOn", hierarchy);
  let refreshes = 0;
  const request = {
    action: "tap" as const,
    elementId: "remove",
    container: scope,
    selectionStrategy: "unique" as const,
    ensureChecked: true,
    verification: {
      refresh: async () => {
        refreshes += 1;
        return hierarchy;
      },
    },
  };
  const result = await h.action.execute(request);
  expect(result.success).toBe(true);
  expect(result.skipped).toBe("already-checked");
  expect(refreshes).toBe(1);
  expect(h.taps()).toBe(0);
});
test("unique subtext resolves an inert owner within the nested scope", () => {
  const h = harness("tapOn", capture());
  if (!(h.action instanceof TapOnElement)) {
    throw new Error("Expected tapOn");
  }
  const found = h.action.findElementInHierarchy(
    {
      action: "tap",
      elementId: "item_42",
      container: { elementId: "cart_A" },
      selectionStrategy: "unique",
      subtext: { text: "Terms" },
    },
    capture(),
  );
  expect(found.selection.element?.["resource-id"]).toBe("item_42");
  expect(found.selection.strategy).toBe("unique");
  expect(h.taps()).toBe(0);
});
test("unique sibling and direct semantic links fail runtime validation before dispatch", async () => {
  for (const options of [{ sibling: true }, { elementId: undefined, accessibilityLink: "Terms" }]) {
    const h = harness("tapOn", capture());
    expect((await h.execute(options)).error).toContain(
      "unique selection cannot use sibling or direct accessibilityLink",
    );
    expect(h.taps()).toBe(0);
  }
});

test("unique textAny skips missing variants within the same nested scope", async () => {
  const h = harness("tapOn", capture());
  const result = await h.execute({ elementId: undefined, textAny: ["missing", "remove"] });
  expect(result.success).toBe(true);
  expect(result.element.bounds.top).toBe(40);
  expect(h.taps()).toBe(1);
});
test("unique textAny never skips an ambiguous variant or container", async () => {
  for (const duplicate of ["item", "target"] as const) {
    const h = harness("tapOn", capture(duplicate));
    const result = await h.execute({ elementId: undefined, textAny: ["remove", "missing"] });
    expect(result.success).toBe(false);
    expect(result.error).toContain("ambiguous");
    expect(h.taps()).toBe(0);
  }
});

for (const action of ["tap", "longPress"] as const) {
  test(`tapOn scoped ${action} bypasses global native ID activation`, async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const talkBack = new FakeTalkBackTapStrategy();
    const adb = new FakeAdbClient();
    const driver = new FakeTalkBackNavigationDriver();
    const tap = new TapOnElement(
      { name: "fake", platform: "android", deviceId: "fake-native" },
      adb as AdbClient,
      { timer, talkBackStrategy: talkBack, talkBackDriverFactory: { createDriver: () => driver } },
    );
    const element = new ResolverElementSelector().selectByResourceId(capture(), "remove", {
      container: scope,
      strategy: "unique",
    }).element;
    if (!element) {
      throw new Error("Expected scoped target");
    }
    await tap.executeAndroidTap(
      action,
      50,
      50,
      500,
      element,
      undefined,
      { action, container: scope, selectionStrategy: "unique" },
      true,
    );
    expect(talkBack.directActivationCalls).toHaveLength(0);
    expect(talkBack.longPressCalls).toHaveLength(0);
    expect(action === "tap" ? talkBack.preciseTapCalls : talkBack.fallbackCalls).toHaveLength(1);
    expect(adb.getCommandCalls()).toHaveLength(0);
  });
  test(`tapAny scoped TalkBack ${action} bypasses global native ID activation`, async () => {
    const h = harness("tapAny", capture());
    h.detector.setDefaultResult(true, "talkback");
    if (h.action instanceof TapAnyElement) {
      let captures = 0;
      h.action.setRefreshViewHierarchyForTesting(async () => (++captures === 1 ? capture() : null));
    }
    expect((await h.execute({ action })).success).toBe(true);
    expect(h.talkBack.directActivationCalls).toHaveLength(0);
    expect(h.talkBack.longPressCalls).toHaveLength(0);
    expect(action === "tap" ? h.talkBack.preciseTapCalls : h.talkBack.fallbackCalls).toHaveLength(
      1,
    );
    expect(h.nativeActions).toHaveLength(0);
  });
}
test("tapAny scoped long press does not reselect a global native resource ID", async () => {
  const h = harness("tapAny", capture());
  expect((await h.execute({ action: "longPress" })).success).toBe(true);
  expect(h.nativeActions).toHaveLength(0);
  expect(h.taps()).toBe(1);
});
test("tapOn scoped long press does not reselect a global native resource ID", async () => {
  const adb = new FakeAdbClient();
  const timer = new FakeTimer();
  const tap = new TapOnElement(
    { name: "fake", platform: "android", deviceId: "fake-long" },
    adb as AdbClient,
    { timer },
  );
  const element = new ResolverElementSelector().selectByResourceId(capture(), "remove", {
    container: scope,
    strategy: "unique",
  }).element;
  if (!element) {
    throw new Error("Expected scoped target");
  }
  const native = spyOn(
    AndroidCtrlProxyClient.getInstance({
      name: "fake",
      platform: "android",
      deviceId: "fake-long",
    }),
    "requestAction",
  ).mockResolvedValue({ success: true, action: "long_click", totalTimeMs: 1 });
  try {
    await tap.executeAndroidTap(
      "longPress",
      50,
      50,
      500,
      element,
      undefined,
      { action: "longPress", container: scope, selectionStrategy: "unique" },
      false,
    );
    expect(native).not.toHaveBeenCalled();
    expect(adb.getCommandCalls().map(({ command }) => command)).toEqual([
      "shell input touchscreen swipe 50 50 50 50 500",
    ]);
  } finally {
    native.mockRestore();
  }
});
test.each([true, false])(
  "tapAny scoped VoiceOver activation is bounded (label=%s)",
  async (labelled) => {
    const client = new FakeIOSCtrlProxy();
    const override = spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue(
      client as IOSCtrlProxyClient,
    );
    try {
      const detector = new FakeIosVoiceOverDetector();
      detector.setVoiceOverEnabled(true);
      const timer = new FakeTimer();
      timer.enableAutoAdvance();
      const leaf = node("remove", [], 40);
      if (!labelled) {
        leaf.attrs.text = "";
      }
      const item = node("item_42", [leaf]);
      const cart = node("cart_A", [item]);
      item.bounds = cart.bounds = { left: 0, top: 0, right: 500, bottom: 500 };
      const hierarchy = {
        screenWidth: 500,
        screenHeight: 500,
        hierarchy: { node: encodeIosDollar(cart) },
      };
      const tap = new TapAnyElement({ name: "fake", platform: "ios", deviceId: "fake-ios" }, null, {
        timer,
        iosVoiceOverDetector: detector,
      });
      tap.observedInteraction = (callback) =>
        callback({ viewHierarchy: hierarchy, screenSize: { width: 500, height: 500 } });
      const result = await tap.execute({
        action: "tap",
        container: scope,
        selectionStrategy: "unique",
      });
      if (!labelled) {
        expect(result.success).toBe(false);
        expect(result.error).toContain("Scoped VoiceOver activation requires a label");
        expect(client.getActionHistory()).toHaveLength(0);
        expect(client.getVoiceOverActivateHistory()).toHaveLength(0);
        return;
      }
      expect(result).toMatchObject({ success: true });
      expect(client.getActionHistory()).toHaveLength(0);
      expect(client.getVoiceOverActivateHistory()).toEqual([
        {
          label: "remove",
          action: "activate",
          bounds: { left: 0, top: 40, right: 100, bottom: 60 },
        },
      ]);
    } finally {
      override.mockRestore();
    }
  },
);
