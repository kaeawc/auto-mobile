import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { z } from "zod/v4";
import {
  addDeviceTargetingToSchema,
  appIdFieldAliases,
  platformSchema,
  withFieldAliases,
} from "../../src/server/toolSchemaHelpers";
import { accessibilitySchema } from "../../src/server/accessibilityTools";
import {
  packageNameSchema,
  launchAppSchema,
  installAppSchema,
  uninstallAppSchema,
  getAppPermissionsSchema,
} from "../../src/server/appTools";
import { biometricAuthSchema } from "../../src/server/biometricTools";
import { bugReportSchema, debugSearchSchema } from "../../src/server/debugTools";
import { getDeepLinksSchema } from "../../src/server/deepLinkTools";
import { highlightSchema } from "../../src/server/highlightTools";
import {
  shakeSchema,
  keyboardSchema,
  dragAndDropSchema,
  swipeOnSchema,
  pinchOnSchema,
  clearTextSchema,
  selectAllTextSchema,
  pressButtonSchema,
  inputTextSchema,
  openLinkSchema,
  imeActionSchema,
  recentAppsSchema,
  homeScreenSchema,
  rotateSchema,
  clipboardSchema,
  stopAppSchema,
  clearStateSchema,
  systemTraySchema,
} from "../../src/server/interactionTools";
import {
  navigateToSchema,
  getNavigationGraphSchema,
  exploreSchema,
} from "../../src/server/navigationTools";
import {
  postNotificationSchema,
  getNotificationPolicySchema,
  setNotificationPolicySchema,
} from "../../src/server/notificationTools";
import { observeSchema, identifyInteractionsSchema } from "../../src/server/observeTools";
import { deviceSnapshotSchema } from "../../src/server/snapshotTools";
import {
  changeLocalizationSchema,
  getDeviceStateSchema,
  setDeviceStateSchema,
} from "../../src/server/utilityTools";

describe("addDeviceTargetingToSchema", () => {
  const baseSchema = z
    .object({
      bundleId: z.string(),
    })
    .strict();

  const extended = addDeviceTargetingToSchema(baseSchema);

  // P1 (issue #4181, rank 11): the 8 accept/reject siblings collapsed into a
  // table keyed on the expected outcome, PLUS degenerate boundary rows
  // (platform "" / null, device wrong-type, keepScreenAwake wrong-type, bare
  // base) that did not exist before. `bundleId` is always supplied; each row
  // adds the field(s) under test.
  test.each([
    ["bare base (no targeting)", {}, true],
    ["deviceId injected by plan executor", { deviceId: "emulator-5554" }, true],
    ["device label for multi-device plans", { device: "A" }, true],
    ["sessionUuid for session targeting", { sessionUuid: "abc-123" }, true],
    ["platform ios", { platform: "ios" }, true],
    ["platform android", { platform: "android" }, true],
    ["keepScreenAwake boolean", { keepScreenAwake: true }, true],
    [
      "all targeting fields together",
      {
        deviceId: "emulator-5554",
        device: "A",
        sessionUuid: "abc-123",
        keepScreenAwake: true,
        platform: "android",
      },
      true,
    ],
    ["invalid platform value", { platform: "windows" }, false],
    ["empty-string platform (degenerate)", { platform: "" }, false],
    ["null platform (degenerate)", { platform: null }, false],
    ["numeric device label (degenerate)", { device: 7 }, false],
    ["non-boolean keepScreenAwake (degenerate)", { keepScreenAwake: "yes" }, false],
    ["unknown field not in base or targeting", { unknownField: "surprise" }, false],
  ] as const)("%s -> success=%s", (_label, extension, shouldSucceed) => {
    const result = extended.safeParse({ bundleId: "com.example.app", ...extension });
    expect(result.success).toBe(shouldSucceed);
  });

  test("preserves existing platform definition instead of overwriting", () => {
    const schemaWithRequiredPlatform = z
      .object({
        bundleId: z.string(),
        platform: platformSchema.default("android"),
      })
      .strict();

    const extendedWithPlatform = addDeviceTargetingToSchema(schemaWithRequiredPlatform);

    const withDefault = extendedWithPlatform.safeParse({ bundleId: "com.example.app" });
    expect(withDefault.success).toBe(true);
    if (withDefault.success) {
      expect(withDefault.data.platform).toBe("android");
    }

    const withExplicit = extendedWithPlatform.safeParse({
      bundleId: "com.example.app",
      platform: "ios",
    });
    expect(withExplicit.success).toBe(true);
    if (withExplicit.success) {
      expect(withExplicit.data.platform).toBe("ios");
    }
  });
});

describe("withFieldAliases", () => {
  const schema = withFieldAliases(
    z
      .object({
        appId: z.string(),
        nested: z
          .object({
            appId: z.string().optional(),
          })
          .optional(),
      })
      .strict(),
    {
      appId: appIdFieldAliases,
    },
  );

  test("maps common app identifier aliases to appId", () => {
    for (const alias of appIdFieldAliases) {
      const result = schema.safeParse({ [alias]: "com.example.app" });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.appId).toBe("com.example.app");
        expect(alias in result.data).toBe(false);
      }
    }
  });

  test("preserves appId when an alias is also present", () => {
    const result = schema.safeParse({
      appId: "com.example.primary",
      packageId: "com.example.alias",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.appId).toBe("com.example.primary");
      expect("packageId" in result.data).toBe(false);
    }
  });

  test("normalizes nested objects with appId aliases", () => {
    const result = schema.safeParse({
      appId: "com.example.outer",
      nested: {
        bundleId: "com.example.inner",
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.nested?.appId).toBe("com.example.inner");
    }
  });

  test("does not recurse into non-plain objects", () => {
    const date = new Date("2026-01-01T00:00:00.000Z");
    const dateSchema = withFieldAliases(
      z.object({
        appId: z.string(),
        value: z.instanceof(Date),
      }),
      {
        appId: appIdFieldAliases,
      },
    );

    const result = dateSchema.safeParse({
      packageId: "com.example.app",
      value: date,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.value).toBe(date);
    }
  });
});

describe("appId aliases on tool schemas", () => {
  test("launchAppSchema accepts packageId as an appId alias", () => {
    const result = launchAppSchema.safeParse({
      packageId: "com.example.app",
      platform: "android",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.appId).toBe("com.example.app");
      expect("packageId" in result.data).toBe(false);
    }
  });

  test("launchAppSchema accepts natural app identifier aliases", () => {
    for (const alias of [
      "package",
      "packageName",
      "bundle",
      "bundleId",
      "application",
      "applicationId",
    ]) {
      const result = launchAppSchema.safeParse({
        [alias]: "com.example.app",
        platform: "ios",
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.appId).toBe("com.example.app");
      }
    }
  });

  test("postNotificationSchema accepts bundleId for the iOS appId field", () => {
    const result = postNotificationSchema.safeParse({
      platform: "ios",
      title: "Hello",
      body: "World",
      bundleId: "com.example.app",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.appId).toBe("com.example.app");
    }
  });

  test("systemTraySchema accepts appId aliases in notification criteria", () => {
    const result = systemTraySchema.safeParse({
      platform: "android",
      action: "clearAll",
      notification: {
        packageName: "com.example.app",
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.notification?.appId).toBe("com.example.app");
      expect("packageName" in (result.data.notification ?? {})).toBe(false);
    }
  });

  test("changeLocalizationSchema accepts appId aliases for Android app-scoped locale changes", () => {
    const result = changeLocalizationSchema.safeParse({
      platform: "android",
      packageName: "com.example.app",
      locale: "fr-FR",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.appId).toBe("com.example.app");
      expect("packageName" in result.data).toBe(false);
    }
  });

  test("changeLocalizationSchema rejects appId for iOS locale changes", () => {
    const result = changeLocalizationSchema.safeParse({
      platform: "ios",
      bundleId: "com.example.app",
      locale: "fr-FR",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((issue) =>
          issue.message.includes("appId is only supported for Android"),
        ),
      ).toBe(true);
    }
  });

  test("changeLocalizationSchema rejects appId when locale is omitted", () => {
    const result = changeLocalizationSchema.safeParse({
      platform: "android",
      appId: "com.example.app",
      timeZone: "Europe/Paris",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((issue) =>
          issue.message.includes("appId only applies when locale is provided"),
        ),
      ).toBe(true);
    }
  });

  test("changeLocalizationSchema requires appId for Android locale changes", () => {
    const result = changeLocalizationSchema.safeParse({
      platform: "android",
      locale: "fr-FR",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((issue) =>
          issue.message.includes("appId is required for Android locale changes"),
        ),
      ).toBe(true);
    }
  });
});

describe("generated tool definitions", () => {
  test("changeLocalization generated schema conditionally requires appId for Android locale changes", () => {
    const schemas = JSON.parse(readFileSync("schemas/tool-definitions.json", "utf8")) as Array<{
      name: string;
      inputSchema?: {
        properties?: Record<string, unknown>;
        if?: unknown;
        then?: unknown;
        required?: string[];
      };
    }>;
    const changeLocalization = schemas.find((schema) => schema.name === "changeLocalization");

    expect(changeLocalization?.inputSchema?.properties?.appId).toBeDefined();
    expect(changeLocalization?.inputSchema?.if).toEqual({
      properties: {
        platform: { const: "android" },
      },
      required: ["platform", "locale"],
    });
    expect(changeLocalization?.inputSchema?.then).toEqual({
      required: ["appId"],
    });
    expect(changeLocalization?.inputSchema?.required).toEqual(["platform"]);
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
    [
      "postNotificationSchema",
      postNotificationSchema,
      { title: "Hi", body: "Test", appId: "com.example", platform: "ios" },
    ],
    ["getNotificationPolicySchema", getNotificationPolicySchema, { appId: "com.example" }],
    [
      "setNotificationPolicySchema",
      setNotificationPolicySchema,
      { appId: "com.example", policyAccess: true },
    ],
    ["observeSchema", observeSchema, { platform: "ios" }],
    ["identifyInteractionsSchema", identifyInteractionsSchema, { platform: "ios" }],
    ["deviceSnapshotSchema", deviceSnapshotSchema, { action: "capture" }],
    [
      "changeLocalizationSchema",
      changeLocalizationSchema,
      { platform: "ios", timeZone: "Europe/Paris" },
    ],
    ["getDeviceStateSchema", getDeviceStateSchema, {}],
    ["setDeviceStateSchema", setDeviceStateSchema, { doNotDisturb: { enabled: true } }],
    ["shakeSchema", shakeSchema, { platform: "ios" }],
    ["keyboardSchema", keyboardSchema, { action: "detect", platform: "ios" }],
    [
      "dragAndDropSchema",
      dragAndDropSchema,
      { source: { elementId: "a" }, target: { elementId: "b" }, platform: "ios" },
    ],
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

  // P2 (issue #4181, rank 12): the hand-rolled 42x3 for-loop emitting three
  // tests per schema collapsed into a single test.each over the same matrix.
  test.each(toolSchemas)("%s accepts platform ios", (_name, schema, baseInput) => {
    const result = schema.safeParse({ ...baseInput, platform: "ios" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.platform).toBe("ios");
    }
  });

  test.each(toolSchemas)("%s accepts platform android", (_name, schema, baseInput) => {
    const result = schema.safeParse({ ...baseInput, platform: "android" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.platform).toBe("android");
    }
  });

  test.each(toolSchemas)("%s rejects invalid platform", (_name, schema, baseInput) => {
    const result = schema.safeParse({ ...baseInput, platform: "windows" });
    expect(result.success).toBe(false);
  });
});

describe("inputTextSchema", () => {
  test("accepts supported Android input modes", () => {
    for (const mode of ["a11y", "eventLast", "eventAll", "eventOnly"]) {
      const result = inputTextSchema.safeParse({ text: "hello", mode, platform: "android" });
      expect(result.success).toBe(true);
    }
  });

  test("accepts input modes for iOS callers so runtime can ignore them", () => {
    for (const mode of ["a11y", "eventLast", "eventAll", "eventOnly"]) {
      const result = inputTextSchema.safeParse({ text: "hello", mode, platform: "ios" });
      expect(result.success).toBe(true);
    }
  });

  test("rejects unsupported input modes", () => {
    const result = inputTextSchema.safeParse({
      text: "hello",
      mode: "realKeyEvents",
      platform: "android",
    });
    expect(result.success).toBe(false);
  });
});
