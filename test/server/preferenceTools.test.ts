import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  getPreferenceSchema,
  registerPreferenceTools,
  resetPreferenceToolsDependencies,
  setPreferenceSchema,
} from "../../src/server/preferenceTools";
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
