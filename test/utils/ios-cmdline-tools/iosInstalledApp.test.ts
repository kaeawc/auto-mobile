import { describe, expect, test } from "bun:test";
import {
  getIosInstalledAppBundleId,
  getIosInstalledAppPath,
  normalizeIosDevicePath,
} from "../../../src/utils/ios-cmdline-tools/iosInstalledApp";

describe("getIosInstalledAppBundleId", () => {
  test("reads the simulator and devicectl bundle-id spellings", () => {
    expect(getIosInstalledAppBundleId({ bundleId: "com.example.a" })).toBe("com.example.a");
    expect(getIosInstalledAppBundleId({ bundleIdentifier: "com.example.b" })).toBe("com.example.b");
    expect(getIosInstalledAppBundleId({ CFBundleIdentifier: " com.example.c " })).toBe(
      "com.example.c",
    );
    expect(getIosInstalledAppBundleId({ other: "com.example.d" })).toBeUndefined();
  });
});

describe("normalizeIosDevicePath", () => {
  test("decodes a file:// URL into a filesystem path", () => {
    expect(normalizeIosDevicePath("file:///private/var/containers/Bundle/My%20App.app/")).toBe(
      "/private/var/containers/Bundle/My App.app/",
    );
  });

  test("passes a plain path through unchanged", () => {
    expect(normalizeIosDevicePath("/private/var/containers/Bundle/App.app")).toBe(
      "/private/var/containers/Bundle/App.app",
    );
  });
});

describe("getIosInstalledAppPath", () => {
  test("reads the simulator record spellings", () => {
    expect(getIosInstalledAppPath({ bundlePath: "/sim/App.app" })).toBe("/sim/App.app");
    expect(getIosInstalledAppPath({ dataContainer: "/sim/data" })).toBe("/sim/data");
  });

  // devicectl reports a physical device's bundle location as a file:// URL under
  // `url`/`bundleURL`; without these keys the apps resource silently omits the
  // path it was handed.
  test("reads and normalizes devicectl's url and bundleURL spellings", () => {
    expect(getIosInstalledAppPath({ url: "file:///private/var/containers/Bundle/A.app/" })).toBe(
      "/private/var/containers/Bundle/A.app/",
    );
    expect(getIosInstalledAppPath({ bundleURL: "file:///private/var/B.app/" })).toBe(
      "/private/var/B.app/",
    );
  });

  test("prefers an explicit bundle path over a data container", () => {
    expect(getIosInstalledAppPath({ dataContainer: "/sim/data", bundlePath: "/sim/App.app" })).toBe(
      "/sim/App.app",
    );
  });

  test("returns undefined when no path field is present", () => {
    expect(getIosInstalledAppPath({ bundleId: "com.example.a" })).toBeUndefined();
    expect(getIosInstalledAppPath({ bundlePath: "   " })).toBeUndefined();
  });
});
