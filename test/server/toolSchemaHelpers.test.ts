import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { addDeviceTargetingToSchema, platformSchema } from "../../src/server/toolSchemaHelpers";
import { accessibilitySchema } from "../../src/server/accessibilityTools";
import { packageNameSchema, launchAppSchema, installAppSchema, uninstallAppSchema, getAppPermissionsSchema } from "../../src/server/appTools";
import { biometricAuthSchema } from "../../src/server/biometricTools";
import { bugReportSchema, debugSearchSchema } from "../../src/server/debugTools";
import { getDeepLinksSchema } from "../../src/server/deepLinkTools";
import { highlightSchema } from "../../src/server/highlightTools";
import {
  shakeSchema, keyboardSchema, dragAndDropSchema, swipeOnSchema, pinchOnSchema,
  clearTextSchema, selectAllTextSchema, pressButtonSchema, inputTextSchema,
  openLinkSchema, imeActionSchema, recentAppsSchema, homeScreenSchema,
  rotateSchema, clipboardSchema, stopAppSchema, clearStateSchema, systemTraySchema,
} from "../../src/server/interactionTools";
import { navigateToSchema, getNavigationGraphSchema, exploreSchema } from "../../src/server/navigationTools";
import { postNotificationSchema, getNotificationPolicySchema, setNotificationPolicySchema } from "../../src/server/notificationTools";
import { observeSchema, identifyInteractionsSchema } from "../../src/server/observeTools";
import { deviceSnapshotSchema } from "../../src/server/snapshotTools";
import { changeLocalizationSchema, getDeviceStateSchema, setDeviceStateSchema } from "../../src/server/utilityTools";

describe("addDeviceTargetingToSchema", () => {
  const baseSchema = z.object({
    bundleId: z.string(),
  }).strict();

  const extended = addDeviceTargetingToSchema(baseSchema);

  test("accepts base fields without device targeting", () => {
    const result = extended.safeParse({ bundleId: "com.example.app" });
    expect(result.success).toBe(true);
  });

  test("accepts deviceId injected by plan executor", () => {
    const result = extended.safeParse({
      bundleId: "com.example.app",
      deviceId: "emulator-5554",
    });
    expect(result.success).toBe(true);
  });

  test("accepts device label for multi-device plans", () => {
    const result = extended.safeParse({
      bundleId: "com.example.app",
      device: "A",
    });
    expect(result.success).toBe(true);
  });

  test("accepts sessionUuid for session-based targeting", () => {
    const result = extended.safeParse({
      bundleId: "com.example.app",
      sessionUuid: "abc-123",
    });
    expect(result.success).toBe(true);
  });

  test("accepts platform for device-aware targeting", () => {
    const result = extended.safeParse({
      bundleId: "com.example.app",
      platform: "ios",
    });
    expect(result.success).toBe(true);
  });

  test("rejects invalid platform value", () => {
    const result = extended.safeParse({
      bundleId: "com.example.app",
      platform: "windows",
    });
    expect(result.success).toBe(false);
  });

  test("accepts all device targeting fields together", () => {
    const result = extended.safeParse({
      bundleId: "com.example.app",
      deviceId: "emulator-5554",
      device: "A",
      sessionUuid: "abc-123",
      keepScreenAwake: true,
      platform: "android",
    });
    expect(result.success).toBe(true);
  });

  test("rejects unknown fields not in base or device targeting", () => {
    const result = extended.safeParse({
      bundleId: "com.example.app",
      unknownField: "surprise",
    });
    expect(result.success).toBe(false);
  });

  test("preserves existing platform definition instead of overwriting", () => {
    const schemaWithRequiredPlatform = z.object({
      bundleId: z.string(),
      platform: platformSchema.default("android"),
    }).strict();

    const extendedWithPlatform = addDeviceTargetingToSchema(schemaWithRequiredPlatform);

    const withDefault = extendedWithPlatform.safeParse({ bundleId: "com.example.app" });
    expect(withDefault.success).toBe(true);
    if (withDefault.success) {
      expect(withDefault.data.platform).toBe("android");
    }

    const withExplicit = extendedWithPlatform.safeParse({ bundleId: "com.example.app", platform: "ios" });
    expect(withExplicit.success).toBe(true);
    if (withExplicit.success) {
      expect(withExplicit.data.platform).toBe("ios");
    }
  });
});

describe("platform field accepted by all device-targeting tool schemas", () => {
  const toolSchemas: [string, z.ZodType<any>, Record<string, unknown>][] = [
    ["accessibilitySchema", accessibilitySchema, {}],
    ["packageNameSchema", packageNameSchema, { appId: "com.example" }],
    ["launchAppSchema", launchAppSchema, { appId: "com.example" }],
    ["installAppSchema", installAppSchema, { artifactPath: "/tmp/app.apk" }],
    ["uninstallAppSchema", uninstallAppSchema, { appId: "com.example" }],
    ["getAppPermissionsSchema", getAppPermissionsSchema, { appId: "com.example" }],
    ["biometricAuthSchema", biometricAuthSchema, { action: "match" }],
    ["bugReportSchema", bugReportSchema, { platform: "ios" }],
    ["debugSearchSchema", debugSearchSchema, { platform: "ios", text: "hello" }],
    ["getDeepLinksSchema", getDeepLinksSchema, { appId: "com.example" }],
    ["highlightSchema", highlightSchema, { platform: "ios", elementId: "btn1" }],
    ["navigateToSchema", navigateToSchema, { targetScreen: "Home" }],
    ["getNavigationGraphSchema", getNavigationGraphSchema, {}],
    ["exploreSchema", exploreSchema, {}],
    ["postNotificationSchema", postNotificationSchema, { title: "Hi", body: "Test", appId: "com.example", platform: "ios" }],
    ["getNotificationPolicySchema", getNotificationPolicySchema, { appId: "com.example" }],
    ["setNotificationPolicySchema", setNotificationPolicySchema, { appId: "com.example", policyAccess: true }],
    ["observeSchema", observeSchema, { platform: "ios" }],
    ["identifyInteractionsSchema", identifyInteractionsSchema, { platform: "ios" }],
    ["deviceSnapshotSchema", deviceSnapshotSchema, { action: "capture" }],
    ["changeLocalizationSchema", changeLocalizationSchema, { platform: "ios", locale: "en_US" }],
    ["getDeviceStateSchema", getDeviceStateSchema, {}],
    ["setDeviceStateSchema", setDeviceStateSchema, { doNotDisturb: { enabled: true } }],
    ["shakeSchema", shakeSchema, { platform: "ios" }],
    ["keyboardSchema", keyboardSchema, { action: "detect", platform: "ios" }],
    ["dragAndDropSchema", dragAndDropSchema, { source: { elementId: "a" }, target: { elementId: "b" }, platform: "ios" }],
    ["swipeOnSchema", swipeOnSchema, { direction: "up", platform: "ios" }],
    ["pinchOnSchema", pinchOnSchema, { direction: "in", platform: "ios" }],
    ["clearTextSchema", clearTextSchema, { platform: "ios" }],
    ["selectAllTextSchema", selectAllTextSchema, { platform: "ios" }],
    ["pressButtonSchema", pressButtonSchema, { button: "home", platform: "ios" }],
    ["inputTextSchema", inputTextSchema, { text: "hello", platform: "ios" }],
    ["openLinkSchema", openLinkSchema, { url: "https://example.com", platform: "ios" }],
    ["imeActionSchema", imeActionSchema, { action: "done", platform: "ios" }],
    ["recentAppsSchema", recentAppsSchema, { platform: "ios" }],
    ["homeScreenSchema", homeScreenSchema, { platform: "ios" }],
    ["rotateSchema", rotateSchema, { orientation: "portrait", platform: "ios" }],
    ["clipboardSchema", clipboardSchema, { action: "get", platform: "ios" }],
    ["stopAppSchema", stopAppSchema, { appId: "com.example", platform: "ios" }],
    ["clearStateSchema", clearStateSchema, { appId: "com.example", platform: "ios" }],
    ["systemTraySchema", systemTraySchema, { action: "open", platform: "ios" }],
  ];

  for (const [name, schema, baseInput] of toolSchemas) {
    test(`${name} accepts platform: "ios"`, () => {
      const input = { ...baseInput, platform: "ios" };
      const result = schema.safeParse(input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.platform).toBe("ios");
      }
    });

    test(`${name} accepts platform: "android"`, () => {
      const input = { ...baseInput, platform: "android" };
      const result = schema.safeParse(input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.platform).toBe("android");
      }
    });

    test(`${name} rejects invalid platform`, () => {
      const input = { ...baseInput, platform: "windows" };
      const result = schema.safeParse(input);
      expect(result.success).toBe(false);
    });
  }
});

describe("inputTextSchema", () => {
  test("accepts supported Android input modes", () => {
    for (const mode of ["a11y", "eventLast", "eventAll"]) {
      const result = inputTextSchema.safeParse({ text: "hello", mode, platform: "android" });
      expect(result.success).toBe(true);
    }
  });

  test("accepts input modes for iOS callers so runtime can ignore them", () => {
    for (const mode of ["a11y", "eventLast", "eventAll"]) {
      const result = inputTextSchema.safeParse({ text: "hello", mode, platform: "ios" });
      expect(result.success).toBe(true);
    }
  });

  test("rejects unsupported input modes", () => {
    const result = inputTextSchema.safeParse({ text: "hello", mode: "realKeyEvents", platform: "android" });
    expect(result.success).toBe(false);
  });
});
