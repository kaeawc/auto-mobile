import { runBlockWith } from "../../helpers/observedInteractionStub";
import { buildObserveResult } from "../../helpers/observeFixture";
import { AdbDeviceTransportUnavailableError } from "../../../src/utils/android-cmdline-tools/AdbDeviceTransportUnavailableError";
import { createExecResult } from "../../../src/utils/execResult";
import { afterEach, describe, expect, test, spyOn } from "bun:test";
import { OpenURL } from "../../../src/features/action/OpenURL";
import { BaseVisualChange } from "../../../src/features/action/BaseVisualChange";
import { LaunchApp } from "../../../src/features/action/LaunchApp";
import { IOSCtrlProxyManager } from "../../../src/ctrlProxy/IOSCtrlProxyManager";
import type { BootedDevice, LaunchAppResult, ObserveResult } from "../../../src/models";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeSimctl } from "../../fakes/FakeSimctl";
import { FakeDeviceUrlLauncher } from "../../fakes/FakeDeviceUrlLauncher";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeWindow } from "../../fakes/FakeWindow";
import { FakeAwaitIdle } from "../../fakes/FakeAwaitIdle";
import { FakeTimer } from "../../fakes/FakeTimer";
import { logger } from "../../../src/utils/logger";
import { spyOnIosExistingInstance } from "../../helpers/iosCtrlProxyClientSpies";

const observeResultStub = buildObserveResult({
  observationId: "open-url-stub",
  display: { key: "0", role: "unknown", posture: "unknown", generation: 0 },
  updatedAt: 0,
  screenSize: { width: 1080, height: 1920 },
  systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
  viewHierarchy: { hierarchy: {} },
}) satisfies ObserveResult;

const SIMULATOR_UDID = "ABCDEF01-1234-1234-1234-1234567890AB";
const PHYSICAL_UDID = "00008110-000A4D8E1234567E";

describe("OpenURL Android command output", () => {
  test.each([false, "unknown"] as const)(
    "package openLink preserves dispatch state %s",
    async (dispatched) => {
      const typed = new AdbDeviceTransportUnavailableError(
        "emulator-5554",
        new Error("device offline"),
        1000,
        dispatched,
      );
      const launch = spyOn(LaunchApp.prototype, "execute").mockRejectedValue(
        new Error("launch failed", { cause: typed }),
      );
      const timer = new FakeTimer();
      timer.enableAutoAdvance();
      try {
        const openURL = new OpenURL(
          { name: "pixel", platform: "android", deviceId: "emulator-5554" },
          { adb: new FakeAdbExecutor(), simctl: null, devicectl: null, timer },
        );
        await expect(openURL.execute("package:com.example.app")).rejects.toBe(typed);
      } finally {
        launch.mockRestore();
        timer.reset();
      }
    },
  );

  test.each(["stdout", "stderr"] as const)(
    "returns failure when am start reports an unresolved intent on %s",
    async (stream) => {
      const fakeAdb = new FakeAdbExecutor();
      const timer = new FakeTimer();
      timer.enableAutoAdvance();
      // Output from test/features/action/LaunchApp.test.ts: every fallback fails.
      const output = "Error: Activity not started, unable to resolve Intent";
      fakeAdb.setCommandResponse(
        "am start -a android.intent.action.VIEW",
        createExecResult(stream === "stdout" ? output : "", stream === "stderr" ? output : ""),
      );
      const openURL = new OpenURL(
        { name: "pixel", platform: "android", deviceId: "emulator-5554" },
        { adb: fakeAdb, simctl: null, devicectl: null, timer },
      );
      const observeScreen = new FakeObserveScreen();
      observeScreen.setObserveResult(
        buildObserveResult({
          observationId: "open-url-test",
          display: { key: "0", role: "unknown", posture: "unknown", generation: 0 },
          updatedAt: timer.now(),
          screenSize: { width: 1080, height: 1920 },
          systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
          viewHierarchy: { hierarchy: {} },
        }),
      );
      Object.assign(openURL, {
        observeScreen,
        window: new FakeWindow(),
        awaitIdle: new FakeAwaitIdle(),
      });
      const url = "myapp://order/123";

      const result = await openURL.execute(url);

      expect(result.success).toBe(false);
      expect(result.url).toBe(url);
      expect(result.error).toContain(url);
      expect(result.error).toContain(output);
      expect(fakeAdb.getExecutedArgv()).toContainEqual([
        "shell",
        `am start -a android.intent.action.VIEW -d '${url}'`,
      ]);
    },
  );

  test("keeps success when am start brings the current task to the front", async () => {
    const fakeAdb = new FakeAdbExecutor();
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    // Output from test/features/action/LaunchApp.test.ts: accepted final launcher intent.
    fakeAdb.setCommandResponse(
      "am start -a android.intent.action.VIEW",
      createExecResult(
        "Warning: Activity not started, its current task has been brought to the front",
        "",
      ),
    );
    const openURL = new OpenURL(
      { name: "pixel", platform: "android", deviceId: "emulator-5554" },
      { adb: fakeAdb, simctl: null, devicectl: null, timer },
    );
    const observeScreen = new FakeObserveScreen();
    observeScreen.setObserveResult(
      buildObserveResult({
        observationId: "open-url-test",
        display: { key: "0", role: "unknown", posture: "unknown", generation: 0 },
        updatedAt: timer.now(),
        screenSize: { width: 1080, height: 1920 },
        systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
        viewHierarchy: { hierarchy: {} },
      }),
    );
    Object.assign(openURL, {
      observeScreen,
      window: new FakeWindow(),
      awaitIdle: new FakeAwaitIdle(),
    });

    const result = await openURL.execute("https://example.com/x");

    expect(result.success).toBe(true);
    expect(result.url).toBe("https://example.com/x");
    expect(result.error).toBeUndefined();
  });
});

const iosDevice = (deviceId: string): BootedDevice => ({
  name: "iPhone",
  platform: "ios",
  deviceId,
});

// Directly exercise the iOS routing (executeiOSOpenURL) so we assert the
// sim-vs-physical branch without spinning up the observe/visual-change machinery.
const openIos = (
  device: BootedDevice,
  simctl: FakeSimctl,
  devicectl: FakeDeviceUrlLauncher,
  url: string,
) => {
  const openURL = new OpenURL(device, { adb: new FakeAdbExecutor(), simctl, devicectl });
  return openURL.testHooks.executeiOSOpenURL(url);
};

describe("OpenURL iOS routing", () => {
  const restores: Array<() => void> = [];
  afterEach(() => {
    while (restores.length) {
      restores.pop()!();
    }
  });

  test("(a) simulator UDID routes to `simctl openurl` and never touches devicectl", async () => {
    const simctl = new FakeSimctl();
    const devicectl = new FakeDeviceUrlLauncher();

    const result = await openIos(
      iosDevice(SIMULATOR_UDID),
      simctl,
      devicectl,
      "https://example.com/x",
    );

    expect(result).toEqual({ success: true, url: "https://example.com/x" });
    const calls = simctl.getMethodCalls("executeCommandArgs");
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual(["openurl", SIMULATOR_UDID, "https://example.com/x"]);
    expect(devicectl.launchCalls).toHaveLength(0);
  });

  test("simulator open invalidates the pre-link hierarchy for system dialog discovery", async () => {
    let invalidations = 0;
    const existingClientSpy = spyOnIosExistingInstance({
      invalidateCache: () => {
        invalidations += 1;
      },
    });
    restores.push(() => existingClientSpy.mockRestore());

    await openIos(
      iosDevice(SIMULATOR_UDID),
      new FakeSimctl(),
      new FakeDeviceUrlLauncher(),
      "slack://login?token=secret",
    );

    expect(invalidations).toBe(1);
  });

  test("(b) physical UDID + http URL launches Safari with the payload URL", async () => {
    const simctl = new FakeSimctl();
    const devicectl = new FakeDeviceUrlLauncher();

    const result = await openIos(
      iosDevice(PHYSICAL_UDID),
      simctl,
      devicectl,
      "https://example.com/order/123",
    );

    expect(result).toEqual({ success: true, url: "https://example.com/order/123" });
    expect(devicectl.launchCalls).toEqual([
      {
        deviceUdid: PHYSICAL_UDID,
        bundleId: "com.apple.mobilesafari",
        url: "https://example.com/order/123",
      },
    ]);
    expect(simctl.getMethodCalls("executeCommandArgs")).toHaveLength(0);
  });

  test("(c) physical UDID + custom scheme launches the resolved target bundle id", async () => {
    // The physical custom-scheme branch reads the target with the
    // non-constructing static, so it never spins up a CtrlProxy manager.
    const targetSpy = spyOn(IOSCtrlProxyManager, "getExistingTargetBundleId").mockReturnValue(
      "com.example.MyApp",
    );
    restores.push(() => targetSpy.mockRestore());

    const simctl = new FakeSimctl();
    const devicectl = new FakeDeviceUrlLauncher();

    const result = await openIos(iosDevice(PHYSICAL_UDID), simctl, devicectl, "myapp://order/123");

    expect(result.success).toBe(true);
    expect(devicectl.launchCalls).toEqual([
      { deviceUdid: PHYSICAL_UDID, bundleId: "com.example.MyApp", url: "myapp://order/123" },
    ]);
  });

  test("(c2) physical UDID + custom scheme with no target bundle falls back to Safari", async () => {
    const targetSpy = spyOn(IOSCtrlProxyManager, "getExistingTargetBundleId").mockReturnValue(
      undefined,
    );
    restores.push(() => targetSpy.mockRestore());

    const simctl = new FakeSimctl();
    const devicectl = new FakeDeviceUrlLauncher();

    await openIos(iosDevice(PHYSICAL_UDID), simctl, devicectl, "myapp://order/123");

    expect(devicectl.launchCalls[0].bundleId).toBe("com.apple.mobilesafari");
  });

  test("(c3) physical UDID + system scheme (mailto:) routes to Safari even when a target app is set", async () => {
    // Regression guard: a prior launchApp sets a cached target bundle. System
    // schemes (mailto:/tel:/sms:) must STILL go to Safari/system resolution —
    // never the app-under-test, which can't open a mailto: payload.
    const targetSpy = spyOn(IOSCtrlProxyManager, "getExistingTargetBundleId").mockReturnValue(
      "com.example.MyApp",
    );
    restores.push(() => targetSpy.mockRestore());

    const simctl = new FakeSimctl();
    const devicectl = new FakeDeviceUrlLauncher();

    const result = await openIos(iosDevice(PHYSICAL_UDID), simctl, devicectl, "mailto:a@b.com");

    expect(result.success).toBe(true);
    expect(devicectl.launchCalls).toEqual([
      { deviceUdid: PHYSICAL_UDID, bundleId: "com.apple.mobilesafari", url: "mailto:a@b.com" },
    ]);
  });

  test("(c4) physical UDID + tel: routes to Safari/system resolver, not the target app", async () => {
    const targetSpy = spyOn(IOSCtrlProxyManager, "getExistingTargetBundleId").mockReturnValue(
      "com.example.MyApp",
    );
    restores.push(() => targetSpy.mockRestore());

    const simctl = new FakeSimctl();
    const devicectl = new FakeDeviceUrlLauncher();

    await openIos(iosDevice(PHYSICAL_UDID), simctl, devicectl, "tel:+15551234567");

    expect(devicectl.launchCalls[0].bundleId).toBe("com.apple.mobilesafari");
  });

  test("(d) unavailable devicectl returns an explicit iOS 17+/Xcode 15+ error (no throw, no simctl)", async () => {
    const simctl = new FakeSimctl();
    const devicectl = new FakeDeviceUrlLauncher();
    devicectl.setAvailable(false);

    const result = await openIos(
      iosDevice(PHYSICAL_UDID),
      simctl,
      devicectl,
      "https://example.com",
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Xcode 15\+ and iOS 17\+/);
    expect(devicectl.launchCalls).toHaveLength(0);
    expect(simctl.getMethodCalls("executeCommandArgs")).toHaveLength(0);
  });

  test("(e) devicectl launch failure returns { success:false, error }", async () => {
    const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
    restores.push(() => warnSpy.mockRestore());
    const simctl = new FakeSimctl();
    const devicectl = new FakeDeviceUrlLauncher();
    devicectl.setLaunchError(new Error("device locked"));

    const result = await openIos(
      iosDevice(PHYSICAL_UDID),
      simctl,
      devicectl,
      "https://example.com",
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("device locked");
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith("[OpenURL] devicectl open URL failed: device locked");
  });

  test("(a-neg) simulator simctl failure returns { success:false, error }", async () => {
    const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
    restores.push(() => warnSpy.mockRestore());
    const simctl = new FakeSimctl();
    simctl.setCommandError(
      `openurl ${SIMULATOR_UDID} https://example.com`,
      new Error("Invalid device"),
    );
    const devicectl = new FakeDeviceUrlLauncher();

    const result = await openIos(
      iosDevice(SIMULATOR_UDID),
      simctl,
      devicectl,
      "https://example.com",
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid device");
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith("[OpenURL] simctl openurl failed: Invalid device");
  });
});

describe("OpenURL package: delegation is unchanged", () => {
  const restores: Array<() => void> = [];
  afterEach(() => {
    while (restores.length) {
      restores.pop()!();
    }
  });

  test("logs the package name, underlying message and original launch error once", async () => {
    const error = new Error("launch dispatch failed");
    const launchSpy = spyOn(LaunchApp.prototype, "execute").mockRejectedValue(error);
    const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
    restores.push(
      () => launchSpy.mockRestore(),
      () => warnSpy.mockRestore(),
    );
    const openURL = new OpenURL(iosDevice(PHYSICAL_UDID), {
      adb: new FakeAdbExecutor(),
      simctl: new FakeSimctl(),
      devicectl: new FakeDeviceUrlLauncher(),
    });

    const result = await openURL.execute("package:com.example.MyApp");

    expect(result.success).toBe(false);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      "[OpenURL] Exception while launching app com.example.MyApp: launch dispatch failed",
      error,
    );
    expect(warnSpy.mock.calls[0][1]).toBe(error);
  });

  test("(f) package: URL delegates to LaunchApp on iOS without touching simctl/devicectl", async () => {
    const launchSpy = spyOn(LaunchApp.prototype, "execute").mockResolvedValue({
      success: true,
      packageName: "com.example.MyApp",
    } satisfies LaunchAppResult);
    restores.push(() => launchSpy.mockRestore());

    const simctl = new FakeSimctl();
    const devicectl = new FakeDeviceUrlLauncher();
    const openURL = new OpenURL(iosDevice(PHYSICAL_UDID), {
      adb: new FakeAdbExecutor(),
      simctl,
      devicectl,
    });

    const result = await openURL.execute("package:com.example.MyApp");

    expect(result.success).toBe(true);
    expect(launchSpy).toHaveBeenCalledTimes(1);
    expect(launchSpy.mock.calls[0][0]).toBe("com.example.MyApp");
    expect(devicectl.launchCalls).toHaveLength(0);
    expect(simctl.getMethodCalls("executeCommandArgs")).toHaveLength(0);
  });
});

describe("OpenURL Android parity (regression guard)", () => {
  test("executeAndroidOpenURL issues the exact VIEW-intent am start command", async () => {
    const fakeAdb = new FakeAdbExecutor();
    const openURL = new OpenURL(
      { name: "pixel", platform: "android", deviceId: "emulator-5554" },
      { adb: fakeAdb },
    );

    const result = await openURL.testHooks.executeAndroidOpenURL("https://example.com/x");

    expect(result).toEqual({ success: true, url: "https://example.com/x" });
    expect(fakeAdb.getExecutedArgv()).toEqual([
      ["shell", "am start -a android.intent.action.VIEW -d 'https://example.com/x'"],
    ]);
  });
});

describe("OpenURL input validation", () => {
  const openAndroid = (url: string) =>
    new OpenURL(
      { name: "pixel", platform: "android", deviceId: "emulator-5554" },
      { adb: new FakeAdbExecutor() },
    ).execute(url);

  test("empty URL returns an explicit error without dispatching", async () => {
    const result = await openAndroid("");
    expect(result).toEqual({ success: false, url: "", error: "Invalid URL provided" });
  });

  test("whitespace-only URL returns an explicit error", async () => {
    const result = await openAndroid("   ");
    expect(result.success).toBe(false);
    expect(result.error).toBe("Invalid URL provided");
  });

  test("bare package: URL (no package name) returns an explicit error", async () => {
    const result = await openAndroid("package:");
    expect(result.success).toBe(false);
    expect(result.error).toBe("Invalid package URL - no package name specified");
  });
});

// Issue #4166: execute() trimmed the URL for validation/logging but dispatched
// the RAW value, so surrounding whitespace reached `am start -d` / `simctl
// openurl` while the logs and the returned result showed the clean URL. These
// tests assert the COMMAND STRING ACTUALLY ISSUED — the return value already
// looked correct before the fix, which is exactly why this went unnoticed.
describe("OpenURL trims the dispatched URL (issue #4166)", () => {
  const restores: Array<() => void> = [];
  afterEach(() => {
    while (restores.length) {
      restores.pop()!();
    }
  });

  // Run execute() without the observe/visual-change machinery: the block is the
  // platform dispatch we want to observe, and it is the only part under test.
  const stubObservedInteraction = () => {
    const spy = spyOn(BaseVisualChange.prototype, "observedInteraction").mockImplementation(
      runBlockWith(observeResultStub),
    );
    restores.push(() => spy.mockRestore());
  };

  const whitespaceCases: Array<[string, string, string]> = [
    ["no whitespace (control)", "https://example.com/x", "https://example.com/x"],
    ["leading space", " https://example.com/x", "https://example.com/x"],
    ["trailing space", "https://example.com/x ", "https://example.com/x"],
    ["leading and trailing spaces", "  https://example.com/x  ", "https://example.com/x"],
    ["tab", "\thttps://example.com/x\t", "https://example.com/x"],
    ["newline", "\nhttps://example.com/x\n", "https://example.com/x"],
    ["carriage return + newline", "\r\nhttps://example.com/x\r\n", "https://example.com/x"],
    // Inner whitespace is NOT surrounding whitespace: trim() must leave it alone.
    ["inner whitespace is preserved", " https://example.com/a b ", "https://example.com/a b"],
  ];

  test.each(whitespaceCases)("android dispatch: %s", async (_label, input, expectedUrl) => {
    stubObservedInteraction();
    const fakeAdb = new FakeAdbExecutor();
    const openURL = new OpenURL(
      { name: "pixel", platform: "android", deviceId: "emulator-5554" },
      { adb: fakeAdb },
    );

    const result = await openURL.execute(input);

    expect(fakeAdb.getExecutedArgv()).toEqual([
      ["shell", `am start -a android.intent.action.VIEW -d '${expectedUrl}'`],
    ]);
    expect(result).toEqual({ success: true, url: expectedUrl });
  });

  test.each(whitespaceCases)("ios simulator dispatch: %s", async (_label, input, expectedUrl) => {
    stubObservedInteraction();
    const simctl = new FakeSimctl();
    const devicectl = new FakeDeviceUrlLauncher();
    const openURL = new OpenURL(iosDevice(SIMULATOR_UDID), {
      adb: new FakeAdbExecutor(),
      simctl,
      devicectl,
    });

    const result = await openURL.execute(input);

    const calls = simctl.getMethodCalls("executeCommandArgs");
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual(["openurl", SIMULATOR_UDID, expectedUrl]);
    expect(result).toEqual({ success: true, url: expectedUrl });
  });

  test.each(whitespaceCases)("ios physical dispatch: %s", async (_label, input, expectedUrl) => {
    stubObservedInteraction();
    const simctl = new FakeSimctl();
    const devicectl = new FakeDeviceUrlLauncher();
    const openURL = new OpenURL(iosDevice(PHYSICAL_UDID), {
      adb: new FakeAdbExecutor(),
      simctl,
      devicectl,
    });

    const result = await openURL.execute(input);

    expect(devicectl.launchCalls).toEqual([
      { deviceUdid: PHYSICAL_UDID, bundleId: "com.apple.mobilesafari", url: expectedUrl },
    ]);
    expect(result).toEqual({ success: true, url: expectedUrl });
  });

  test("package: URL with surrounding whitespace still delegates to LaunchApp", async () => {
    const launchSpy = spyOn(LaunchApp.prototype, "execute").mockResolvedValue({
      success: true,
      packageName: "com.example.MyApp",
    } satisfies LaunchAppResult);
    restores.push(() => launchSpy.mockRestore());

    const openURL = new OpenURL(
      { name: "pixel", platform: "android", deviceId: "emulator-5554" },
      { adb: new FakeAdbExecutor() },
    );

    const result = await openURL.execute("  package:com.example.MyApp  ");

    expect(launchSpy.mock.calls[0][0]).toBe("com.example.MyApp");
    expect(result).toEqual({ success: true, url: "package:com.example.MyApp" });
  });
});
