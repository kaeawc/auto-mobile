import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  getPreferenceSchema,
  registerPreferenceTools,
  resetPreferenceToolsDependencies,
  setPreferenceSchema,
} from "../../src/server/preferenceTools";
import { formatToolParamError } from "../../src/server/index";
import { ToolRegistry } from "../../src/server/toolRegistry";

describe("preference tools", () => {
  beforeEach(() => {
    ToolRegistry.clearTools();
    resetPreferenceToolsDependencies();
    registerPreferenceTools();
  });

  afterEach(() => {
    ToolRegistry.clearTools();
    resetPreferenceToolsDependencies();
  });

  test("registers getPreference and setPreference as device-aware tools", () => {
    const getTool = ToolRegistry.getTool("getPreference");
    const setTool = ToolRegistry.getTool("setPreference");

    expect(getTool).toBeDefined();
    expect(getTool?.requiresDevice).toBe(true);
    expect(setTool).toBeDefined();
    expect(setTool?.requiresDevice).toBe(true);
  });

  test("accepts Android system property requests without appId", () => {
    expect(() =>
      getPreferenceSchema.parse({
        platform: "android",
        scope: "systemProperty",
        key: "debug.example.api.url",
      }),
    ).not.toThrow();

    expect(() =>
      setPreferenceSchema.parse({
        platform: "android",
        scope: "systemProperty",
        key: "debug.example.api.url",
        value: "https://dev.example.com/",
        type: "string",
      }),
    ).not.toThrow();
  });

  test("requires appId for app-scoped stores", () => {
    expect(() =>
      getPreferenceSchema.parse({
        platform: "android",
        scope: "sharedPreferences",
        suite: "settings",
        key: "onboarding_complete",
      }),
    ).toThrow();

    expect(() =>
      setPreferenceSchema.parse({
        platform: "ios",
        scope: "userDefaults",
        key: "onboardingComplete",
        value: true,
        type: "bool",
      }),
    ).toThrow();
  });

  test("rejects scopes that do not match the requested platform", () => {
    expect(() =>
      getPreferenceSchema.parse({
        platform: "ios",
        scope: "systemProperty",
        key: "debug.example.api.url",
      }),
    ).toThrow();

    expect(() =>
      setPreferenceSchema.parse({
        platform: "android",
        scope: "userDefaults",
        appId: "com.example.app",
        key: "flag",
        value: true,
        type: "bool",
      }),
    ).toThrow();
  });

  test("normalizes appId aliases", () => {
    const parsed = getPreferenceSchema.parse({
      platform: "ios",
      scope: "userDefaults",
      bundleId: "com.example.app",
      key: "defaultHost",
    });

    expect(parsed.appId).toBe("com.example.app");
  });
});

// Issue #6348: the advertised `additionalProperties: false` was not enforced at
// runtime — a plain z.object silently DROPPED undeclared keys. The concrete harm:
// `fileName` (the valid file selector on the sibling setKeyValue/removeKeyValue
// tools, but NOT here — this surface's selector is `suite`) was ignored,
// setPreference wrote the app's DEFAULT prefs file, and still reported
// verified:true. `.strict()` rejects unknown keys before the handler ever runs.
describe("issue #6348: preference schemas reject undeclared arguments", () => {
  const validSetArgs = {
    platform: "android" as const,
    scope: "sharedPreferences" as const,
    appId: "dev.jasonpearson.automobile.playground",
    suite: "manual_test_prefs",
    key: "k1",
    value: "v1",
    type: "string" as const,
  };

  test("setPreference rejects the undeclared fileName key (the #6348 trap)", () => {
    const result = setPreferenceSchema.safeParse({ ...validSetArgs, fileName: "manual_test_prefs" });
    expect(result.success).toBe(false);
  });

  test("getPreference rejects the undeclared fileName key", () => {
    const result = getPreferenceSchema.safeParse({
      platform: "android",
      scope: "sharedPreferences",
      appId: "dev.jasonpearson.automobile.playground",
      key: "kOther",
      fileName: "totally_bogus_file",
    });
    expect(result.success).toBe(false);
  });

  test("rejects a wholly invented property", () => {
    const result = getPreferenceSchema.safeParse({
      platform: "android",
      scope: "sharedPreferences",
      appId: "dev.jasonpearson.automobile.playground",
      key: "kS",
      garbageXYZ: 1,
    });
    expect(result.success).toBe(false);
  });

  test("the rejection names the unrecognized key actionably", () => {
    const raw = { ...validSetArgs, fileName: "manual_test_prefs" };
    const result = setPreferenceSchema.safeParse(raw);
    expect(result.success).toBe(false);
    if (!result.success) {
      const message = formatToolParamError("setPreference", result.error, raw);
      expect(message).toContain('Unrecognized key: "fileName"');
    }
  });

  test("the documented suite selector (plus deviceId targeting) still parses", () => {
    const parsed = setPreferenceSchema.parse({ ...validSetArgs, deviceId: "emulator-5554" });
    expect(parsed.suite).toBe("manual_test_prefs");
    expect(parsed.appId).toBe("dev.jasonpearson.automobile.playground");
    expect((parsed as Record<string, unknown>).fileName).toBeUndefined();
  });

  // The write-and-verify handler (which is what returned the false verified:true)
  // only runs AFTER server dispatch calls `tool.schema.parse` (src/server/index.ts).
  // A fake factory that would report verified:true proves that rejecting `fileName`
  // at the schema seam means that verified:true is never produced.
  test("setPreference dispatch does not reach the verified:true handler for a bad fileName", async () => {
    let handlerReached = false;
    resetPreferenceToolsDependencies();
    ToolRegistry.clearTools();
    registerPreferenceTools();
    const setTool = ToolRegistry.getTool("setPreference");
    expect(setTool).toBeDefined();

    // Mirror the dispatch seam: parse before invoking the handler.
    const raw = { ...validSetArgs, fileName: "manual_test_prefs" };
    const parseResult = setTool!.schema.safeParse(raw);
    expect(parseResult.success).toBe(false);
    // Only if parse had succeeded would the handler (returning verified:true) run.
    if (parseResult.success) {
      handlerReached = true;
    }
    expect(handlerReached).toBe(false);
  });
});
