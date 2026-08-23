import { describe, expect, test } from "bun:test";
import type { Element, ObserveResult, ViewHierarchyResult } from "../../../src/models";
import {
  discardHierarchyDerivedData,
  enforceHierarchyPlatform,
  RealHierarchyPlatformValidator,
} from "../../../src/features/observe/HierarchyPlatformValidator";

describe("RealHierarchyPlatformValidator", () => {
  const validator = new RealHierarchyPlatformValidator();

  describe("Android device", () => {
    test("accepts Android hierarchy with android.* class prefix", () => {
      const viewHierarchy: ViewHierarchyResult = {
        hierarchy: {
          node: {
            $: {
              class: "android.widget.FrameLayout",
              bounds: { left: 0, top: 0, right: 1080, bottom: 1920 },
            },
          },
        },
        density: 440,
        sdkInt: 34,
        foregroundActivity: "com.example.app/.MainActivity",
      };

      expect(validator.validate("android", viewHierarchy)).toEqual({ valid: true });
    });

    test("rejects raw iOS hierarchy (XCUIElementTypeApplication)", () => {
      const viewHierarchy = {
        hierarchy: {
          type: "XCUIElementTypeApplication",
          bundleId: "com.example.app",
          bounds: { left: 0, top: 0, right: 390, bottom: 844 },
        },
        screenScale: 3.0,
      } as unknown as ViewHierarchyResult;

      const result = validator.validate("android", viewHierarchy);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("iOS hierarchy for Android device");
    });

    test("rejects converted iOS hierarchy with screenScale", () => {
      const viewHierarchy: ViewHierarchyResult = {
        hierarchy: {
          node: {
            $: { class: "UIWindow", bounds: { left: 0, top: 0, right: 390, bottom: 844 } },
            node: [{ $: { class: "UIView", text: "Hello" } }],
          },
        },
        screenScale: 3.0,
        screenWidth: 390,
        screenHeight: 844,
        packageName: "com.example.chatapp",
      };

      const result = validator.validate("android", viewHierarchy);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("iOS hierarchy for Android device");
    });

    test("rejects raw iOS hierarchy via elementType field", () => {
      const viewHierarchy = {
        hierarchy: {
          elementType: "application",
          bundleId: "com.example.app",
        },
        screenScale: 2.0,
      } as unknown as ViewHierarchyResult;

      const result = validator.validate("android", viewHierarchy);
      expect(result.valid).toBe(false);
    });

    test("rejects raw iOS hierarchy via bundleId without node", () => {
      const viewHierarchy = {
        hierarchy: {
          bundleId: "com.example.app",
        },
        screenScale: 2.0,
      } as unknown as ViewHierarchyResult;

      const result = validator.validate("android", viewHierarchy);
      expect(result.valid).toBe(false);
    });
  });

  describe("iOS device", () => {
    test("accepts converted iOS hierarchy with screenScale", () => {
      const viewHierarchy: ViewHierarchyResult = {
        hierarchy: {
          node: {
            $: { class: "UIWindow", bounds: { left: 0, top: 0, right: 390, bottom: 844 } },
            node: [
              {
                $: { class: "UIView", text: "Messages", clickable: "true" },
                node: [{ $: { class: "UILabel", text: "Hello world" } }],
              },
            ],
          },
        },
        screenScale: 3.0,
        screenWidth: 390,
        screenHeight: 844,
        packageName: "com.example.chatapp",
      };

      expect(validator.validate("ios", viewHierarchy)).toEqual({ valid: true });
    });

    test("accepts raw iOS hierarchy (XCUIElementTypeApplication)", () => {
      const viewHierarchy = {
        hierarchy: {
          type: "XCUIElementTypeApplication",
          bundleId: "com.example.app",
          bounds: { left: 0, top: 0, right: 390, bottom: 844 },
        },
        screenScale: 3.0,
      } as unknown as ViewHierarchyResult;

      expect(validator.validate("ios", viewHierarchy)).toEqual({ valid: true });
    });

    test("rejects Android hierarchy with android.* class and density", () => {
      const viewHierarchy: ViewHierarchyResult = {
        hierarchy: {
          node: {
            $: {
              class: "android.widget.FrameLayout",
              bounds: { left: 0, top: 0, right: 1080, bottom: 1920 },
            },
          },
        },
        density: 440,
        sdkInt: 34,
        foregroundActivity: "com.example.app/.MainActivity",
      };

      const result = validator.validate("ios", viewHierarchy);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Android hierarchy for iOS device");
    });

    test("rejects hierarchy with sdkInt (Android-only)", () => {
      const viewHierarchy: ViewHierarchyResult = {
        hierarchy: {
          node: {
            $: {
              class: "android.view.View",
              bounds: { left: 0, top: 0, right: 1080, bottom: 2400 },
            },
          },
        },
        sdkInt: 33,
      };

      const result = validator.validate("ios", viewHierarchy);
      expect(result.valid).toBe(false);
    });

    test("rejects hierarchy with foregroundActivity (Android-only)", () => {
      const viewHierarchy: ViewHierarchyResult = {
        hierarchy: {
          node: {
            $: { class: "android.widget.LinearLayout" },
          },
        },
        foregroundActivity: "com.example/.Main",
      };

      const result = validator.validate("ios", viewHierarchy);
      expect(result.valid).toBe(false);
    });
  });

  describe("ambiguous cases", () => {
    test("accepts hierarchy with no platform-specific signals for Android", () => {
      const viewHierarchy: ViewHierarchyResult = {
        hierarchy: { node: { $: { class: "View", text: "Hello" } } },
      };

      expect(validator.validate("android", viewHierarchy)).toEqual({ valid: true });
    });

    test("accepts hierarchy with no platform-specific signals for iOS", () => {
      const viewHierarchy: ViewHierarchyResult = {
        hierarchy: { node: { $: { class: "View", text: "Hello" } } },
      };

      expect(validator.validate("ios", viewHierarchy)).toEqual({ valid: true });
    });

    test("accepts error-only hierarchy for either platform", () => {
      const viewHierarchy: ViewHierarchyResult = {
        hierarchy: { error: "Failed to retrieve view hierarchy" },
      };

      expect(validator.validate("android", viewHierarchy)).toEqual({ valid: true });
      expect(validator.validate("ios", viewHierarchy)).toEqual({ valid: true });
    });

    test("accepts a hierarchy carrying BOTH platforms' signals for either platform", () => {
      // The mismatch guard only fires on a hierarchy that is purely the OTHER
      // platform (`ios && !android`). A hierarchy carrying both an iOS signal
      // (screenScale) and an Android signal (density + android.* class) is
      // ambiguous, so it is accepted for both platforms rather than rejected
      // (issue #4172 item 11). This pins that bypass so any future tightening of
      // the guard is a deliberate, visible change.
      const both = {
        hierarchy: {
          node: { $: { class: "android.widget.FrameLayout" } },
        },
        screenScale: 3.0,
        density: 440,
        sdkInt: 34,
      } as unknown as ViewHierarchyResult;

      expect(validator.validate("android", both)).toEqual({ valid: true });
      expect(validator.validate("ios", both)).toEqual({ valid: true });
    });
  });
});

describe("discardHierarchyDerivedData", () => {
  // Build a result populated with every hierarchy-derived field.
  const contaminatedResult = (): ObserveResult =>
    ({
      updatedAt: 0,
      screenSize: { width: 390, height: 844 },
      systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
      viewHierarchy: {
        hierarchy: { node: { $: { class: "UIWindow" } } },
        screenScale: 3.0,
      } as unknown as ViewHierarchyResult,
      elements: {
        clickable: [{ "resource-id": "id/x", text: "Stale" } as unknown as Element],
        scrollable: [],
        text: [{ text: "Stale" } as unknown as Element],
        media: [],
      },
      selectedElements: [{} as never],
      focusedElement: { text: "Stale" } as unknown as Element,
      accessibilityFocusedElement: { text: "Stale" } as unknown as Element,
      intentChooserDetected: true,
      notificationPermissionDetected: true,
      activeWindow: { appId: "com.other.platform", activityName: "", layoutSeqSum: 0 },
      screenIdentity: {
        platform: "ios",
        source: "heuristic",
        confidence: "medium",
        key: JSON.stringify([
          ["bundle", "com.other.platform"],
          ["focus", "stale-id"],
        ]),
        components: { bundleId: "com.other.platform", focusedElementId: "stale-id" },
      },
      predictions: {} as never,
    }) as unknown as ObserveResult;

  test("clears every hierarchy-derived field", () => {
    const result = contaminatedResult();

    discardHierarchyDerivedData(result);

    expect(result.viewHierarchy).toBeUndefined();
    expect(result.elements).toBeUndefined();
    expect(result.selectedElements).toBeUndefined();
    expect(result.focusedElement).toBeUndefined();
    expect(result.accessibilityFocusedElement).toBeUndefined();
    expect(result.intentChooserDetected).toBeUndefined();
    expect(result.notificationPermissionDetected).toBeUndefined();
    expect(result.predictions).toBeUndefined();
    expect(result.activeWindow).toBeUndefined();
    expect(result.screenIdentity).toBeUndefined();
  });

  test("resets hierarchy-derived screen metrics to base defaults", () => {
    const result = contaminatedResult();
    result.rotation = 1;
    result.wakefulness = "Awake";

    discardHierarchyDerivedData(result);

    // collectAllData copies these from the (now-rejected) hierarchy, so a stale
    // iOS screen size must not survive to mislead tap-coordinate scaling.
    expect(result.screenSize).toEqual({ width: 0, height: 0 });
    expect(result.systemInsets).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
    expect(result.rotation).toBeUndefined();
    expect(result.wakefulness).toBeUndefined();
  });

  test("leaves genuinely device-derived fields untouched", () => {
    const result = contaminatedResult();
    result.backStack = {} as never;

    discardHierarchyDerivedData(result);

    // backStack comes from a direct device query, not the rejected hierarchy.
    expect(result.backStack).toBeDefined();
  });
});

describe("enforceHierarchyPlatform", () => {
  const validator = new RealHierarchyPlatformValidator();

  const baseResult = (viewHierarchy?: ViewHierarchyResult): ObserveResult =>
    ({
      updatedAt: 0,
      screenSize: { width: 1080, height: 1920 },
      systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
      viewHierarchy,
      focusedElement: { text: "Stale" } as unknown as Element,
      intentChooserDetected: true,
      elements: { clickable: [], scrollable: [], text: [], media: [] },
      screenIdentity: {
        platform: "ios",
        source: "heuristic",
        confidence: "medium",
        key: JSON.stringify([
          ["bundle", "com.other.platform"],
          ["focus", "stale-id"],
        ]),
        components: { bundleId: "com.other.platform", focusedElementId: "stale-id" },
      },
    }) as unknown as ObserveResult;

  test("rejects an opposite-platform hierarchy and scrubs all derived fields", () => {
    const result = baseResult({
      hierarchy: {
        type: "XCUIElementTypeApplication",
        bundleId: "com.example.app",
        bounds: { left: 0, top: 0, right: 390, bottom: 844 },
      },
      screenScale: 3.0,
    } as unknown as ViewHierarchyResult);

    const valid = enforceHierarchyPlatform(result, "android", "device-1", validator);

    expect(valid).toBe(false);
    expect(result.viewHierarchy).toBeUndefined();
    expect(result.elements).toBeUndefined();
    expect(result.focusedElement).toBeUndefined();
    expect(result.intentChooserDetected).toBeUndefined();
    expect(result.screenIdentity).toBeUndefined();
    expect(result.error).toContain("iOS hierarchy for Android device");
  });

  test("preserves a matching hierarchy and its derived fields", () => {
    const result = baseResult({
      hierarchy: {
        node: {
          $: {
            class: "android.widget.FrameLayout",
            bounds: { left: 0, top: 0, right: 1080, bottom: 1920 },
          },
        },
      },
      density: 440,
      sdkInt: 34,
    });

    const valid = enforceHierarchyPlatform(result, "android", "device-1", validator);

    expect(valid).toBe(true);
    expect(result.viewHierarchy).toBeDefined();
    expect(result.elements).toBeDefined();
    expect(result.focusedElement).toBeDefined();
    expect(result.screenIdentity).toBeDefined();
    expect(result.error).toBeUndefined();
  });

  test("leaves a result without a hierarchy untouched", () => {
    const result = baseResult(undefined);

    const valid = enforceHierarchyPlatform(result, "android", "device-1", validator);

    expect(valid).toBe(true);
    expect(result.elements).toBeDefined();
    expect(result.error).toBeUndefined();
  });
});
