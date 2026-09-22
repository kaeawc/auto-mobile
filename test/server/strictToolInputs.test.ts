import { describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import { formatToolParamError } from "../../src/server/toolParamError";
import { phoneCallSchema, sendSmsSchema } from "../../src/server/telephonyTools";
import {
  biometricAuthSchema,
  getIosSimulatorCapabilitiesSchema,
} from "../../src/server/biometricTools";
import { accessibilityFocusSchema } from "../../src/server/accessibilityFocusTools";
import {
  exploreSchema,
  getNavigationGraphSchema,
  navigateToSchema,
} from "../../src/server/navigationTools";
import {
  dragAndDropSchema,
  pinchOnSchema,
  swipeOnSchema,
} from "../../src/server/interactionTools";
import {
  crashAppSchema,
  installAppSchema,
  listAppsSchema,
  packageNameSchema,
  terminateAppSchema,
  uninstallAppSchema,
} from "../../src/server/appTools";

/**
 * Issues #6712 and #6613: these tool input schemas advertised
 * `additionalProperties: false` in `tools/list` but were plain (non-strict)
 * `z.object`s at runtime, so Zod silently DELETED an undeclared caller argument
 * instead of rejecting it. The caller saw success while its argument was
 * ignored (`installApp{userId}` mis-targeting the Android user profile is the
 * concrete harm documented in #6613).
 *
 * `undeclaredProbe: 42` is the probe from #6712's reproduction.
 */
const UNDECLARED_PROBE = { undeclaredProbe: 42 } as const;

interface StrictCase {
  readonly name: string;
  readonly schema: z.ZodType<any>;
  readonly valid: Record<string, unknown>;
  /** Device targeting is injected by the executor into requiresDevice tools only. */
  readonly deviceTargeted?: boolean;
}

const strictCases: StrictCase[] = [
  // #6712: telephony
  { name: "phoneCall", schema: phoneCallSchema, valid: { action: "hold" } },
  {
    name: "sendSms",
    schema: sendSmsSchema,
    valid: { phoneNumber: "+15555550100", message: "hello" },
  },
  // #6712: biometrics (biometricAuth carries a `.refine()`;
  // getIosSimulatorCapabilities has no device-targeting wrapper)
  { name: "biometricAuth", schema: biometricAuthSchema, valid: { action: "match" } },
  {
    name: "getIosSimulatorCapabilities",
    schema: getIosSimulatorCapabilitiesSchema,
    valid: { deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-16", runtime: "iOS-18-0" },
    deviceTargeted: false,
  },
  // #6712: accessibility focus
  { name: "accessibilityFocus", schema: accessibilityFocusSchema, valid: { action: "set" } },
  // #6712: navigation
  { name: "navigateTo", schema: navigateToSchema, valid: { targetScreen: "Home" } },
  { name: "getNavigationGraph", schema: getNavigationGraphSchema, valid: {} },
  { name: "explore", schema: exploreSchema, valid: { maxInteractions: 5 } },
  // #6613: interaction tools (helper-wrapped, selector unions)
  { name: "swipeOn", schema: swipeOnSchema, valid: { direction: "up" } },
  {
    name: "dragAndDrop",
    schema: dragAndDropSchema,
    valid: { source: { elementId: "a" }, target: { elementId: "b" } },
  },
  { name: "pinchOn", schema: pinchOnSchema, valid: { direction: "in" } },
  // #6613: app tools (appId-alias preprocessed)
  { name: "packageNameSchema", schema: packageNameSchema, valid: { appId: "com.example.app" } },
  // The schema `listApps` actually registers. `appId` is NOT one of its
  // filters, so `listApps({ appId })` must fail loudly rather than return an
  // unfiltered listing.
  { name: "listApps", schema: listAppsSchema, valid: { type: "user" } },
  { name: "terminateApp", schema: terminateAppSchema, valid: { appId: "com.example.app" } },
  { name: "crashApp", schema: crashAppSchema, valid: { appId: "com.example.app" } },
  { name: "installApp", schema: installAppSchema, valid: { artifactPath: "/tmp/app.apk" } },
  { name: "uninstallApp", schema: uninstallAppSchema, valid: { appId: "com.example.app" } },
];

describe("issues #6712/#6613: object-shaped tool inputs reject undeclared arguments", () => {
  test("getIosSimulatorCapabilities accepts optional session targeting fields", () => {
    expect(
      getIosSimulatorCapabilitiesSchema.safeParse({
        deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-16",
        runtime: "iOS-18-0",
        sessionUuid: "11111111-2222-3333-4444-555555555555",
        keepScreenAwake: true,
      }).success,
    ).toBe(true);
  });

  for (const { name, schema, valid, deviceTargeted = true } of strictCases) {
    test(`${name} rejects an undeclared top-level argument`, () => {
      const result = schema.safeParse({ ...valid, ...UNDECLARED_PROBE });
      expect(result.success).toBe(false);
    });

    test(`${name} names the unrecognized key actionably`, () => {
      const raw = { ...valid, ...UNDECLARED_PROBE };
      const result = schema.safeParse(raw);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(formatToolParamError(name, result.error, raw)).toContain(
          'Unrecognized key: "undeclaredProbe"',
        );
      }
    });

    test(`${name} still parses its declared arguments`, () => {
      expect(schema.safeParse(valid).success).toBe(true);
    });

    test(`${name} still accepts injected device targeting`, () => {
      if (!deviceTargeted) {
        return;
      }
      // The executor injects these into requiresDevice tool calls after device
      // allocation; strict mode must not reject them.
      const result = schema.safeParse({
        ...valid,
        deviceId: "emulator-5554",
        sessionUuid: "11111111-2222-3333-4444-555555555555",
        device: "phone",
      });
      expect(result.success).toBe(true);
    });

    test(`${name} advertises additionalProperties:false consistently with runtime`, () => {
      const json = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as Record<
        string,
        unknown
      >;
      expect(json.additionalProperties).toBe(false);
    });
  }

  test("app-tool appId aliases still normalize under strict mode", () => {
    const parsed = terminateAppSchema.parse({ packageName: "com.example.app" });
    expect(parsed.appId).toBe("com.example.app");
  });

  test("listApps rejects an appId filter it does not support", () => {
    // `appId` is a documented alias elsewhere in appTools, but listApps filters
    // by `search`, not by app id. Before #6613 the key was silently stripped and
    // the caller got the whole unfiltered listing back.
    const result = listAppsSchema.safeParse({ type: "user", appId: "com.example.app" });
    expect(result.success).toBe(false);
  });

  test("listApps still parses every filter it does declare", () => {
    const parsed = listAppsSchema.parse({ type: "all", search: "example", profile: 10 });
    expect(parsed).toMatchObject({ type: "all", search: "example", profile: 10 });
  });

  test("biometricAuth keeps its errorCode refinement under strict mode", () => {
    expect(biometricAuthSchema.safeParse({ action: "match", errorCode: 7 }).success).toBe(false);
    expect(biometricAuthSchema.safeParse({ action: "error", errorCode: 7 }).success).toBe(true);
  });

  test("navigation schemas keep their platform default under strict mode", () => {
    expect(navigateToSchema.parse({ targetScreen: "Home" }).platform).toBe("android");
    expect(getNavigationGraphSchema.parse({}).platform).toBe("android");
    expect(exploreSchema.parse({}).platform).toBe("android");
  });
});
