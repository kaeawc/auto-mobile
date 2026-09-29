import { expect, test } from "bun:test";
import {
  resolveAndroidSdkRoot,
  resolveAndroidSdkRootAsync,
} from "../../../src/utils/android-cmdline-tools/androidSdkRoot";

test("resolves Android SDK roots in canonical precedence order", () => {
  const cases = [
    [{ ANDROID_HOME: "/home" }, "/home"],
    [{ ANDROID_SDK_ROOT: "/root" }, "/root"],
    [{ ANDROID_SDK_HOME: "/sdk-home" }, "/sdk-home"],
    [{ ANDROID_HOME: "/home", ANDROID_SDK_ROOT: "/root" }, "/home"],
    [{ ANDROID_HOME: "/home", ANDROID_SDK_HOME: "/sdk-home" }, "/home"],
    [{ ANDROID_SDK_ROOT: "/root", ANDROID_SDK_HOME: "/sdk-home" }, "/root"],
    [{ ANDROID_HOME: "/home", ANDROID_SDK_ROOT: "/root", ANDROID_SDK_HOME: "/sdk-home" }, "/home"],
  ] as const;

  for (const [environment, expected] of cases) {
    expect(resolveAndroidSdkRoot(environment)).toBe(expected);
  }
});

test("skips empty and nonexistent candidates", () => {
  const environment = {
    ANDROID_HOME: "",
    ANDROID_SDK_ROOT: "/missing-root",
    ANDROID_SDK_HOME: "/existing-sdk-home",
  };
  const existingPaths = new Set(["/existing-sdk-home"]);
  const pathExists = (path: string): boolean => existingPaths.has(path);

  expect(resolveAndroidSdkRoot(environment, pathExists)).toBe("/existing-sdk-home");
  expect(resolveAndroidSdkRoot({ ANDROID_HOME: "  ", ANDROID_SDK_ROOT: "" })).toBeUndefined();
});

test("async resolution uses the same precedence and existence checks", async () => {
  const environment = {
    ANDROID_HOME: "/missing-home",
    ANDROID_SDK_ROOT: "/existing-root",
    ANDROID_SDK_HOME: "/existing-sdk-home",
  };
  const existingPaths = new Set(["/existing-root", "/existing-sdk-home"]);

  await expect(
    resolveAndroidSdkRootAsync(environment, async (path) => existingPaths.has(path)),
  ).resolves.toBe("/existing-root");
});
