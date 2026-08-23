import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { KeepScreenAwakeManager } from "../../src/utils/KeepScreenAwakeManager";
import { AndroidCtrlProxyClient } from "../../src/features/observe/android/AndroidCtrlProxyClient";
import type { AdbClientFactory } from "../../src/utils/android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "../../src/utils/android-cmdline-tools/interfaces/AdbExecutor";
import type { ExecResult } from "../../src/models";
import type { BootedDevice } from "../../src/models";

/**
 * Unit coverage for KeepScreenAwakeManager (previously only tested indirectly
 * through the session keep-awake slot). Exercises the device-type gate, the
 * svc-stayon vs. settings-fallback branching in apply(), and the restore path.
 *
 * The a11y ctrl-proxy is stubbed to report failure so every settings read/write
 * deterministically falls through to the injected fake AdbExecutor.
 */

const execResult = (stdout: string): ExecResult => ({
  stdout,
  stderr: "",
  toString: () => stdout,
  trim: () => stdout.trim(),
  includes: (s: string) => stdout.includes(s),
});

interface FakeAdbOptions {
  // command substring -> stdout to return
  responses?: Array<{ match: string; stdout: string }>;
  // command substrings that should reject (simulate command failure)
  reject?: string[];
}

class FakeAdb implements Partial<AdbExecutor> {
  calls: string[] = [];
  constructor(private readonly opts: FakeAdbOptions = {}) {}

  async executeCommand(command: string): Promise<ExecResult> {
    this.calls.push(command);
    if (this.opts.reject?.some((r) => command.includes(r))) {
      throw new Error(`fake adb: command failed: ${command}`);
    }
    const hit = this.opts.responses?.find((r) => command.includes(r.match));
    return execResult(hit ? hit.stdout : "");
  }

  called(substring: string): boolean {
    return this.calls.some((c) => c.includes(substring));
  }
}

const makeFactory = (adb: FakeAdb): AdbClientFactory => ({
  create: () => adb as unknown as AdbExecutor,
});

const physicalDevice: BootedDevice = {
  platform: "android",
  deviceId: "R58N9ABC123", // not "emulator-*"
  name: "Pixel 8",
};

describe("KeepScreenAwakeManager", () => {
  let a11ySpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    // Force all settings get/put through adb by making the a11y proxy report failure.
    a11ySpy = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue({
      requestSettingsGet: async () => ({ success: false }),
      requestSettingsPut: async () => ({ success: false }),
    } as unknown as AndroidCtrlProxyClient);
  });

  afterEach(() => {
    a11ySpy.mockRestore();
  });

  test("apply(false) is a no-op with skipReason 'disabled' and touches no adb", async () => {
    const adb = new FakeAdb();
    const mgr = new KeepScreenAwakeManager(physicalDevice, makeFactory(adb));

    const state = await mgr.apply(false);

    expect(state).toEqual({ applied: false, skipReason: "disabled" });
    expect(adb.calls.length).toBe(0);
  });

  test("skips non-android devices with skipReason 'unsupported'", async () => {
    const adb = new FakeAdb();
    const iosDevice: BootedDevice = { platform: "ios", deviceId: "sim-1", name: "iPhone" };
    const mgr = new KeepScreenAwakeManager(iosDevice, makeFactory(adb));

    const state = await mgr.apply(true);

    expect(state).toEqual({ applied: false, skipReason: "unsupported" });
    expect(adb.calls.length).toBe(0);
  });

  test("skips emulator devices (by deviceId prefix) with skipReason 'emulator'", async () => {
    const adb = new FakeAdb();
    const emulator: BootedDevice = { platform: "android", deviceId: "emulator-5554", name: "AVD" };
    const mgr = new KeepScreenAwakeManager(emulator, makeFactory(adb));

    const state = await mgr.apply(true);

    expect(state.applied).toBe(false);
    expect(state.skipReason).toBe("emulator");
  });

  test("returns 'detection_failed' when ro.kernel.qemu is an unexpected value", async () => {
    const adb = new FakeAdb({
      responses: [{ match: "getprop ro.kernel.qemu", stdout: "garbage" }],
    });
    const mgr = new KeepScreenAwakeManager(physicalDevice, makeFactory(adb));

    const state = await mgr.apply(true);

    expect(state.applied).toBe(false);
    expect(state.skipReason).toBe("detection_failed");
  });

  test("physical device: uses svc stayon when it succeeds (method 'svc')", async () => {
    const adb = new FakeAdb({
      responses: [
        { match: "getprop ro.kernel.qemu", stdout: "0" }, // physical
        { match: "settings get global stay_on_while_plugged_in", stdout: "0" },
      ],
      // svc power stayon true resolves (not in reject list)
    });
    const mgr = new KeepScreenAwakeManager(physicalDevice, makeFactory(adb));

    const state = await mgr.apply(true);

    expect(state.applied).toBe(true);
    expect(state.method).toBe("svc");
    expect(state.svcWasEnabled).toBe(false); // parsed from "0"
    expect(adb.called("shell input keyevent KEYCODE_WAKEUP")).toBe(true);
    expect(adb.called("shell svc power stayon true")).toBe(true);
    // Should not have fallen back to the settings put path.
    expect(adb.called("settings put system screen_off_timeout")).toBe(false);
  });

  test("physical device: falls back to settings when svc stayon fails (method 'settings')", async () => {
    const adb = new FakeAdb({
      responses: [
        { match: "getprop ro.kernel.qemu", stdout: "0" },
        { match: "settings get global stay_on_while_plugged_in", stdout: "0" },
        { match: "settings get system screen_off_timeout", stdout: "120000" },
      ],
      reject: ["svc power stayon true"],
    });
    const mgr = new KeepScreenAwakeManager(physicalDevice, makeFactory(adb));

    const state = await mgr.apply(true);

    expect(state.applied).toBe(true);
    expect(state.method).toBe("settings");
    expect(state.appliedSettings).toEqual({ stayOnWhilePluggedIn: true, screenOffTimeout: true });
    expect(state.originalScreenOffTimeout).toBe("120000");
    expect(adb.called("settings put global stay_on_while_plugged_in 7")).toBe(true);
    expect(adb.called("settings put system screen_off_timeout 2147483647")).toBe(true);
  });

  test("restore() reverts the settings method to the captured original values", async () => {
    const adb = new FakeAdb();
    const mgr = new KeepScreenAwakeManager(physicalDevice, makeFactory(adb));

    await mgr.restore({
      applied: true,
      method: "settings",
      originalStayOnWhilePluggedIn: "0",
      originalScreenOffTimeout: "60000",
      appliedSettings: { stayOnWhilePluggedIn: true, screenOffTimeout: true },
    });

    expect(adb.called("settings put global stay_on_while_plugged_in 0")).toBe(true);
    expect(adb.called("settings put system screen_off_timeout 60000")).toBe(true);
  });

  test("restore() is a no-op when nothing was applied", async () => {
    const adb = new FakeAdb();
    const mgr = new KeepScreenAwakeManager(physicalDevice, makeFactory(adb));

    await mgr.restore({ applied: false, skipReason: "disabled" });

    expect(adb.calls.length).toBe(0);
  });
});
