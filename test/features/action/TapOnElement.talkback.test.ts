import { beforeEach, describe, expect, test, spyOn } from "bun:test";
import { TapOnElement } from "../../../src/features/action/TapOnElement";
import { FakeAdbClient } from "../../fakes/FakeAdbClient";
import { FakeAccessibilityDetector } from "../../fakes/FakeAccessibilityDetector";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeTalkBackTapStrategy } from "../../fakes/FakeTalkBackTapStrategy";
import type { FeatureFlagService } from "../../../src/features/featureFlags/FeatureFlagService";

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
        timer: fakeTimer
      }
    );

    // Spy on the private methods to verify dispatch logic
    executeAndroidTapWithCoordinates = spyOn(
      tapOnElement as any,
      "executeAndroidTapWithCoordinates"
    ).mockResolvedValue(undefined);

    executeAndroidTapWithAccessibility = spyOn(
      tapOnElement as any,
      "executeAndroidTapWithAccessibility"
    ).mockResolvedValue(undefined);
  });

  describe("when TalkBack is disabled", () => {
    beforeEach(() => {
      fakeAccessibilityDetector.setTalkBackEnabled(false);
    });

    test("dispatches to coordinate-based tap method", async () => {
      const element = {
        "bounds": { left: 0, top: 0, right: 100, bottom: 100 },
        "resource-id": "test:id/button",
      } as any;

      await (tapOnElement as any).executeAndroidTap(
        "tap",
        50,
        50,
        500,
        element,
        undefined,
        { action: "tap", elementId: "test:id/button" }
      );

      expect(executeAndroidTapWithCoordinates).toHaveBeenCalledTimes(1);
      expect(executeAndroidTapWithAccessibility).not.toHaveBeenCalled();
    });

    test("uses coordinate method for all action types", async () => {
      const element = {
        "bounds": { left: 0, top: 0, right: 100, bottom: 100 },
        "resource-id": "test:id/button",
      } as any;

      // Test tap
      await (tapOnElement as any).executeAndroidTap("tap", 50, 50, 500, element);
      expect(executeAndroidTapWithCoordinates).toHaveBeenCalledWith("tap", 50, 50, 500, element, undefined);

      executeAndroidTapWithCoordinates.mockClear();

      // Test longPress
      await (tapOnElement as any).executeAndroidTap("longPress", 50, 50, 1000, element);
      expect(executeAndroidTapWithCoordinates).toHaveBeenCalledWith("longPress", 50, 50, 1000, element, undefined);

      executeAndroidTapWithCoordinates.mockClear();

      // Test doubleTap
      await (tapOnElement as any).executeAndroidTap("doubleTap", 50, 50, 500, element);
      expect(executeAndroidTapWithCoordinates).toHaveBeenCalledWith("doubleTap", 50, 50, 500, element, undefined);
    });
  });

  describe("when TalkBack is enabled", () => {
    beforeEach(() => {
      fakeAccessibilityDetector.setTalkBackEnabled(true);
    });

    test("dispatches to accessibility-based tap method", async () => {
      const element = {
        "bounds": { left: 0, top: 0, right: 100, bottom: 100 },
        "resource-id": "test:id/button",
      } as any;

      const options = { action: "tap" as const, elementId: "test:id/button" };

      await (tapOnElement as any).executeAndroidTap(
        "tap",
        50,
        50,
        500,
        element,
        undefined,
        options
      );

      expect(executeAndroidTapWithAccessibility).toHaveBeenCalledTimes(1);
      expect(executeAndroidTapWithAccessibility).toHaveBeenCalledWith(
        "tap",
        50,
        50,
        element,
        500,
        options,
        undefined
      );
      expect(executeAndroidTapWithCoordinates).not.toHaveBeenCalled();
    });

    test("uses the requested coordinate instead of semantic activation for a relative position", async () => {
      const element = {
        "bounds": { left: 100, top: 200, right: 500, bottom: 260 },
        "resource-id": "test:id/spannable_text",
        "text": "Left link and ordinary text and right link",
      } as any;
      const options = {
        action: "tap" as const,
        elementId: "test:id/spannable_text",
        relativePosition: { x: 0.98, y: 0.5 },
      };

      await (tapOnElement as any).executeAndroidTap(
        "tap",
        491,
        230,
        500,
        element,
        undefined,
        options
      );

      expect(executeAndroidTapWithCoordinates).toHaveBeenCalledWith(
        "tap",
        491,
        230,
        500,
        element,
        undefined
      );
      expect(executeAndroidTapWithAccessibility).not.toHaveBeenCalled();
    });

    test("passes options to accessibility method", async () => {
      const element = {
        "bounds": { left: 0, top: 0, right: 100, bottom: 100 },
        "resource-id": "test:id/button",
      } as any;

      const options = {
        action: "tap" as const,
        elementId: "test:id/button",
        focusFirst: false,
      };

      await (tapOnElement as any).executeAndroidTap(
        "tap",
        50,
        50,
        500,
        element,
        undefined,
        options
      );

      expect(executeAndroidTapWithAccessibility).toHaveBeenCalledWith(
        "tap",
        50,
        50,
        element,
        500,
        options,
        undefined
      );
    });

    test("dispatches to accessibility-based tap method for element without resource-id", async () => {
      const element = {
        "bounds": { left: 0, top: 0, right: 100, bottom: 100 },
        "text": "Settings",
      } as any;

      await (tapOnElement as any).executeAndroidTap(
        "tap",
        50,
        50,
        500,
        element,
        undefined,
        { action: "tap" }
      );

      expect(executeAndroidTapWithAccessibility).toHaveBeenCalledTimes(1);
      expect(executeAndroidTapWithCoordinates).not.toHaveBeenCalled();
    });

    test("uses accessibility method for all action types", async () => {
      const element = {
        "bounds": { left: 0, top: 0, right: 100, bottom: 100 },
        "resource-id": "test:id/button",
      } as any;

      // Test tap
      await (tapOnElement as any).executeAndroidTap("tap", 50, 50, 500, element, undefined, {});
      expect(executeAndroidTapWithAccessibility).toHaveBeenCalledWith("tap", 50, 50, element, 500, {}, undefined);

      executeAndroidTapWithAccessibility.mockClear();

      // Test longPress
      await (tapOnElement as any).executeAndroidTap("longPress", 50, 50, 1000, element, undefined, {});
      expect(executeAndroidTapWithAccessibility).toHaveBeenCalledWith("longPress", 50, 50, element, 1000, {}, undefined);

      executeAndroidTapWithAccessibility.mockClear();

      // Test doubleTap
      await (tapOnElement as any).executeAndroidTap("doubleTap", 50, 50, 500, element, undefined, {});
      expect(executeAndroidTapWithAccessibility).toHaveBeenCalledWith("doubleTap", 50, 50, element, 500, {}, undefined);
    });
  });

  describe("TalkBack detection integration", () => {
    test("checks TalkBack state once per tap (no cross-tap caching in the executor)", async () => {
      fakeAccessibilityDetector.setTalkBackEnabled(true);

      const element = {
        "bounds": { left: 0, top: 0, right: 100, bottom: 100 },
        "resource-id": "test:id/button",
      } as any;

      // Each executeAndroidTap consults the detector exactly once; two taps
      // therefore produce exactly two checks. (Caching lives in the real
      // AccessibilityDetector, not this executor, and is tested there.)
      await (tapOnElement as any).executeAndroidTap("tap", 50, 50, 500, element, undefined, {});
      expect(fakeAccessibilityDetector.getCheckCount()).toBe(1);

      await (tapOnElement as any).executeAndroidTap("tap", 50, 50, 500, element, undefined, {});
      expect(fakeAccessibilityDetector.getCheckCount()).toBe(2);
    });

    test("respects cache invalidation", async () => {
      fakeAccessibilityDetector.setTalkBackEnabled(false);

      const element = {
        "bounds": { left: 0, top: 0, right: 100, bottom: 100 },
        "resource-id": "test:id/button",
      } as any;

      // First call with TalkBack disabled
      await (tapOnElement as any).executeAndroidTap("tap", 50, 50, 500, element, undefined, {});
      expect(executeAndroidTapWithCoordinates).toHaveBeenCalled();
      executeAndroidTapWithCoordinates.mockClear();

      // Invalidate cache and enable TalkBack
      fakeAccessibilityDetector.invalidateCache("emulator-5554");
      fakeAccessibilityDetector.setTalkBackEnabled(true);

      // Second call should detect TalkBack as enabled (new detection)
      await (tapOnElement as any).executeAndroidTap("tap", 50, 50, 500, element, undefined, {});
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
              "class": "android.widget.LinearLayout",
              "clickable": "true",
              "bounds": { left: 0, top: 0, right: 100, bottom: 100 },
              "resource-id": "parent:id"
            },
            node: [
              {
                $: {
                  "class": "android.widget.TextView",
                  "text": "Markup",
                  "bounds": { left: 10, top: 10, right: 50, bottom: 50 },
                  "resource-id": "android:id/text1"
                }
              }
            ]
          }
        }
      } as any;

      const childElement = {
        "bounds": { left: 10, top: 10, right: 50, bottom: 50 },
        "text": "Markup",
        "resource-id": "android:id/text1"
      } as any;

      const result = (tapOnElement as any).resolveTapTargetElement(
        childElement,
        viewHierarchy,
        "tap",
        true
      );

      expect(result.usedParent).toBe(true);
      expect(result.element["resource-id"]).toBe("parent:id");
    });

    test("resolves text-only child to clickable parent with resource-id under TalkBack (requireResourceId=true)", () => {
      const viewHierarchy = {
        hierarchy: {
          node: {
            $: {
              "class": "android.widget.LinearLayout",
              "clickable": "true",
              "bounds": { left: 0, top: 0, right: 200, bottom: 80 },
              "resource-id": "com.example:id/settings_row"
            },
            node: [
              {
                $: {
                  "class": "android.widget.TextView",
                  "text": "Settings",
                  "bounds": { left: 10, top: 10, right: 190, bottom: 70 }
                  // no resource-id
                }
              }
            ]
          }
        }
      } as any;

      const textOnlyChild = {
        bounds: { left: 10, top: 10, right: 190, bottom: 70 },
        text: "Settings"
        // no resource-id
      } as any;

      // requireResourceId=true simulates TalkBack mode
      const result = (tapOnElement as any).resolveTapTargetElement(
        textOnlyChild,
        viewHierarchy,
        "tap",
        true
      );

      expect(result.usedParent).toBe(true);
      expect(result.element["resource-id"]).toBe("com.example:id/settings_row");
    });

    test("uses parent with click action when clickable flag is absent", () => {
      const viewHierarchy = {
        hierarchy: {
          node: {
            $: {
              "class": "android.view.View",
              "actions": ["click"],
              "bounds": { left: 0, top: 0, right: 240, bottom: 96 },
              "resource-id": "com.example:id/action_row"
            },
            node: [
              {
                $: {
                  "class": "android.widget.TextView",
                  "text": "Manage account",
                  "bounds": { left: 24, top: 24, right: 216, bottom: 72 }
                }
              }
            ]
          }
        }
      } as any;

      const textOnlyChild = {
        bounds: { left: 24, top: 24, right: 216, bottom: 72 },
        text: "Manage account"
      } as any;

      const result = (tapOnElement as any).resolveTapTargetElement(
        textOnlyChild,
        viewHierarchy,
        "tap",
        true
      );

      expect(result.usedParent).toBe(true);
      expect(result.element["resource-id"]).toBe("com.example:id/action_row");
    });

    test("uses parent with long click action for longPress when flag is absent", () => {
      const viewHierarchy = {
        hierarchy: {
          node: {
            $: {
              "class": "android.view.View",
              "actions": ["long_click"],
              "bounds": { left: 0, top: 0, right: 240, bottom: 96 },
              "resource-id": "com.example:id/action_row"
            },
            node: {
              $: {
                "class": "android.widget.TextView",
                "text": "Manage account",
                "bounds": { left: 24, top: 24, right: 216, bottom: 72 }
              }
            }
          }
        }
      } as any;

      const textOnlyChild = {
        bounds: { left: 24, top: 24, right: 216, bottom: 72 },
        text: "Manage account"
      } as any;

      const result = (tapOnElement as any).resolveTapTargetElement(
        textOnlyChild,
        viewHierarchy,
        "longPress",
        true
      );

      expect(result.usedParent).toBe(true);
      expect(result.element["resource-id"]).toBe("com.example:id/action_row");
    });

    test("prefers long-clickable parent for longPress", () => {
      const viewHierarchy = {
        hierarchy: {
          node: {
            $: {
              "class": "android.widget.LinearLayout",
              "long-clickable": "true",
              "bounds": { left: 0, top: 0, right: 100, bottom: 100 },
              "resource-id": "parent:long"
            },
            node: {
              $: {
                class: "android.widget.TextView",
                text: "Markup",
                bounds: { left: 10, top: 10, right: 50, bottom: 50 }
              }
            }
          }
        }
      } as any;

      const childElement = {
        bounds: { left: 10, top: 10, right: 50, bottom: 50 },
        text: "Markup"
      } as any;

      const result = (tapOnElement as any).resolveTapTargetElement(
        childElement,
        viewHierarchy,
        "longPress",
        true
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

  const makeElement = () => ({
    "resource-id": "test:id/button",
    "bounds": { left: 0, top: 0, right: 100, bottom: 100 }
  } as any);

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
        talkBackStrategy: fakeTalkBackStrategy
      }
    );

    executeAndroidTapWithCoordinates = spyOn(
      tapOnElement as any,
      "executeAndroidTapWithCoordinates"
    ).mockResolvedValue(undefined);
  });

  describe("default (direct activation)", () => {
    test("tap directly activates the target via ACTION_CLICK, no cursor navigation", async () => {
      const element = makeElement();

      await (tapOnElement as any).executeAndroidTapWithAccessibility(
        "tap", 50, 50, element, 500, {}, undefined
      );

      expect(fakeTalkBackStrategy.directActivationCalls).toHaveLength(1);
      expect(fakeTalkBackStrategy.directActivationCalls[0].element).toBe(element);
      expect(fakeTalkBackStrategy.tapCalls).toHaveLength(0);
      expect(fakeTalkBackStrategy.fallbackCalls).toHaveLength(0);
      expect(executeAndroidTapWithCoordinates).not.toHaveBeenCalled();
    });

    test("tap falls back to coordinate gesture when direct activation fails", async () => {
      fakeTalkBackStrategy.setDirectActivationResult({
        success: false, method: "accessibility-action", error: "no node"
      });
      const element = makeElement();

      await (tapOnElement as any).executeAndroidTapWithAccessibility(
        "tap", 50, 50, element, 500, {}, undefined
      );

      expect(fakeTalkBackStrategy.directActivationCalls).toHaveLength(1);
      expect(fakeTalkBackStrategy.tapCalls).toHaveLength(0);
      expect(fakeTalkBackStrategy.fallbackCalls).toHaveLength(1);
      expect(fakeTalkBackStrategy.fallbackCalls[0].action).toBe("tap");
    });

    test("tap falls back to ADB when direct activation and coordinate gesture both fail", async () => {
      fakeTalkBackStrategy.setDirectActivationResult({
        success: false, method: "accessibility-action", error: "no node"
      });
      fakeTalkBackStrategy.setFallbackResult({
        success: false, method: "coordinate-fallback", error: "fallback failed"
      });
      const element = makeElement();

      await (tapOnElement as any).executeAndroidTapWithAccessibility(
        "tap", 50, 50, element, 500, {}, undefined
      );

      expect(fakeTalkBackStrategy.fallbackCalls).toHaveLength(1);
      expect(executeAndroidTapWithCoordinates).toHaveBeenCalledWith("tap", 50, 50, 500, element, undefined);
    });

    test("doubleTap uses coordinate fallback (no ACTION_CLICK, no cursor navigation)", async () => {
      const element = makeElement();

      await (tapOnElement as any).executeAndroidTapWithAccessibility(
        "doubleTap", 50, 50, element, 500, {}, undefined
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
          focusTrapDetected: false
        }
      });
      const element = makeElement();

      const result = await (tapOnElement as any).executeAndroidTapWithAccessibility(
        "tap", 50, 50, element, 500, navOptions, undefined
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
        "doubleTap", 50, 50, element, 500, navOptions, undefined
      );

      // Both "tap" and "doubleTap" route to executeTap; TalkBack activation is
      // always a double-tap-to-activate, so there is no distinct behavior (#3920).
      expect(fakeTalkBackStrategy.tapCalls).toHaveLength(1);
      expect(fakeTalkBackStrategy.directActivationCalls).toHaveLength(0);
    });

    test("falls back to coordinate gesture when cursor navigation fails", async () => {
      fakeTalkBackStrategy.setTapResult({
        success: false, method: "focus-navigation", error: "Navigation failed"
      });
      const element = makeElement();

      await (tapOnElement as any).executeAndroidTapWithAccessibility(
        "tap", 50, 50, element, 500, navOptions, undefined
      );

      expect(fakeTalkBackStrategy.tapCalls).toHaveLength(1);
      expect(fakeTalkBackStrategy.fallbackCalls).toHaveLength(1);
      expect(fakeTalkBackStrategy.fallbackCalls[0].action).toBe("tap");
    });

    test("falls back to ADB when cursor navigation and coordinate gesture both fail", async () => {
      fakeTalkBackStrategy.setTapResult({
        success: false, method: "focus-navigation", error: "Navigation failed"
      });
      fakeTalkBackStrategy.setFallbackResult({
        success: false, method: "coordinate-fallback", error: "Fallback failed"
      });
      const element = makeElement();

      await (tapOnElement as any).executeAndroidTapWithAccessibility(
        "tap", 50, 50, element, 500, navOptions, undefined
      );

      expect(fakeTalkBackStrategy.tapCalls).toHaveLength(1);
      expect(fakeTalkBackStrategy.fallbackCalls).toHaveLength(1);
      expect(executeAndroidTapWithCoordinates).toHaveBeenCalledWith("tap", 50, 50, 500, element, undefined);
    });
  });

  // #3937: the `screen-reader-navigation` feature flag is the global opt-in for
  // fidelity mode — it drives cursor traversal even without the per-call option.
  describe("screen-reader-navigation feature flag (global opt-in)", () => {
    const makeFlaggedTapOnElement = (flagEnabled: boolean) => {
      const featureFlags = {
        isEnabled: (key: string) => flagEnabled && key === "screen-reader-navigation"
      } as unknown as FeatureFlagService;
      const tap = new TapOnElement(
        { name: "test-device", platform: "android", deviceId: "emulator-5554" } as any,
        fakeAdb as any,
        {
          accessibilityDetector: fakeAccessibilityDetector,
          timer: fakeTimer,
          talkBackStrategy: fakeTalkBackStrategy,
          featureFlags
        }
      );
      spyOn(tap as any, "executeAndroidTapWithCoordinates").mockResolvedValue(undefined);
      return tap;
    };

    test("flag ON drives cursor traversal even without the per-call option", async () => {
      const tap = makeFlaggedTapOnElement(true);
      const element = makeElement();

      await (tap as any).executeAndroidTapWithAccessibility(
        "tap", 50, 50, element, 500, {}, undefined
      );

      expect(fakeTalkBackStrategy.tapCalls).toHaveLength(1);
      expect(fakeTalkBackStrategy.tapCalls[0].element).toBe(element);
      expect(fakeTalkBackStrategy.directActivationCalls).toHaveLength(0);
    });

    test("flag OFF keeps the direct-activation default", async () => {
      const tap = makeFlaggedTapOnElement(false);
      const element = makeElement();

      await (tap as any).executeAndroidTapWithAccessibility(
        "tap", 50, 50, element, 500, {}, undefined
      );

      expect(fakeTalkBackStrategy.directActivationCalls).toHaveLength(1);
      expect(fakeTalkBackStrategy.tapCalls).toHaveLength(0);
    });
  });

  describe("longPress (unaffected by navigation mode)", () => {
    test("uses executeLongPress for longPress action", async () => {
      const element = makeElement();

      await (tapOnElement as any).executeAndroidTapWithAccessibility(
        "longPress", 50, 50, element, 1000, {}, undefined
      );

      expect(fakeTalkBackStrategy.tapCalls).toHaveLength(0);
      expect(fakeTalkBackStrategy.directActivationCalls).toHaveLength(0);
      expect(fakeTalkBackStrategy.longPressCalls).toHaveLength(1);
      expect(fakeTalkBackStrategy.longPressCalls[0]).toMatchObject({
        x: 50, y: 50, durationMs: 1000, element
      });
      expect(fakeTalkBackStrategy.fallbackCalls).toHaveLength(0);
    });

    test("falls back to ADB tap when executeLongPress fails", async () => {
      fakeTalkBackStrategy.setLongPressResult({
        success: false, method: "coordinate-fallback", error: "Long press failed"
      });
      const element = makeElement();

      await (tapOnElement as any).executeAndroidTapWithAccessibility(
        "longPress", 50, 50, element, 1000, {}, undefined
      );

      expect(fakeTalkBackStrategy.longPressCalls).toHaveLength(1);
      expect(executeAndroidTapWithCoordinates).toHaveBeenCalledWith("longPress", 50, 50, 1000, element, undefined);
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
          "longPress", 50, 50, element, 1000, {}, undefined
        )
      ).rejects.toThrow("Semantic long press failed");

      expect(fakeTalkBackStrategy.longPressCalls).toHaveLength(1);
      expect(executeAndroidTapWithCoordinates).not.toHaveBeenCalled();
    });
  });
});

describe("TapOnElement screen-reader navigation result", () => {
  const element = {
    "resource-id": "test:id/button",
    "bounds": { left: 0, top: 0, right: 100, bottom: 100 },
    "clickable": true
  } as any;

  const journey = {
    reachable: true,
    traversalOrder: [element],
    focusTrapDetected: false
  };

  const createCommand = (tapResult: any) => {
    const accessibilityDetector = new FakeAccessibilityDetector();
    accessibilityDetector.setTalkBackEnabled(true);
    const strategy = new FakeTalkBackTapStrategy();
    strategy.setTapResult(tapResult);
    const command = new TapOnElement(
      { name: "test-device", platform: "android", deviceId: "emulator-5554" } as any,
      new FakeAdbClient() as any,
      {
        accessibilityDetector,
        timer: new FakeTimer(),
        talkBackStrategy: strategy,
        featureFlags: { isEnabled: (key: string) => key === "screen-reader-navigation" } as FeatureFlagService
      }
    );
    const observation = {
      viewHierarchy: { hierarchy: {} },
      screenSize: { width: 100, height: 100 }
    } as any;
    spyOn(command as any, "observedInteraction").mockImplementation(async (block: any) => ({
      ...(await block(observation)),
      observation
    }));
    spyOn(command as any, "searchForElement").mockResolvedValue({
      selection: { element, indexInMatches: 0, totalMatches: 1, strategy: "first" },
      viewHierarchy: observation.viewHierarchy,
      containerFound: true,
      stats: { durationMs: 0, requestCount: 0, changeCount: 0 }
    });
    spyOn(command as any, "resolveTapTargetElement").mockReturnValue({ element, usedParent: false });
    spyOn((command as any).selectionStateTracker, "prepare").mockResolvedValue(null);
    spyOn((command as any).selectionStateTracker, "finalize").mockResolvedValue([]);
    return command;
  };

  test("returns the successful cursor journey from public execute", async () => {
    const command = createCommand({ success: true, method: "focus-navigation", screenReaderNavigation: journey });

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
      screenReaderNavigation: failedJourney
    });

    const result = await command.execute({ action: "tap", elementId: "test:id/button" });

    expect(result.success).toBe(true);
    expect(result.screenReaderNavigation).toEqual(failedJourney);
  });
});
