import { afterEach, beforeEach, describe, expect, test, spyOn } from "bun:test";
import { TapOnElement } from "../../../src/features/action/TapOnElement";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import { FakeAdbClient } from "../../fakes/FakeAdbClient";
import { FakeCtrlProxy } from "../../fakes/FakeCtrlProxy";
import type { Element } from "../../../src/models/Element";
import { FakeAccessibilityDetector } from "../../fakes/FakeAccessibilityDetector";
import { HierarchyTalkBackDriver as FakeTalkBackNavigationDriver } from "../talkback/HierarchyTalkBackDriver";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeTalkBackTapStrategy } from "../../fakes/FakeTalkBackTapStrategy";
import type { FeatureFlagService } from "../../../src/features/featureFlags/FeatureFlagService";
import {
  TalkBackTapStrategy,
  TALKBACK_ACTIVATION_WARNING,
} from "../../../src/features/talkback/TalkBackTapStrategy";

describe("TapOnElement TalkBack mode detection", () => {
  let fakeAccessibilityDetector: FakeAccessibilityDetector;
  let fakeAdb: FakeAdbClient;
  let fakeTimer: FakeTimer;
  let tapOnElement: TapOnElement;
  let executeAndroidTapWithCoordinates: any;
  let executeAndroidTapWithAccessibility: any;

  beforeEach(() => {
    fakeAccessibilityDetector = new FakeAccessibilityDetector();
    fakeAdb = new FakeAdbClient();
    fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();

    // Create a minimal TapOnElement instance for testing
    tapOnElement = new TapOnElement(
      {
        name: "test-device",
        platform: "android",
        deviceId: "emulator-5554",
      } as any,
      fakeAdb as any,
      {
        accessibilityDetector: fakeAccessibilityDetector,
        timer: fakeTimer,
      },
    );

    // Spy on the private methods to verify dispatch logic
    executeAndroidTapWithCoordinates = spyOn(
      tapOnElement as any,
      "executeAndroidTapWithCoordinates",
    ).mockResolvedValue(undefined);

    executeAndroidTapWithAccessibility = spyOn(
      tapOnElement as any,
      "executeAndroidTapWithAccessibility",
    ).mockResolvedValue(undefined);
  });

  test("unknown TalkBack retries once and warns before the default coordinate tap", async () => {
    fakeAccessibilityDetector.setDefaultResult(null);
    const warnings: string[] = [];
    const element: Element = {
      bounds: { left: 0, top: 0, right: 100, bottom: 100 },
      "resource-id": "test:id/button",
    };
    await tapOnElement.executeAndroidTap("tap", 50, 50, 500, element, undefined, {
      action: "tap",
      onActivationWarning: (warning) => warnings.push(warning),
    });
    expect(fakeAccessibilityDetector.getDetectionCallCount()).toBe(2);
    expect(executeAndroidTapWithCoordinates).toHaveBeenCalledTimes(1);
    expect(executeAndroidTapWithAccessibility).not.toHaveBeenCalled();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("could not determine");
  });

  test.each(["tap", "doubleTap", "longPress"])(
    "XML-only %s never invokes native semantic targeting",
    async (action) => {
      fakeAccessibilityDetector.setTalkBackEnabled(true);
      const element = {
        bounds: { left: 0, top: 0, right: 100, bottom: 100 },
        "resource-id": "repeated:id/row",
        "hierarchy-source": "uiautomator",
      };
      await tapOnElement.executeAndroidTap(action, 50, 50, 500, element);
      expect(executeAndroidTapWithAccessibility).not.toHaveBeenCalled();
      expect(executeAndroidTapWithCoordinates).toHaveBeenCalledWith(
        action,
        50,
        50,
        500,
        element,
        undefined,
        true,
        { displayFence: undefined },
      );
    },
  );

  describe("when TalkBack is disabled", () => {
    beforeEach(() => {
      fakeAccessibilityDetector.setTalkBackEnabled(false);
    });

    test("dispatches to coordinate-based tap method", async () => {
      const element = {
        bounds: { left: 0, top: 0, right: 100, bottom: 100 },
        "resource-id": "test:id/button",
      } as any;

      await tapOnElement.executeAndroidTap("tap", 50, 50, 500, element, undefined, {
        action: "tap",
        elementId: "test:id/button",
      });

      expect(executeAndroidTapWithCoordinates).toHaveBeenCalledTimes(1);
      expect(executeAndroidTapWithAccessibility).not.toHaveBeenCalled();
    });

    test("uses coordinate method for all action types", async () => {
      const element = {
        bounds: { left: 0, top: 0, right: 100, bottom: 100 },
        "resource-id": "test:id/button",
      } as any;

      // Test tap
      await tapOnElement.executeAndroidTap("tap", 50, 50, 500, element);
      expect(executeAndroidTapWithCoordinates).toHaveBeenCalledWith(
        "tap",
        50,
        50,
        500,
        element,
        undefined,
        false,
        { displayFence: undefined, resolvedHierarchy: undefined },
      );

      executeAndroidTapWithCoordinates.mockClear();

      // Test longPress
      await tapOnElement.executeAndroidTap("longPress", 50, 50, 1000, element);
      expect(executeAndroidTapWithCoordinates).toHaveBeenCalledWith(
        "longPress",
        50,
        50,
        1000,
        element,
        undefined,
        false,
        { displayFence: undefined, resolvedHierarchy: undefined },
      );

      executeAndroidTapWithCoordinates.mockClear();

      // Test doubleTap
      await tapOnElement.executeAndroidTap("doubleTap", 50, 50, 500, element);
      expect(executeAndroidTapWithCoordinates).toHaveBeenCalledWith(
        "doubleTap",
        50,
        50,
        500,
        element,
        undefined,
        false,
        { displayFence: undefined, resolvedHierarchy: undefined },
      );
    });
  });

  describe("when TalkBack is enabled", () => {
    beforeEach(() => {
      fakeAccessibilityDetector.setTalkBackEnabled(true);
    });

    test("dispatches to accessibility-based tap method", async () => {
      const element = {
        bounds: { left: 0, top: 0, right: 100, bottom: 100 },
        "resource-id": "test:id/button",
      } as any;

      const options = { action: "tap" as const, elementId: "test:id/button" };

      await tapOnElement.executeAndroidTap("tap", 50, 50, 500, element, undefined, options);

      expect(executeAndroidTapWithAccessibility).toHaveBeenCalledTimes(1);
      expect(executeAndroidTapWithAccessibility).toHaveBeenCalledWith(
        "tap",
        50,
        50,
        element,
        500,
        options,
        undefined,
      );
      expect(executeAndroidTapWithCoordinates).not.toHaveBeenCalled();
    });

    test("delegates TalkBack taps to accessibility activation", async () => {
      const element = {
        bounds: { left: 100, top: 200, right: 500, bottom: 260 },
        "resource-id": "test:id/spannable_text",
        text: "Left link and ordinary text and right link",
      } as any;
      const options = {
        action: "tap" as const,
        elementId: "test:id/spannable_text",
      };

      await tapOnElement.executeAndroidTap("tap", 491, 230, 500, element, undefined, options);

      expect(executeAndroidTapWithAccessibility).toHaveBeenCalledWith(
        "tap",
        491,
        230,
        element,
        500,
        options,
        undefined,
      );
      expect(executeAndroidTapWithCoordinates).not.toHaveBeenCalled();
    });

    test("passes options to accessibility method", async () => {
      const element = {
        bounds: { left: 0, top: 0, right: 100, bottom: 100 },
        "resource-id": "test:id/button",
      } as any;

      const options = {
        action: "tap" as const,
        elementId: "test:id/button",
        focusFirst: false,
      };

      await tapOnElement.executeAndroidTap("tap", 50, 50, 500, element, undefined, options);

      expect(executeAndroidTapWithAccessibility).toHaveBeenCalledWith(
        "tap",
        50,
        50,
        element,
        500,
        options,
        undefined,
      );
    });

    test("dispatches to accessibility-based tap method for element without resource-id", async () => {
      const element = {
        bounds: { left: 0, top: 0, right: 100, bottom: 100 },
        text: "Settings",
      } as any;

      await tapOnElement.executeAndroidTap("tap", 50, 50, 500, element, undefined, {
        action: "tap",
      });

      expect(executeAndroidTapWithAccessibility).toHaveBeenCalledTimes(1);
      expect(executeAndroidTapWithCoordinates).not.toHaveBeenCalled();
    });

    test("uses accessibility method for all action types", async () => {
      const element = {
        bounds: { left: 0, top: 0, right: 100, bottom: 100 },
        "resource-id": "test:id/button",
      } as any;

      // Test tap
      await tapOnElement.executeAndroidTap("tap", 50, 50, 500, element, undefined, {});
      expect(executeAndroidTapWithAccessibility).toHaveBeenCalledWith(
        "tap",
        50,
        50,
        element,
        500,
        {},
        undefined,
      );

      executeAndroidTapWithAccessibility.mockClear();

      // Test longPress
      await tapOnElement.executeAndroidTap("longPress", 50, 50, 1000, element, undefined, {});
      expect(executeAndroidTapWithAccessibility).toHaveBeenCalledWith(
        "longPress",
        50,
        50,
        element,
        1000,
        {},
        undefined,
      );

      executeAndroidTapWithAccessibility.mockClear();

      // Test doubleTap
      await tapOnElement.executeAndroidTap("doubleTap", 50, 50, 500, element, undefined, {});
      expect(executeAndroidTapWithAccessibility).toHaveBeenCalledWith(
        "doubleTap",
        50,
        50,
        element,
        500,
        {},
        undefined,
      );
    });
  });

  describe("TalkBack detection integration", () => {
    test("checks TalkBack state once per tap (no cross-tap caching in the executor)", async () => {
      fakeAccessibilityDetector.setTalkBackEnabled(true);

      const element = {
        bounds: { left: 0, top: 0, right: 100, bottom: 100 },
        "resource-id": "test:id/button",
      } as any;

      // Each executeAndroidTap consults the detector exactly once; two taps
      // therefore produce exactly two checks. (Caching lives in the real
      // AccessibilityDetector, not this executor, and is tested there.)
      await tapOnElement.executeAndroidTap("tap", 50, 50, 500, element, undefined, {});
      expect(fakeAccessibilityDetector.getCheckCount()).toBe(1);

      await tapOnElement.executeAndroidTap("tap", 50, 50, 500, element, undefined, {});
      expect(fakeAccessibilityDetector.getCheckCount()).toBe(2);
    });

    test("respects cache invalidation", async () => {
      fakeAccessibilityDetector.setTalkBackEnabled(false);

      const element = {
        bounds: { left: 0, top: 0, right: 100, bottom: 100 },
        "resource-id": "test:id/button",
      } as any;

      // First call with TalkBack disabled
      await tapOnElement.executeAndroidTap("tap", 50, 50, 500, element, undefined, {});
      expect(executeAndroidTapWithCoordinates).toHaveBeenCalled();
      executeAndroidTapWithCoordinates.mockClear();

      // Invalidate cache and enable TalkBack
      fakeAccessibilityDetector.invalidateCache("emulator-5554");
      fakeAccessibilityDetector.setTalkBackEnabled(true);

      // Second call should detect TalkBack as enabled (new detection)
      await tapOnElement.executeAndroidTap("tap", 50, 50, 500, element, undefined, {});
      expect(executeAndroidTapWithAccessibility).toHaveBeenCalled();
      expect(executeAndroidTapWithCoordinates).not.toHaveBeenCalled();
    });
  });

  describe("clickable parent resolution", () => {
    test("uses clickable parent when child is not clickable", () => {
      const viewHierarchy = {
        hierarchy: {
          node: {
            $: {
              class: "android.widget.LinearLayout",
              clickable: "true",
              bounds: { left: 0, top: 0, right: 100, bottom: 100 },
              "resource-id": "parent:id",
            },
            node: [
              {
                $: {
                  class: "android.widget.TextView",
                  text: "Markup",
                  bounds: { left: 10, top: 10, right: 50, bottom: 50 },
                  "resource-id": "android:id/text1",
                },
              },
            ],
          },
        },
      } as any;

      const childElement = {
        bounds: { left: 10, top: 10, right: 50, bottom: 50 },
        text: "Markup",
        "resource-id": "android:id/text1",
      } as any;

      const result = (tapOnElement as any).resolveTapTargetElement(
        childElement,
        viewHierarchy,
        "tap",
        true,
      );

      expect(result.usedParent).toBe(true);
      expect(result.element["resource-id"]).toBe("parent:id");
    });

    test("resolves text-only child to clickable parent with resource-id under TalkBack (requireResourceId=true)", () => {
      const viewHierarchy = {
        hierarchy: {
          node: {
            $: {
              class: "android.widget.LinearLayout",
              clickable: "true",
              bounds: { left: 0, top: 0, right: 200, bottom: 80 },
              "resource-id": "com.example:id/settings_row",
            },
            node: [
              {
                $: {
                  class: "android.widget.TextView",
                  text: "Settings",
                  bounds: { left: 10, top: 10, right: 190, bottom: 70 },
                  // no resource-id
                },
              },
            ],
          },
        },
      } as any;

      const textOnlyChild = {
        bounds: { left: 10, top: 10, right: 190, bottom: 70 },
        text: "Settings",
        // no resource-id
      } as any;

      // requireResourceId=true simulates TalkBack mode
      const result = (tapOnElement as any).resolveTapTargetElement(
        textOnlyChild,
        viewHierarchy,
        "tap",
        true,
      );

      expect(result.usedParent).toBe(true);
      expect(result.element["resource-id"]).toBe("com.example:id/settings_row");
    });

    test("keeps the selected clickable duplicate after an inert same-ID match", () => {
      const bounds = (top: number) => ({ left: 0, top, right: 100, bottom: top + 40 });
      const viewHierarchy = {
        hierarchy: {
          node: [
            { "resource-id": "app:id/action", bounds: bounds(0) },
            { "resource-id": "app:id/action", clickable: true, bounds: bounds(50) },
            { "resource-id": "app:id/action", clickable: true, bounds: bounds(100) },
          ],
        },
      } as any;
      const selected = {
        "resource-id": "app:id/action",
        clickable: true,
        bounds: bounds(50),
      } as any;
      const result = (tapOnElement as any).resolveTapTargetElement(
        selected,
        viewHierarchy,
        "tap",
        false,
      );
      expect(result.element.bounds).toEqual(bounds(50));
    });

    test("retains an inert bounded child inside the requested clickable container", () => {
      const viewHierarchy = {
        hierarchy: {
          node: {
            "resource-id": "app:id/row",
            clickable: true,
            bounds: { left: 0, top: 0, right: 100, bottom: 100 },
            node: [{ text: "Open", bounds: { left: 10, top: 10, right: 80, bottom: 40 } }],
          },
        },
      } as any;
      const found = (tapOnElement as any).findElementInHierarchy(
        { action: "tap", text: "Open", container: { elementId: "app:id/row" } },
        viewHierarchy,
      );
      expect(found.selection.element?.text).toBe("Open");
    });

    test("uses parent with click action when clickable flag is absent", () => {
      const viewHierarchy = {
        hierarchy: {
          node: {
            $: {
              class: "android.view.View",
              actions: ["click"],
              bounds: { left: 0, top: 0, right: 240, bottom: 96 },
              "resource-id": "com.example:id/action_row",
            },
            node: [
              {
                $: {
                  class: "android.widget.TextView",
                  text: "Manage account",
                  bounds: { left: 24, top: 24, right: 216, bottom: 72 },
                },
              },
            ],
          },
        },
      } as any;

      const textOnlyChild = {
        bounds: { left: 24, top: 24, right: 216, bottom: 72 },
        text: "Manage account",
      } as any;

      const result = (tapOnElement as any).resolveTapTargetElement(
        textOnlyChild,
        viewHierarchy,
        "tap",
        true,
      );

      expect(result.usedParent).toBe(true);
      expect(result.element["resource-id"]).toBe("com.example:id/action_row");
    });

    test("uses parent with long click action for longPress when flag is absent", () => {
      const viewHierarchy = {
        hierarchy: {
          node: {
            $: {
              class: "android.view.View",
              actions: ["long_click"],
              bounds: { left: 0, top: 0, right: 240, bottom: 96 },
              "resource-id": "com.example:id/action_row",
            },
            node: {
              $: {
                class: "android.widget.TextView",
                text: "Manage account",
                bounds: { left: 24, top: 24, right: 216, bottom: 72 },
              },
            },
          },
        },
      } as any;

      const textOnlyChild = {
        bounds: { left: 24, top: 24, right: 216, bottom: 72 },
        text: "Manage account",
      } as any;

      const result = (tapOnElement as any).resolveTapTargetElement(
        textOnlyChild,
        viewHierarchy,
        "longPress",
        true,
      );

      expect(result.usedParent).toBe(true);
      expect(result.element["resource-id"]).toBe("com.example:id/action_row");
    });

    test("prefers long-clickable parent for longPress", () => {
      const viewHierarchy = {
        hierarchy: {
          node: {
            $: {
              class: "android.widget.LinearLayout",
              "long-clickable": "true",
              bounds: { left: 0, top: 0, right: 100, bottom: 100 },
              "resource-id": "parent:long",
            },
            node: {
              $: {
                class: "android.widget.TextView",
                text: "Markup",
                bounds: { left: 10, top: 10, right: 50, bottom: 50 },
              },
            },
          },
        },
      } as any;

      const childElement = {
        bounds: { left: 10, top: 10, right: 50, bottom: 50 },
        text: "Markup",
      } as any;

      const result = (tapOnElement as any).resolveTapTargetElement(
        childElement,
        viewHierarchy,
        "longPress",
        true,
      );

      expect(result.usedParent).toBe(true);
      expect(result.element["resource-id"]).toBe("parent:long");
    });
  });
});

describe("TapOnElement TalkBackTapStrategy delegation", () => {
  let fakeTalkBackStrategy: FakeTalkBackTapStrategy;
  let fakeAccessibilityDetector: FakeAccessibilityDetector;
  let fakeAdb: FakeAdbClient;
  let fakeTimer: FakeTimer;
  let tapOnElement: TapOnElement;
  let executeAndroidTapWithCoordinates: any;

  const makeElement = () =>
    ({
      "resource-id": "test:id/button",
      bounds: { left: 0, top: 0, right: 100, bottom: 100 },
    }) as any;

  beforeEach(() => {
    fakeAccessibilityDetector = new FakeAccessibilityDetector();
    fakeAccessibilityDetector.setTalkBackEnabled(true);
    fakeAdb = new FakeAdbClient();
    fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
    fakeTalkBackStrategy = new FakeTalkBackTapStrategy();

    tapOnElement = new TapOnElement(
      {
        name: "test-device",
        platform: "android",
        deviceId: "emulator-5554",
      } as any,
      fakeAdb as any,
      {
        accessibilityDetector: fakeAccessibilityDetector,
        timer: fakeTimer,
        talkBackStrategy: fakeTalkBackStrategy,
      },
    );

    executeAndroidTapWithCoordinates = spyOn(
      tapOnElement as any,
      "executeAndroidTapWithCoordinates",
    ).mockResolvedValue(undefined);
  });

  describe("default (direct activation)", () => {
    test("tap directly activates the target via ACTION_CLICK, no cursor navigation", async () => {
      const element = makeElement();

      await (tapOnElement as any).executeAndroidTapWithAccessibility(
        "tap",
        50,
        50,
        element,
        500,
        {},
        undefined,
      );

      expect(fakeTalkBackStrategy.directActivationCalls).toHaveLength(1);
      expect(fakeTalkBackStrategy.directActivationCalls[0].element).toBe(element);
      expect(fakeTalkBackStrategy.tapCalls).toHaveLength(0);
      expect(fakeTalkBackStrategy.fallbackCalls).toHaveLength(0);
      expect(executeAndroidTapWithCoordinates).not.toHaveBeenCalled();
    });

    test("tap uses a precise focus and activation gesture when direct activation fails", async () => {
      fakeTalkBackStrategy.setDirectActivationResult({
        success: false,
        method: "accessibility-action",
        error: "no node",
      });
      const element = makeElement();

      await (tapOnElement as any).executeAndroidTapWithAccessibility(
        "tap",
        50,
        50,
        element,
        500,
        {},
        undefined,
      );

      expect(fakeTalkBackStrategy.directActivationCalls).toHaveLength(1);
      expect(fakeTalkBackStrategy.tapCalls).toHaveLength(0);
      expect(fakeTalkBackStrategy.preciseTapCalls).toHaveLength(1);
      expect(fakeTalkBackStrategy.fallbackCalls).toHaveLength(0);
    });

    test("tap falls back to ADB when direct activation and coordinate gesture both fail", async () => {
      fakeTalkBackStrategy.setDirectActivationResult({
        success: false,
        method: "accessibility-action",
        error: "no node",
      });
      fakeTalkBackStrategy.setPreciseTapResult({
        success: false,
        method: "coordinate-fallback",
        error: "fallback failed",
      });
      const element = makeElement();

      await (tapOnElement as any).executeAndroidTapWithAccessibility(
        "tap",
        50,
        50,
        element,
        500,
        {},
        undefined,
      );

      expect(fakeTalkBackStrategy.preciseTapCalls).toHaveLength(1);
      expect(executeAndroidTapWithCoordinates).toHaveBeenCalledWith(
        "tap",
        50,
        50,
        500,
        element,
        undefined,
        false,
        { displayFence: undefined },
      );
    });

    test("doubleTap uses coordinate fallback (no ACTION_CLICK, no cursor navigation)", async () => {
      const element = makeElement();

      await (tapOnElement as any).executeAndroidTapWithAccessibility(
        "doubleTap",
        50,
        50,
        element,
        500,
        {},
        undefined,
      );

      expect(fakeTalkBackStrategy.directActivationCalls).toHaveLength(0);
      expect(fakeTalkBackStrategy.tapCalls).toHaveLength(0);
      expect(fakeTalkBackStrategy.fallbackCalls).toHaveLength(1);
      expect(fakeTalkBackStrategy.fallbackCalls[0].action).toBe("doubleTap");
    });
  });

  describe("opt-in screen-reader navigation (fidelity mode)", () => {
    const navOptions = { screenReaderNavigation: true } as any;

    test("tap drives the cursor via executeTap", async () => {
      fakeTalkBackStrategy.setTapResult({
        success: true,
        method: "focus-navigation",
        screenReaderNavigation: {
          reachable: true,
          traversalOrder: [makeElement()],
          focusTrapDetected: false,
        },
      });
      const element = makeElement();

      const result = await (tapOnElement as any).executeAndroidTapWithAccessibility(
        "tap",
        50,
        50,
        element,
        500,
        navOptions,
        undefined,
      );

      expect(fakeTalkBackStrategy.tapCalls).toHaveLength(1);
      expect(fakeTalkBackStrategy.tapCalls[0].deviceId).toBe("emulator-5554");
      expect(fakeTalkBackStrategy.tapCalls[0].element).toBe(element);
      expect(fakeTalkBackStrategy.directActivationCalls).toHaveLength(0);
      expect(fakeTalkBackStrategy.fallbackCalls).toHaveLength(0);
      expect(result).toMatchObject({ reachable: true, focusTrapDetected: false });
    });

    test("doubleTap also drives the cursor via executeTap (activation is always double-tap)", async () => {
      const element = makeElement();

      await (tapOnElement as any).executeAndroidTapWithAccessibility(
        "doubleTap",
        50,
        50,
        element,
        500,
        navOptions,
        undefined,
      );

      // Both "tap" and "doubleTap" route to executeTap; TalkBack activation is
      // always a double-tap-to-activate, so there is no distinct behavior (#3920).
      expect(fakeTalkBackStrategy.tapCalls).toHaveLength(1);
      expect(fakeTalkBackStrategy.directActivationCalls).toHaveLength(0);
    });

    test("uses precise tap fallback when cursor navigation fails", async () => {
      fakeTalkBackStrategy.setTapResult({
        success: false,
        method: "focus-navigation",
        error: "Navigation failed",
      });
      const element = makeElement();

      await (tapOnElement as any).executeAndroidTapWithAccessibility(
        "tap",
        50,
        50,
        element,
        500,
        navOptions,
        undefined,
      );

      expect(fakeTalkBackStrategy.tapCalls).toHaveLength(1);
      expect(fakeTalkBackStrategy.preciseTapCalls).toHaveLength(1);
      expect(fakeTalkBackStrategy.fallbackCalls).toHaveLength(0);
    });

    test("falls back to ADB when cursor navigation and coordinate gesture both fail", async () => {
      fakeTalkBackStrategy.setTapResult({
        success: false,
        method: "focus-navigation",
        error: "Navigation failed",
      });
      fakeTalkBackStrategy.setPreciseTapResult({
        success: false,
        method: "coordinate-fallback",
        error: "Fallback failed",
      });
      const element = makeElement();

      await (tapOnElement as any).executeAndroidTapWithAccessibility(
        "tap",
        50,
        50,
        element,
        500,
        navOptions,
        undefined,
      );

      expect(fakeTalkBackStrategy.tapCalls).toHaveLength(1);
      expect(fakeTalkBackStrategy.preciseTapCalls).toHaveLength(1);
      expect(executeAndroidTapWithCoordinates).toHaveBeenCalledWith(
        "tap",
        50,
        50,
        500,
        element,
        undefined,
        false,
        { displayFence: undefined },
      );
    });
  });

  // #3937: the `screen-reader-navigation` feature flag is the global opt-in for
  // fidelity mode — it drives cursor traversal even without the per-call option.
  describe("screen-reader-navigation feature flag (global opt-in)", () => {
    const makeFlaggedTapOnElement = (flagEnabled: boolean) => {
      const featureFlags = {
        isEnabled: (key: string) => flagEnabled && key === "screen-reader-navigation",
      } as unknown as FeatureFlagService;
      const tap = new TapOnElement(
        { name: "test-device", platform: "android", deviceId: "emulator-5554" } as any,
        fakeAdb as any,
        {
          accessibilityDetector: fakeAccessibilityDetector,
          timer: fakeTimer,
          talkBackStrategy: fakeTalkBackStrategy,
          featureFlags,
        },
      );
      spyOn(tap as any, "executeAndroidTapWithCoordinates").mockResolvedValue(undefined);
      return tap;
    };

    test("flag ON drives cursor traversal even without the per-call option", async () => {
      const tap = makeFlaggedTapOnElement(true);
      const element = makeElement();

      await (tap as any).executeAndroidTapWithAccessibility(
        "tap",
        50,
        50,
        element,
        500,
        {},
        undefined,
      );

      expect(fakeTalkBackStrategy.tapCalls).toHaveLength(1);
      expect(fakeTalkBackStrategy.tapCalls[0].element).toBe(element);
      expect(fakeTalkBackStrategy.directActivationCalls).toHaveLength(0);
    });

    test("flag OFF keeps the direct-activation default", async () => {
      const tap = makeFlaggedTapOnElement(false);
      const element = makeElement();

      await (tap as any).executeAndroidTapWithAccessibility(
        "tap",
        50,
        50,
        element,
        500,
        {},
        undefined,
      );

      expect(fakeTalkBackStrategy.directActivationCalls).toHaveLength(1);
      expect(fakeTalkBackStrategy.tapCalls).toHaveLength(0);
    });
  });

  describe("longPress (unaffected by navigation mode)", () => {
    test("uses executeLongPress for longPress action", async () => {
      const element = makeElement();

      await (tapOnElement as any).executeAndroidTapWithAccessibility(
        "longPress",
        50,
        50,
        element,
        1000,
        {},
        undefined,
      );

      expect(fakeTalkBackStrategy.tapCalls).toHaveLength(0);
      expect(fakeTalkBackStrategy.directActivationCalls).toHaveLength(0);
      expect(fakeTalkBackStrategy.longPressCalls).toHaveLength(1);
      expect(fakeTalkBackStrategy.longPressCalls[0]).toMatchObject({
        x: 50,
        y: 50,
        durationMs: 1000,
        element,
      });
      expect(fakeTalkBackStrategy.fallbackCalls).toHaveLength(0);
    });

    test("falls back to ADB tap when executeLongPress fails", async () => {
      fakeTalkBackStrategy.setLongPressResult({
        success: false,
        method: "coordinate-fallback",
        error: "Long press failed",
      });
      const element = makeElement();

      await (tapOnElement as any).executeAndroidTapWithAccessibility(
        "longPress",
        50,
        50,
        element,
        1000,
        {},
        undefined,
      );

      expect(fakeTalkBackStrategy.longPressCalls).toHaveLength(1);
      expect(executeAndroidTapWithCoordinates).toHaveBeenCalledWith(
        "longPress",
        50,
        50,
        1000,
        element,
        undefined,
        true,
        { displayFence: undefined },
      );
    });

    test("TalkBack long-press hand-off does not reread or resend the semantic action", async () => {
      executeAndroidTapWithCoordinates.mockRestore();
      const proxy = new FakeCtrlProxy();
      proxy.setHierarchyData({ updatedAt: 1, packageName: "test", hierarchy: {} });
      proxy.setViewHierarchyResult({ hierarchy: { node: { $: makeElement() } } });
      const client = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue(
        proxy as unknown as AndroidCtrlProxyClient,
      );
      let command: TapOnElement;
      try {
        command = new TapOnElement(
          { name: "test-device", platform: "android", deviceId: "talkback-long-press" },
          fakeAdb,
          { timer: fakeTimer, talkBackStrategy: fakeTalkBackStrategy },
        );
      } finally {
        client.mockRestore();
      }
      fakeTalkBackStrategy.setLongPressResult({
        success: false,
        method: "coordinate-fallback",
        error: "gesture unavailable",
      });
      await command.executeAndroidTap(
        "longPress",
        50,
        50,
        1000,
        makeElement(),
        undefined,
        undefined,
        true,
      );
      expect(fakeTalkBackStrategy.longPressCalls).toHaveLength(1);
      expect(proxy.getHierarchyRequestCount()).toBe(0);
      expect(proxy.getActionHistory()).toEqual([]);
      expect(proxy.getNodeActionHistory()).toEqual([]);
      expect(fakeAdb.getAllCommands()).toEqual(["shell input touchscreen swipe 50 50 50 50 1000"]);
    });

    test("reports a rejected advertised semantic long press without a coordinate fallback", async () => {
      fakeTalkBackStrategy.setLongPressResult({
        success: false,
        method: "accessibility-action",
        error: "performAction returned false",
        semanticActionFailure: true,
      });
      const element = makeElement();

      await expect(
        (tapOnElement as any).executeAndroidTapWithAccessibility(
          "longPress",
          50,
          50,
          element,
          1000,
          {},
          undefined,
        ),
      ).rejects.toThrow("Semantic long press failed");

      expect(fakeTalkBackStrategy.longPressCalls).toHaveLength(1);
      expect(executeAndroidTapWithCoordinates).not.toHaveBeenCalled();
    });
  });
});

describe("TapOnElement precise TalkBack coordinate fallback", () => {
  test.each([undefined, "unique"] as const)(
    "focuses the unidentifiable element before activation (selection=%s)",
    async (selectionStrategy) => {
      const accessibilityDetector = new FakeAccessibilityDetector();
      accessibilityDetector.setTalkBackEnabled(true);
      const timer = new FakeTimer();
      timer.enableAutoAdvance();
      const driver = new FakeTalkBackNavigationDriver();
      const events: string[] = [];
      const requestTapCoordinates = driver.requestTapCoordinates.bind(driver);
      const sleep = timer.sleep.bind(timer);
      spyOn(driver, "requestTapCoordinates").mockImplementation(async (x, y, durationMs) => {
        events.push("tap");
        return requestTapCoordinates(x, y, durationMs);
      });
      const doubleTap = driver.requestDoubleTapCoordinates.bind(driver);
      spyOn(driver, "requestDoubleTapCoordinates").mockImplementation(async (...args) => {
        events.push("doubleTap");
        return doubleTap(...args);
      });
      spyOn(timer, "sleep").mockImplementation(async (ms) => {
        events.push(`sleep:${ms}`);
        return sleep(ms);
      });
      const tapOnElement = new TapOnElement(
        { name: "test-device", platform: "android", deviceId: "emulator-5554" },
        null,
        {
          accessibilityDetector,
          timer,
          talkBackStrategy: new TalkBackTapStrategy({ timer }),
          talkBackDriverFactory: { createDriver: () => driver },
        },
      );
      const element = {
        bounds: { left: 0, top: 0, right: 100, bottom: 100 },
        text: "Unidentified action",
      };

      const warnings: string[] = [];
      await tapOnElement.executeAndroidTap("tap", 50, 50, 500, element, undefined, {
        action: "tap",
        selectionStrategy,
        onActivationWarning: (warning) => warnings.push(warning),
      });

      expect(driver.tapHistory).toHaveLength(1);
      expect(driver.doubleTapHistory).toHaveLength(1);
      expect(events).toEqual(["tap", "sleep:500", "doubleTap"]);
      expect(warnings).toEqual([expect.stringContaining("activation is unconfirmed")]);
    },
  );
});

describe("TapOnElement screen-reader navigation result", () => {
  let androidGetInstanceSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    androidGetInstanceSpy = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue(
      {} as AndroidCtrlProxyClient,
    );
  });

  afterEach(() => {
    androidGetInstanceSpy.mockRestore();
  });

  const element = {
    "resource-id": "test:id/button",
    bounds: { left: 0, top: 0, right: 100, bottom: 100 },
    clickable: true,
  } as any;

  const journey = {
    reachable: true,
    traversalOrder: [element],
    focusTrapDetected: false,
  };

  const createCommand = (
    tapResult: any,
    activationWarning?: string,
    coordinate?: { driver: FakeTalkBackNavigationDriver; service: FakeCtrlProxy; element: Element },
  ) => {
    const accessibilityDetector = new FakeAccessibilityDetector();
    accessibilityDetector.setTalkBackEnabled(true);
    const strategy = new FakeTalkBackTapStrategy();
    strategy.setTapResult(tapResult);
    if (activationWarning) {
      strategy.setPreciseTapResult({
        success: true,
        method: "coordinate-fallback",
        warnings: [activationWarning],
      });
    }
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    if (coordinate) {
      androidGetInstanceSpy.mockReturnValue(
        coordinate.service as unknown as AndroidCtrlProxyClient,
      );
    }
    const targetElement = coordinate?.element ?? element;
    const observation = {
      viewHierarchy: { hierarchy: { node: { $: targetElement } } },
      screenSize: { width: 100, height: 100 },
    } as any;
    const command = new TapOnElement(
      { name: "test-device", platform: "android", deviceId: "emulator-5554" } as any,
      new FakeAdbClient() as any,
      {
        accessibilityDetector,
        timer,
        talkBackStrategy: coordinate ? new TalkBackTapStrategy({ timer }) : strategy,
        talkBackDriverFactory: {
          createDriver: () => coordinate?.driver ?? new FakeTalkBackNavigationDriver(),
        },
        waitForCondition: {
          execute: async () => ({
            matched: false,
            candidates: [],
            observation,
            polls: 0,
            waitMs: 0,
            timedOut: true,
          }),
        },
        featureFlags: {
          isEnabled: (key: string) => !coordinate && key === "screen-reader-navigation",
        } as FeatureFlagService,
      },
    );
    command.refreshViewHierarchy = async () => observation.viewHierarchy;
    coordinate?.driver.setElements([targetElement], 0);
    spyOn(command as any, "observedInteraction").mockImplementation(async (block: any) => ({
      ...(await block(observation)),
      observation,
    }));
    spyOn(command as any, "searchForElement").mockResolvedValue({
      selection: { element: targetElement, indexInMatches: 0, totalMatches: 1, strategy: "first" },
      viewHierarchy: observation.viewHierarchy,
      containerFound: true,
      stats: { durationMs: 0, requestCount: 0, changeCount: 0 },
    });
    spyOn(command as any, "resolveTapTargetElement").mockReturnValue({
      element: targetElement,
      usedParent: false,
    });
    if (!coordinate) {
      spyOn(command as any, "executeAndroidTapWithCoordinates").mockResolvedValue(undefined);
    }
    spyOn((command as any).selectionStateTracker, "prepare").mockResolvedValue(null);
    spyOn((command as any).selectionStateTracker, "finalize").mockResolvedValue([]);
    return command;
  };

  const capabilityWarning =
    "TalkBack activation is unconfirmed: the connected device service does not support the single-gesture double tap (tap_double_v1). Update CtrlProxy. The plain coordinate tap path was used instead. Observe the result before retrying.";
  const failedGestureWarning =
    "TalkBack activation is unconfirmed: the TalkBack gesture failed, so the plain coordinate tap path was used instead. Observe the result before retrying.";
  const unidentifiedElement: Element = {
    text: "Unidentified action",
    bounds: { left: 0, top: 0, right: 100, bottom: 100 },
  };

  test.each([undefined, "unique"] as const)(
    "capability absent preserves the legacy fallback dispatch and warns (selection=%s)",
    async (selectionStrategy) => {
      const driver = new FakeTalkBackNavigationDriver();
      driver.doubleTapCapabilitySupported = false;
      const service = new FakeCtrlProxy(new FakeTimer());
      const command = createCommand(undefined, undefined, {
        driver,
        service,
        element: unidentifiedElement,
      });
      const fallback = spyOn(service, "requestTapCoordinates");
      const result = await command.execute({
        action: "tap",
        text: unidentifiedElement.text,
        selectionStrategy,
      });

      expect(result.success).toBe(true);
      expect(driver.tapHistory).toEqual([{ x: 50, y: 50, durationMs: 50 }]);
      expect(driver.doubleTapHistory).toEqual([]);
      // Same CtrlProxy-first dispatchCoordinateTapOrAdbFallback path as the legacy fallback.
      expect(service.getTapHistory()).toEqual([{ x: 50, y: 50, duration: 10 }]);
      expect(fallback).toHaveBeenCalledTimes(1);
      expect(fallback).toHaveBeenCalledWith(
        50,
        50,
        10,
        undefined,
        undefined,
        undefined,
        expect.any(Function),
        undefined,
        undefined,
        undefined,
      );
      expect(result.warnings).toEqual([capabilityWarning]);
    },
  );

  test.each([undefined, "unique"] as const)(
    "capability present sends one activation double tap and warns (selection=%s)",
    async (selectionStrategy) => {
      const driver = new FakeTalkBackNavigationDriver();
      const service = new FakeCtrlProxy(new FakeTimer());
      const command = createCommand(undefined, undefined, {
        driver,
        service,
        element: unidentifiedElement,
      });
      const result = await command.execute({
        action: "tap",
        text: unidentifiedElement.text,
        selectionStrategy,
      });
      expect(result.success).toBe(true);
      expect(driver.tapHistory).toEqual([{ x: 50, y: 50, durationMs: 50 }]);
      expect(driver.doubleTapHistory).toEqual([{ x: 50, y: 50 }]);
      expect(service.getTapHistory()).toEqual([]);
      expect(result.warnings).toEqual([TALKBACK_ACTIVATION_WARNING]);
    },
  );

  test.each([undefined, "unique"] as const)(
    "failed TalkBack gesture uses the legacy fallback and truthful warning (selection=%s)",
    async (selectionStrategy) => {
      const driver = new FakeTalkBackNavigationDriver();
      driver.setTapResult({
        success: false,
        totalTimeMs: 0,
        error: "Focus rejected before dispatch",
      });
      const service = new FakeCtrlProxy(new FakeTimer());
      const command = createCommand(undefined, undefined, {
        driver,
        service,
        element: unidentifiedElement,
      });
      const result = await command.execute({
        action: "tap",
        text: unidentifiedElement.text,
        selectionStrategy,
      });
      expect(result.success).toBe(true);
      expect(driver.doubleTapHistory).toEqual([]);
      expect(service.getTapHistory()).toEqual([{ x: 50, y: 50, duration: 10 }]);
      expect(result.warnings).toEqual([failedGestureWarning]);
    },
  );

  test.each([undefined, "unique"] as const)(
    "TalkBack long press emits no activation warning (selection=%s)",
    async (selectionStrategy) => {
      const driver = new FakeTalkBackNavigationDriver();
      const service = new FakeCtrlProxy(new FakeTimer());
      const command = createCommand(undefined, undefined, {
        driver,
        service,
        element: unidentifiedElement,
      });
      const result = await command.execute({
        action: "longPress",
        text: unidentifiedElement.text,
        selectionStrategy,
      });
      expect(result.success).toBe(true);
      expect(driver.tapHistory).toHaveLength(1);
      expect(driver.doubleTapHistory).toEqual([]);
      expect(result.warnings).toBeUndefined();
    },
  );

  test("ACTION_CLICK succeeds without an activation warning or coordinate gesture", async () => {
    const driver = new FakeTalkBackNavigationDriver();
    driver.doubleTapCapabilitySupported = false;
    const service = new FakeCtrlProxy(new FakeTimer());
    const command = createCommand(undefined, undefined, { driver, service, element });
    const result = await command.execute({ action: "tap", elementId: "test:id/button" });
    expect(result.success).toBe(true);
    expect(result.warnings).toBeUndefined();
    expect(driver.actionHistory).toEqual([{ action: "click", resourceId: "test:id/button" }]);
    expect(driver.tapHistory).toEqual([]);
    expect(driver.doubleTapHistory).toEqual([]);
    expect(service.getTapHistory()).toEqual([]);
  });

  test("public tap result preserves unconfirmed activation warnings", async () => {
    const warning = "TalkBack activation is unconfirmed; the gesture may only have moved focus";
    const command = createCommand({ success: false, method: "focus-navigation" }, warning);
    const result = await command.execute({ action: "tap", elementId: "test:id/button" });
    expect(result.success).toBe(true);
    expect(result.warnings).toEqual([warning]);
  });

  test("returns the successful cursor journey from public execute", async () => {
    const command = createCommand({
      success: true,
      method: "focus-navigation",
      screenReaderNavigation: journey,
    });

    const result = await command.execute({ action: "tap", elementId: "test:id/button" });

    expect(result.success).toBe(true);
    expect(result.screenReaderNavigation).toEqual(journey);
  });

  test("keeps failed reachability evidence after coordinate fallback succeeds", async () => {
    const failedJourney = { ...journey, reachable: false, focusTrapDetected: true };
    const command = createCommand({
      success: false,
      method: "focus-navigation",
      error: "Focus navigation is not converging on the target.",
      screenReaderNavigation: failedJourney,
    });

    const result = await command.execute({ action: "tap", elementId: "test:id/button" });

    expect(result.success).toBe(true);
    expect(result.screenReaderNavigation).toEqual(failedJourney);
  });
});

describe("TapOnElement TalkBack dispatch uncertainty", () => {
  test.each([0, 1])(
    "never sends ADB after coordinate request %s loses its reply",
    async (failedTap) => {
      const detector = new FakeAccessibilityDetector();
      detector.setTalkBackEnabled(true);
      const timer = new FakeTimer();
      timer.enableAutoAdvance();
      const driver = new FakeTalkBackNavigationDriver();
      driver.tapDispatched = true;
      for (let i = 0; i < failedTap; i++) {
        driver.queueTapResult({ success: true, totalTimeMs: 1 });
      }
      driver.queueTapResult({ success: false, totalTimeMs: 5000, error: "Tap timed out" });
      const adb = new FakeAdbClient();
      const tap = new TapOnElement(
        { name: "test-device", platform: "android", deviceId: "emulator-5554" },
        adb,
        {
          accessibilityDetector: detector,
          timer,
          talkBackStrategy: new TalkBackTapStrategy({ timer }),
          talkBackDriverFactory: { createDriver: () => driver },
        },
      );
      await expect(
        tap.executeAndroidTap("tap", 50, 50, 500, {
          text: "No semantic selector",
          bounds: { left: 0, top: 0, right: 100, bottom: 100 },
        }),
      ).rejects.toThrow("outcome is indeterminate");
      expect(driver.getTapCount()).toBe(1);
      expect(driver.doubleTapHistory).toHaveLength(failedTap);
      expect(driver.getActionCount()).toBe(0);
      expect(adb.getCommandCalls()).toEqual([]);
      expect(adb.getSpawnCalls()).toEqual([]);
    },
  );

  test.each([
    {
      dispatched: true,
      acknowledged: false,
      success: false,
      error: "Action timeout after 5000ms",
      taps: 0,
    },
    {
      dispatched: false,
      acknowledged: false,
      success: false,
      error: "WebSocket not connected",
      taps: 1,
    },
    { dispatched: true, acknowledged: true, success: false, error: "node not found", taps: 1 },
    { dispatched: true, acknowledged: true, success: false, error: "Click not supported", taps: 1 },
    { dispatched: true, acknowledged: true, success: true, error: undefined, taps: 0 },
  ])("dispatches only one activation for %j", async ({ taps, ...actionResult }) => {
    const detector = new FakeAccessibilityDetector();
    detector.setTalkBackEnabled(true);
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const driver = new FakeTalkBackNavigationDriver();
    driver.setActionResult({ action: "click", totalTimeMs: 1, ...actionResult });
    const adb = new FakeAdbClient();
    const tap = new TapOnElement(
      { name: "test-device", platform: "android", deviceId: "emulator-5554" },
      adb,
      {
        accessibilityDetector: detector,
        timer,
        talkBackStrategy: new TalkBackTapStrategy({ timer }),
        talkBackDriverFactory: { createDriver: () => driver },
      },
    );
    driver.setElements(
      [{ "resource-id": "test:id/button", bounds: { left: 0, top: 0, right: 100, bottom: 100 } }],
      0,
    );
    const attempt = tap.executeAndroidTap("tap", 50, 50, 500, {
      "resource-id": "test:id/button",
      bounds: { left: 0, top: 0, right: 100, bottom: 100 },
    });
    if (actionResult.dispatched && !actionResult.acknowledged) {
      await expect(attempt).rejects.toThrow("outcome is indeterminate");
    } else {
      await attempt;
    }
    expect(driver.getActionCount()).toBe(1);
    expect(driver.getTapCount()).toBe(taps);
    expect(driver.doubleTapHistory).toHaveLength(taps);
    expect(adb.getCommandCalls()).toEqual([]);
  });
});
