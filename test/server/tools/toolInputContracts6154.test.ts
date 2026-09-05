import { describe, expect, test } from "bun:test";
import {
  clearTextSchema,
  inputTextSchema,
  pressButtonSchema,
  selectAllTextSchema,
  wakeAndUnlockSchema,
} from "../../../src/server/interactionTools";
import {
  assertActiveWindowWaitForSupportedOnPlatform,
  observeSchema,
} from "../../../src/server/observeTools";
import { launchAppSchema } from "../../../src/server/appTools";
import { highlightSchema, resolveHighlightClientOptions } from "../../../src/server/highlightTools";
import { assertChangeLocalizationPlatformConstraints } from "../../../src/server/utilityTools";
import type { BootedDevice } from "../../../src/models";
import { ActionableError } from "../../../src/models/ActionableError";

// Issue #6154 half 1: `platform` was required on pressButton/inputText/observe
// (and siblings) but optional on tapOn/launchApp, even though a `deviceId`
// (or session) resolves the platform the same way for all of them. Assert the
// aligned tools now accept platform omitted when deviceId is present.
describe("issue #6154: platform is optional wherever deviceId/session resolves it", () => {
  test("pressButton parses with platform omitted and deviceId present", () => {
    const result = pressButtonSchema.parse({
      deviceId: "emulator-5554",
      button: "back",
    });
    expect(result.platform).toBeUndefined();
    expect(result.deviceId).toBe("emulator-5554");
  });

  test("inputText parses with platform omitted and deviceId present", () => {
    const result = inputTextSchema.parse({
      deviceId: "emulator-5554",
      text: "hello",
    });
    expect(result.platform).toBeUndefined();
  });

  test("observe parses with platform omitted and deviceId present", () => {
    const result = observeSchema.parse({
      deviceId: "emulator-5554",
    });
    expect(result.platform).toBeUndefined();
  });

  test("wakeAndUnlock parses with platform omitted and deviceId present", () => {
    const result = wakeAndUnlockSchema.parse({
      deviceId: "emulator-5554",
    });
    expect(result.platform).toBeUndefined();
  });

  test("clearText parses with platform omitted and deviceId present", () => {
    const result = clearTextSchema.parse({
      deviceId: "emulator-5554",
    });
    expect(result.platform).toBeUndefined();
  });

  test("selectAllText parses with platform omitted and deviceId present", () => {
    const result = selectAllTextSchema.parse({
      deviceId: "emulator-5554",
    });
    expect(result.platform).toBeUndefined();
  });

  test("platform is still validated as android/ios when provided", () => {
    expect(() =>
      pressButtonSchema.parse({
        deviceId: "emulator-5554",
        button: "back",
        platform: "windows",
      }),
    ).toThrow();
  });

  // CodeRabbit follow-up: the tests above only exercise deviceId-based
  // resolution — a suite that never sends a bare sessionUuid could pass even
  // if session-based resolution (no deviceId at all) were broken. Cover that
  // path explicitly for observe and highlight.
  test("observe parses with platform omitted, sessionUuid present, and NO deviceId", () => {
    const result = observeSchema.parse({
      sessionUuid: "session-123",
    });
    expect(result.platform).toBeUndefined();
    expect(result.deviceId).toBeUndefined();
    expect(result.sessionUuid).toBe("session-123");
  });

  test("highlight parses with platform omitted, sessionUuid present, and NO deviceId", () => {
    const result = highlightSchema.parse({
      sessionUuid: "session-123",
      shape: {
        type: "box",
        bounds: { x: 0, y: 0, width: 10, height: 10 },
      },
    });
    expect(result.platform).toBeUndefined();
    expect(result.deviceId).toBeUndefined();
    expect(result.sessionUuid).toBe("session-123");
  });
});

// Issue #6154 half 2: launchApp's advertised `required`/`additionalProperties`
// were not enforced at runtime — a plain z.object with no `.strict()` silently
// accepted unknown keys. `.strict()` closes the gap while `withAppIdAliases`
// (a z.preprocess ahead of the strict inner schema) keeps the documented
// packageName -> appId alias working.
describe("issue #6154: launchApp schema enforces its declared contract", () => {
  test("accepts appId", () => {
    const result = launchAppSchema.parse({
      deviceId: "emulator-5554",
      appId: "com.google.android.deskclock",
    });
    expect(result.appId).toBe("com.google.android.deskclock");
  });

  test("accepts the documented packageName alias for appId", () => {
    const result = launchAppSchema.parse({
      deviceId: "emulator-5554",
      packageName: "com.google.android.deskclock",
    });
    expect(result.appId).toBe("com.google.android.deskclock");
    expect((result as Record<string, unknown>).packageName).toBeUndefined();
  });

  test("rejects a genuinely unknown property", () => {
    expect(() =>
      launchAppSchema.parse({
        deviceId: "emulator-5554",
        appId: "com.google.android.deskclock",
        bogusKey: 123,
      }),
    ).toThrow();
  });

  // CodeRabbit follow-up: the alias/unknown-property tests above never assert
  // that appId (or its packageName alias) is actually required — pin that too.
  test("rejects a missing appId (and missing packageName alias)", () => {
    expect(() =>
      launchAppSchema.parse({
        deviceId: "emulator-5554",
      }),
    ).toThrow();
  });
});

// Coordinator follow-up on #6154 (three Codex review threads): making
// `platform` optional exposed handlers that still branched on the raw,
// possibly-undefined request field instead of the platform ToolRegistry had
// already resolved from deviceId/session onto `device`. These tests exercise
// the extracted resolution/validation helpers directly against a resolved
// `BootedDevice`, independent of the raw (now-optional) `platform` param.
describe("issue #6154 follow-up: handlers use the resolved platform, not the raw param", () => {
  const iosDevice: BootedDevice = { name: "iPhone", platform: "ios", deviceId: "sim-1" };
  const androidDevice: BootedDevice = {
    name: "Pixel",
    platform: "android",
    deviceId: "emulator-5554",
  };

  describe("highlight (P1)", () => {
    test("resolves platform from the device when the request omitted it", () => {
      const options = resolveHighlightClientOptions(iosDevice, { deviceId: iosDevice.deviceId });
      expect(options.platform).toBe("ios");
      expect(options.device).toBe(iosDevice);
    });

    test("resolves the Android platform the same way", () => {
      const options = resolveHighlightClientOptions(androidDevice, {
        deviceId: androidDevice.deviceId,
      });
      expect(options.platform).toBe("android");
    });
  });

  describe("changeLocalization (P2)", () => {
    test("Android device via deviceId with locale + appId (no platform param) is valid", () => {
      expect(() =>
        assertChangeLocalizationPlatformConstraints(androidDevice.platform, {
          locale: "fr-FR",
          appId: "com.example.app",
        }),
      ).not.toThrow();
    });

    test("Android device via deviceId with locale but no appId is rejected post-resolution", () => {
      expect(() =>
        assertChangeLocalizationPlatformConstraints(androidDevice.platform, {
          locale: "fr-FR",
        }),
      ).toThrow(ActionableError);
    });

    test("iOS device via deviceId with appId is rejected post-resolution", () => {
      expect(() =>
        assertChangeLocalizationPlatformConstraints(iosDevice.platform, {
          locale: "fr-FR",
          appId: "com.example.app",
        }),
      ).toThrow(ActionableError);
    });
  });

  describe("observe / openLink activeWindow.activityName (P2)", () => {
    test("iOS device via deviceId with activityName (no platform param) is rejected post-resolution", () => {
      expect(() =>
        assertActiveWindowWaitForSupportedOnPlatform(iosDevice.platform, {
          activeWindow: { activityName: "com.example.MainActivity" },
        }),
      ).toThrow(ActionableError);
    });

    test("iOS device via deviceId with appId (not activityName) is accepted", () => {
      expect(() =>
        assertActiveWindowWaitForSupportedOnPlatform(iosDevice.platform, {
          activeWindow: { appId: "com.example.app" },
        }),
      ).not.toThrow();
    });

    test("Android device with activityName is accepted", () => {
      expect(() =>
        assertActiveWindowWaitForSupportedOnPlatform(androidDevice.platform, {
          activeWindow: { activityName: "com.example.MainActivity" },
        }),
      ).not.toThrow();
    });

    test("no waitFor at all is a no-op", () => {
      expect(() =>
        assertActiveWindowWaitForSupportedOnPlatform(iosDevice.platform, undefined),
      ).not.toThrow();
    });
  });
});
