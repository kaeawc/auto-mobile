import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  resetSystemTrayDependencies,
  resolveAppLabel,
  setSystemTrayDependencies,
} from "../../../src/server/systemTrayHelpers";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import type { BootedDevice } from "../../../src/models";

/**
 * Coverage for `resolveAppLabel` and, through it, the private
 * `parseAppLabelFromDumpsys` (#4183 item 15 / A7). The parser is exercised via
 * the public seam with a fake ADB rather than reaching into the private helper,
 * so a change to the dumpsys `application-label` grammar surfaces here.
 *
 * `resolveAppLabel` tries the CtrlProxy `requestPackageInfo` fast path first,
 * then falls back to `adb shell dumpsys package <appId>`. Every dumpsys-parse
 * case therefore stubs `AndroidCtrlProxyClient.getInstance` so the fast path
 * declines (`success: false`) and control reaches the fake-ADB fallback.
 */
describe("resolveAppLabel", () => {
  const androidDevice: BootedDevice = {
    deviceId: "emulator-5554",
    name: "Pixel 7",
    platform: "android",
  };

  const stubCtrlProxyDeclines = () =>
    spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue({
      requestPackageInfo: async () => ({ success: false }),
    } as never);

  const setFakeAdb = (fakeAdb: FakeAdbExecutor): void => {
    setSystemTrayDependencies({
      adbFactory: () => fakeAdb,
    });
  };

  const dumpsysAdb = (stdout: string): FakeAdbExecutor => {
    const fakeAdb = new FakeAdbExecutor();
    fakeAdb.setCommandResponse("dumpsys package", {
      stdout,
      stderr: "",
    } as never);
    return fakeAdb;
  };

  afterEach(() => {
    resetSystemTrayDependencies();
  });

  test("returns null for a non-Android device without touching ADB", async () => {
    const iosDevice: BootedDevice = {
      deviceId: "A1B2C3D4-E5F6-7890-ABCD-EF1234567890",
      name: "iPhone 15",
      platform: "ios",
    };
    const fakeAdb = dumpsysAdb("application-label:'Should Not Read'");
    setFakeAdb(fakeAdb);

    expect(await resolveAppLabel(iosDevice, "com.example.app")).toBeNull();
    expect(fakeAdb.getExecutedCommands()).toEqual([]);
  });

  test("uses the CtrlProxy fast path and skips dumpsys when it succeeds", async () => {
    const spy = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue({
      requestPackageInfo: async () => ({ success: true, applicationLabel: "Fast Path" }),
    } as never);
    const fakeAdb = dumpsysAdb("application-label:'Slow Path'");
    setFakeAdb(fakeAdb);

    try {
      expect(await resolveAppLabel(androidDevice, "com.example.app")).toBe("Fast Path");
      // The fast path short-circuits before the dumpsys fallback runs.
      expect(fakeAdb.wasCommandExecuted("dumpsys package")).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  test("parses a single-quoted application-label from dumpsys", async () => {
    const spy = stubCtrlProxyDeclines();
    const fakeAdb = dumpsysAdb(
      [
        "Packages:",
        "  Package [com.example.app] (abc123):",
        "    application-label:'Example App'",
      ].join("\n"),
    );
    setFakeAdb(fakeAdb);

    try {
      expect(await resolveAppLabel(androidDevice, "com.example.app")).toBe("Example App");
      expect(fakeAdb.wasCommandExecuted("shell dumpsys package com.example.app")).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  test("parses a double-quoted application-label from dumpsys", async () => {
    const spy = stubCtrlProxyDeclines();
    setFakeAdb(dumpsysAdb('application-label:"Quoted App"'));

    try {
      expect(await resolveAppLabel(androidDevice, "com.example.app")).toBe("Quoted App");
    } finally {
      spy.mockRestore();
    }
  });

  test("parses an unquoted application-label from dumpsys", async () => {
    const spy = stubCtrlProxyDeclines();
    setFakeAdb(dumpsysAdb("application-label:Bare Label"));

    try {
      expect(await resolveAppLabel(androidDevice, "com.example.app")).toBe("Bare Label");
    } finally {
      spy.mockRestore();
    }
  });

  test("falls back to a localized application-label-<locale> line", async () => {
    const spy = stubCtrlProxyDeclines();
    // No plain `application-label:` line present; the locale-suffixed variant is
    // the only label available and must be used.
    setFakeAdb(dumpsysAdb("application-label-en:'Localized App'"));

    try {
      expect(await resolveAppLabel(androidDevice, "com.example.app")).toBe("Localized App");
    } finally {
      spy.mockRestore();
    }
  });

  test("prefers the plain application-label over a localized variant", async () => {
    const spy = stubCtrlProxyDeclines();
    setFakeAdb(
      dumpsysAdb(
        ["application-label-en:'Localized App'", "application-label:'Primary App'"].join("\n"),
      ),
    );

    try {
      expect(await resolveAppLabel(androidDevice, "com.example.app")).toBe("Primary App");
    } finally {
      spy.mockRestore();
    }
  });

  test("returns null when dumpsys output has no application-label line", async () => {
    const spy = stubCtrlProxyDeclines();
    setFakeAdb(dumpsysAdb("Packages:\n  Package [com.example.app] (abc123):\n    versionCode=1"));

    try {
      expect(await resolveAppLabel(androidDevice, "com.example.app")).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  test("returns null when the dumpsys fallback command throws", async () => {
    const spy = stubCtrlProxyDeclines();
    const fakeAdb = new FakeAdbExecutor();
    fakeAdb.setCommandError("dumpsys package", new Error("device offline"));
    setFakeAdb(fakeAdb);

    try {
      expect(await resolveAppLabel(androidDevice, "com.example.app")).toBeNull();
      // Prove the null came from the dumpsys failure path, not from ADB never
      // being invoked (the fake records the command before it throws).
      expect(fakeAdb.wasCommandExecuted("shell dumpsys package com.example.app")).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  test("falls back to dumpsys when the CtrlProxy fast path throws", async () => {
    const spy = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue({
      requestPackageInfo: async () => {
        throw new Error("ctrlproxy unavailable");
      },
    } as never);
    setFakeAdb(dumpsysAdb("application-label:'Recovered App'"));

    try {
      expect(await resolveAppLabel(androidDevice, "com.example.app")).toBe("Recovered App");
    } finally {
      spy.mockRestore();
    }
  });
});
