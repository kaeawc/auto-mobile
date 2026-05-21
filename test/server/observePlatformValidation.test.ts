import { describe, expect, test } from "bun:test";
import type { ViewHierarchyResult } from "../../src/models";
import { RealHierarchyPlatformValidator } from "../../src/server/hierarchyPlatformValidator";

describe("RealHierarchyPlatformValidator", () => {
  const validator = new RealHierarchyPlatformValidator();

  describe("Android device", () => {
    test("accepts Android hierarchy with android.* class prefix", () => {
      const viewHierarchy: ViewHierarchyResult = {
        hierarchy: {
          node: {
            $: { class: "android.widget.FrameLayout", bounds: "[0,0][1080,1920]" },
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
            $: { class: "UIWindow", bounds: "[0,0][390,844]" },
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
            $: { class: "UIWindow", bounds: "[0,0][390,844]" },
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
            $: { class: "android.widget.FrameLayout", bounds: "[0,0][1080,1920]" },
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
            $: { class: "android.view.View", bounds: "[0,0][1080,2400]" },
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
        hierarchy: {
          node: {
            $: { class: "View", text: "Hello" },
          },
        },
      };

      expect(validator.validate("android", viewHierarchy)).toEqual({ valid: true });
    });

    test("accepts hierarchy with no platform-specific signals for iOS", () => {
      const viewHierarchy: ViewHierarchyResult = {
        hierarchy: {
          node: {
            $: { class: "View", text: "Hello" },
          },
        },
      };

      expect(validator.validate("ios", viewHierarchy)).toEqual({ valid: true });
    });

    test("accepts error-only hierarchy for either platform", () => {
      const viewHierarchy: ViewHierarchyResult = {
        hierarchy: {
          error: "Failed to retrieve view hierarchy",
        },
      };

      expect(validator.validate("android", viewHierarchy)).toEqual({ valid: true });
      expect(validator.validate("ios", viewHierarchy)).toEqual({ valid: true });
    });
  });
});
