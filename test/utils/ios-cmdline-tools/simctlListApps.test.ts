import { describe, expect, test } from "bun:test";
import { parseSimctlListApps } from "../../../src/utils/ios-cmdline-tools/simctlListApps";

describe("parseSimctlListApps", () => {
  test("keys a bundle-id dictionary into records carrying bundleId", () => {
    const payload = JSON.stringify({
      "com.apple.Preferences": {
        CFBundleIdentifier: "com.apple.Preferences",
        CFBundleDisplayName: "Settings",
        ApplicationType: "System",
      },
      "com.example.app": { CFBundleName: "Example", ApplicationType: "User" },
    });

    expect(parseSimctlListApps(payload)).toEqual([
      {
        CFBundleIdentifier: "com.apple.Preferences",
        CFBundleDisplayName: "Settings",
        ApplicationType: "System",
        bundleId: "com.apple.Preferences",
      },
      { CFBundleName: "Example", ApplicationType: "User", bundleId: "com.example.app" },
    ]);
  });

  test("the dictionary key wins over a conflicting bundleId field", () => {
    const payload = JSON.stringify({ "com.example.key": { bundleId: "com.example.field" } });

    expect(parseSimctlListApps(payload)).toEqual([{ bundleId: "com.example.key" }]);
  });

  test("keeps the bundle id when a dictionary entry is not an object", () => {
    const payload = JSON.stringify({ "com.example.a": null, "com.example.b": "x" });

    expect(parseSimctlListApps(payload)).toEqual([
      { bundleId: "com.example.a" },
      { bundleId: "com.example.b" },
    ]);
  });

  test("passes array output through, dropping entries that are not records", () => {
    const payload = JSON.stringify([
      { CFBundleIdentifier: "com.example.a" },
      null,
      "com.example.b",
      ["nested"],
      { bundleId: "com.example.c" },
    ]);

    expect(parseSimctlListApps(payload)).toEqual([
      { CFBundleIdentifier: "com.example.a" },
      { bundleId: "com.example.c" },
    ]);
  });

  test("reads non-object JSON as no apps", () => {
    expect(parseSimctlListApps("null")).toEqual([]);
    expect(parseSimctlListApps("42")).toEqual([]);
  });

  test("rejects output that is not JSON", () => {
    expect(() => parseSimctlListApps("<plist />")).toThrow();
  });
});
