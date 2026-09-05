import { describe, expect, test } from "bun:test";
import {
  clearTextSchema,
  inputTextSchema,
  pressButtonSchema,
  selectAllTextSchema,
  wakeAndUnlockSchema,
} from "../../../src/server/interactionTools";
import { observeSchema } from "../../../src/server/observeTools";
import { launchAppSchema } from "../../../src/server/appTools";

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
});
