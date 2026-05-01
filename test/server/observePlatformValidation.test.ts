import { describe, expect, test } from "bun:test";
import { BootedDevice, ObserveResult } from "../../src/models";

/**
 * Platform validation logic extracted for direct testing.
 * This mirrors the validation in observeTools.ts observeHandler to verify
 * cross-platform hierarchy detection works correctly.
 */
function validateHierarchyPlatform(
  device: BootedDevice,
  result: ObserveResult
): { valid: boolean; error?: string } {
  if (!result.viewHierarchy?.hierarchy) {
    return { valid: true };
  }

  const hierarchy = result.viewHierarchy.hierarchy;
  const isIosHierarchy = hierarchy.type === "XCUIElementTypeApplication"
    || hierarchy.elementType === "application"
    || (typeof hierarchy.bundleId === "string" && !hierarchy.node);
  const isAndroidHierarchy = hierarchy.node !== undefined
    || (hierarchy.$ && hierarchy.$.class);

  if (device.platform === "android" && isIosHierarchy && !isAndroidHierarchy) {
    return {
      valid: false,
      error: "Platform mismatch detected: received iOS hierarchy for Android device.",
    };
  }

  if (device.platform === "ios" && isAndroidHierarchy && !isIosHierarchy) {
    return {
      valid: false,
      error: "Platform mismatch detected: received Android hierarchy for iOS device.",
    };
  }

  return { valid: true };
}

describe("observe platform validation", () => {
  const androidDevice: BootedDevice = {
    name: "emulator-5554",
    deviceId: "emulator-5554",
    platform: "android",
  };

  const iosDevice: BootedDevice = {
    name: "iPhone 15",
    deviceId: "ios-sim-1",
    platform: "ios",
  };

  test("accepts Android hierarchy for Android device", () => {
    const result: ObserveResult = {
      updatedAt: Date.now(),
      screenSize: { width: 1080, height: 1920 },
      systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
      viewHierarchy: {
        hierarchy: {
          node: {
            $: { class: "android.widget.FrameLayout", bounds: "[0,0][1080,1920]" },
          },
        },
      } as any,
    };

    const validation = validateHierarchyPlatform(androidDevice, result);
    expect(validation.valid).toBe(true);
  });

  test("rejects iOS hierarchy for Android device", () => {
    const result: ObserveResult = {
      updatedAt: Date.now(),
      screenSize: { width: 390, height: 844 },
      systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
      viewHierarchy: {
        hierarchy: {
          type: "XCUIElementTypeApplication",
          bundleId: "com.example.app",
          bounds: { left: 0, top: 0, right: 390, bottom: 844 },
        },
      } as any,
    };

    const validation = validateHierarchyPlatform(androidDevice, result);
    expect(validation.valid).toBe(false);
    expect(validation.error).toContain("iOS hierarchy for Android device");
  });

  test("accepts iOS hierarchy for iOS device", () => {
    const result: ObserveResult = {
      updatedAt: Date.now(),
      screenSize: { width: 390, height: 844 },
      systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
      viewHierarchy: {
        hierarchy: {
          type: "XCUIElementTypeApplication",
          bundleId: "com.example.app",
          bounds: { left: 0, top: 0, right: 390, bottom: 844 },
        },
      } as any,
    };

    const validation = validateHierarchyPlatform(iosDevice, result);
    expect(validation.valid).toBe(true);
  });

  test("rejects Android hierarchy for iOS device", () => {
    const result: ObserveResult = {
      updatedAt: Date.now(),
      screenSize: { width: 1080, height: 1920 },
      systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
      viewHierarchy: {
        hierarchy: {
          node: {
            $: { class: "android.widget.FrameLayout", bounds: "[0,0][1080,1920]" },
          },
        },
      } as any,
    };

    const validation = validateHierarchyPlatform(iosDevice, result);
    expect(validation.valid).toBe(false);
    expect(validation.error).toContain("Android hierarchy for iOS device");
  });

  test("detects iOS hierarchy via elementType field", () => {
    const result: ObserveResult = {
      updatedAt: Date.now(),
      screenSize: { width: 390, height: 844 },
      systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
      viewHierarchy: {
        hierarchy: {
          elementType: "application",
          bundleId: "com.example.app",
        },
      } as any,
    };

    const validation = validateHierarchyPlatform(androidDevice, result);
    expect(validation.valid).toBe(false);
  });

  test("detects iOS hierarchy via bundleId without node field", () => {
    const result: ObserveResult = {
      updatedAt: Date.now(),
      screenSize: { width: 390, height: 844 },
      systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
      viewHierarchy: {
        hierarchy: {
          bundleId: "com.example.app",
          children: [],
        },
      } as any,
    };

    const validation = validateHierarchyPlatform(androidDevice, result);
    expect(validation.valid).toBe(false);
  });

  test("accepts when no viewHierarchy is present", () => {
    const result: ObserveResult = {
      updatedAt: Date.now(),
      screenSize: { width: 0, height: 0 },
      systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
    };

    const validation = validateHierarchyPlatform(androidDevice, result);
    expect(validation.valid).toBe(true);
  });

  test("accepts when hierarchy has error object", () => {
    const result: ObserveResult = {
      updatedAt: Date.now(),
      screenSize: { width: 0, height: 0 },
      systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
      viewHierarchy: {
        hierarchy: {
          error: "Failed to retrieve view hierarchy",
        },
      } as any,
    };

    // Error hierarchies don't have platform-specific markers, so they should pass
    const validation = validateHierarchyPlatform(androidDevice, result);
    expect(validation.valid).toBe(true);
  });
});
