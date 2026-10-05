import { describe, expect, spyOn, test } from "bun:test";
import {
  KeepScreenAwakeManager,
  type KeepScreenAwakeSettingsClient,
  type KeepScreenAwakeState,
} from "../../src/utils/KeepScreenAwakeManager";
import type { AdbClientFactory } from "../../src/utils/android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "../../src/utils/android-cmdline-tools/interfaces/AdbExecutor";
import type { ExecResult } from "../../src/models";
import type { BootedDevice } from "../../src/models";
import { logger } from "../../src/utils/logger";

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
  responses?: Array<{ match: string; stdout: string | string[] }>;
  // command substrings that should reject (simulate command failure)
  reject?: string[];
  rejectAt?: Array<{ match: string; occurrence: number }>;
}

class FakeAdb implements Partial<AdbExecutor> {
  calls: string[] = [];
  constructor(private readonly opts: FakeAdbOptions = {}) {}

  async executeCommand(command: string): Promise<ExecResult> {
    this.calls.push(command);
    const occurrences = this.calls.filter((call) => call.includes(command)).length;
    if (this.opts.reject?.some((r) => command.includes(r))) {
      throw new Error(`fake adb: command failed: ${command}`);
    }
    if (
      this.opts.rejectAt?.some((r) => command.includes(r.match) && occurrences === r.occurrence)
    ) {
      throw new Error(`fake adb: command failed: ${command}`);
    }
    const hit = this.opts.responses?.find((r) => command.includes(r.match));
    if (!hit) {
      return execResult("");
    }
    const stdout = Array.isArray(hit.stdout) ? (hit.stdout.shift() ?? "") : hit.stdout;
    return execResult(stdout);
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

const failingSettingsClient: KeepScreenAwakeSettingsClient = {
  requestSettingsGet: async () => ({ success: false, found: false }),
  requestSettingsPut: async () => ({ success: false }),
};

describe("KeepScreenAwakeManager", () => {
  test("apply(false) is a no-op with skipReason 'disabled' and touches no adb", async () => {
    const adb = new FakeAdb();
    const mgr = new KeepScreenAwakeManager(
      physicalDevice,
      makeFactory(adb),
      () => failingSettingsClient,
    );

    const state = await mgr.apply(false);

    expect(state).toEqual({ applied: false, skipReason: "disabled" });
    expect(adb.calls.length).toBe(0);
  });

  test("skips non-android devices with skipReason 'unsupported'", async () => {
    const adb = new FakeAdb();
    const iosDevice: BootedDevice = { platform: "ios", deviceId: "sim-1", name: "iPhone" };
    const mgr = new KeepScreenAwakeManager(
      iosDevice,
      makeFactory(adb),
      () => failingSettingsClient,
    );

    const state = await mgr.apply(true);

    expect(state).toEqual({ applied: false, skipReason: "unsupported" });
    expect(adb.calls.length).toBe(0);
  });

  test("skips emulator devices (by deviceId prefix) with skipReason 'emulator'", async () => {
    const adb = new FakeAdb();
    const emulator: BootedDevice = { platform: "android", deviceId: "emulator-5554", name: "AVD" };
    const mgr = new KeepScreenAwakeManager(emulator, makeFactory(adb), () => failingSettingsClient);

    const state = await mgr.apply(true);

    expect(state.applied).toBe(false);
    expect(state.skipReason).toBe("emulator");
  });

  test("returns 'detection_failed' when ro.kernel.qemu is an unexpected value", async () => {
    const adb = new FakeAdb({
      responses: [{ match: "getprop ro.kernel.qemu", stdout: "garbage" }],
    });
    const mgr = new KeepScreenAwakeManager(
      physicalDevice,
      makeFactory(adb),
      () => failingSettingsClient,
    );

    const state = await mgr.apply(true);

    expect(state.applied).toBe(false);
    expect(state.skipReason).toBe("detection_failed");
  });

  test("physical device: verifies svc stayon read-back before reporting success", async () => {
    const adb = new FakeAdb({
      responses: [
        { match: "getprop ro.kernel.qemu", stdout: "0" }, // physical
        { match: "settings get global stay_on_while_plugged_in", stdout: ["0", "7"] },
      ],
      // svc power stayon true resolves (not in reject list)
    });
    const mgr = new KeepScreenAwakeManager(
      physicalDevice,
      makeFactory(adb),
      () => failingSettingsClient,
    );

    const state = await mgr.apply(true);

    expect(state.applied).toBe(true);
    expect(state.method).toBe("svc");
    expect(state.svcWasEnabled).toBe(false); // parsed from "0"
    expect(adb.called("shell input keyevent KEYCODE_WAKEUP")).toBe(true);
    expect(adb.called("shell svc power stayon true")).toBe(true);
    // Should not have fallen back to the settings put path.
    expect(adb.called("settings put system screen_off_timeout")).toBe(false);
  });

  test("falls back when svc exits successfully but stay-on remains disabled", async () => {
    const warning = spyOn(logger, "warn").mockImplementation(() => {});
    const adb = new FakeAdb({
      responses: [
        { match: "getprop ro.kernel.qemu", stdout: "0" },
        { match: "settings get global stay_on_while_plugged_in", stdout: ["0", "0", "0"] },
        { match: "settings get system screen_off_timeout", stdout: "120000" },
      ],
    });
    const mgr = new KeepScreenAwakeManager(
      physicalDevice,
      makeFactory(adb),
      () => failingSettingsClient,
    );

    const state = await mgr.apply(true);

    expect(state.applied).toBe(true);
    expect(state.method).toBe("settings");
    expect(adb.called("settings put global stay_on_while_plugged_in 7")).toBe(true);
    expect(warning).toHaveBeenCalled();
    warning.mockRestore();
  });

  test("warns and falls back when svc stayon read-back fails", async () => {
    const warning = spyOn(logger, "warn").mockImplementation(() => {});
    const adb = new FakeAdb({
      responses: [
        { match: "getprop ro.kernel.qemu", stdout: "0" },
        { match: "settings get global stay_on_while_plugged_in", stdout: ["0", "0"] },
        { match: "settings get system screen_off_timeout", stdout: "120000" },
      ],
      rejectAt: [{ match: "settings get global stay_on_while_plugged_in", occurrence: 2 }],
    });
    const mgr = new KeepScreenAwakeManager(
      physicalDevice,
      makeFactory(adb),
      () => failingSettingsClient,
    );

    const state = await mgr.apply(true);

    expect(state.applied).toBe(true);
    expect(state.method).toBe("settings");
    expect(adb.called("settings put global stay_on_while_plugged_in 7")).toBe(true);
    expect(warning).toHaveBeenCalled();
    warning.mockRestore();
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
    const mgr = new KeepScreenAwakeManager(
      physicalDevice,
      makeFactory(adb),
      () => failingSettingsClient,
    );

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
    const mgr = new KeepScreenAwakeManager(
      physicalDevice,
      makeFactory(adb),
      () => failingSettingsClient,
    );

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
    const mgr = new KeepScreenAwakeManager(
      physicalDevice,
      makeFactory(adb),
      () => failingSettingsClient,
    );

    await mgr.restore({ applied: false, skipReason: "disabled" });

    expect(adb.calls.length).toBe(0);
  });
  test("a two-method settings client supports apply, restore, and throwing fallback paths", async () => {
    for (const mode of ["success", "method throws", "provider throws"]) {
      const getCalls: Parameters<KeepScreenAwakeSettingsClient["requestSettingsGet"]>[] = [];
      const putCalls: Parameters<KeepScreenAwakeSettingsClient["requestSettingsPut"]>[] = [];
      const providerCalls: BootedDevice[] = [];
      const client: KeepScreenAwakeSettingsClient = {
        requestSettingsGet: async (...args) => {
          getCalls.push(args);
          if (mode === "method throws") {
            throw new Error("settings get failed");
          }
          return { success: true, found: args[0] === "system", value: "60000" };
        },
        requestSettingsPut: async (...args) => {
          putCalls.push(args);
          if (mode === "method throws") {
            throw new Error("settings put failed");
          }
          return { success: true };
        },
      };
      const adb = new FakeAdb({
        responses: [
          { match: "getprop ro.kernel.qemu", stdout: "0" },
          { match: "settings get global stay_on_while_plugged_in", stdout: "null" },
          { match: "settings get system screen_off_timeout", stdout: "60000" },
        ],
        reject: ["svc power stayon true"],
      });
      const mgr = new KeepScreenAwakeManager(physicalDevice, makeFactory(adb), (device) => {
        providerCalls.push(device);
        if (mode === "provider throws") {
          throw new Error("settings provider failed");
        }
        return client;
      });

      const state = await mgr.apply(true);
      expect(state.applied).toBe(true);
      expect(state.method).toBe("settings");
      expect(state.originalStayOnWhilePluggedIn).toBeNull();
      expect(state.originalScreenOffTimeout).toBe("60000");
      await mgr.restore(state);

      expect(providerCalls).toEqual(Array(7).fill(physicalDevice));
      expect(getCalls).toEqual(
        mode === "provider throws"
          ? []
          : [
              ["global", "stay_on_while_plugged_in"],
              ["global", "stay_on_while_plugged_in"],
              ["system", "screen_off_timeout"],
            ],
      );
      expect(putCalls).toEqual(
        mode === "provider throws"
          ? []
          : [
              ["global", "stay_on_while_plugged_in", "7", "int"],
              ["system", "screen_off_timeout", "2147483647", "long"],
              ["global", "stay_on_while_plugged_in", null],
              ["system", "screen_off_timeout", "60000", "long"],
            ],
      );
      if (mode === "success") {
        expect(adb.calls.filter((call) => call.includes("shell settings"))).toEqual([]);
      } else {
        expect(adb.called("settings get global stay_on_while_plugged_in")).toBe(true);
        expect(adb.called("settings get system screen_off_timeout")).toBe(true);
        expect(adb.called("settings put global stay_on_while_plugged_in 7")).toBe(true);
        expect(adb.called("settings put system screen_off_timeout 2147483647")).toBe(true);
        expect(adb.called("settings delete global stay_on_while_plugged_in")).toBe(true);
        expect(adb.called("settings put system screen_off_timeout 60000")).toBe(true);
      }
    }
  });
});

describe("KeepScreenAwakeManager restore branches", () => {
  const setting = "shell settings put global stay_on_while_plugged_in";
  const disable = "shell svc power stayon false";
  const cases: Array<{
    name: string;
    state: KeepScreenAwakeState;
    reject?: string[];
    calls: string[];
    warnings?: string[];
  }> = [
    {
      name: "missing original and unknown svc",
      state: { applied: true, method: "svc" },
      calls: [],
      warnings: ["prior state unknown"],
    },
    {
      name: "missing original and enabled svc",
      state: { applied: true, method: "svc", svcWasEnabled: true },
      calls: [],
    },
    {
      name: "missing original and disabled svc",
      state: { applied: true, method: "svc", svcWasEnabled: false },
      calls: [disable],
    },
    {
      name: "failed disable",
      state: { applied: true, method: "svc", svcWasEnabled: false },
      reject: [disable],
      calls: [disable],
      warnings: ["Failed to disable svc stayon"],
    },
    {
      name: "restore original disabled setting",
      state: { applied: true, method: "svc", originalStayOnWhilePluggedIn: "0" },
      calls: [`${setting} 0`],
    },
    {
      name: "restore original enabled setting",
      state: { applied: true, method: "svc", originalStayOnWhilePluggedIn: "7" },
      calls: [`${setting} 7`],
    },
    {
      name: "restore absent setting",
      state: { applied: true, method: "svc", originalStayOnWhilePluggedIn: null },
      calls: ["shell settings delete global stay_on_while_plugged_in"],
    },
    {
      name: "disabled setting restore fails then disables svc",
      state: { applied: true, method: "svc", originalStayOnWhilePluggedIn: "0" },
      reject: [setting],
      calls: [`${setting} 0`, disable],
      warnings: ["Failed to restore global"],
    },
    {
      name: "absent setting restore fails then disables svc",
      state: { applied: true, method: "svc", originalStayOnWhilePluggedIn: null },
      reject: ["settings delete"],
      calls: ["shell settings delete global stay_on_while_plugged_in", disable],
      warnings: ["Failed to restore global"],
    },
    {
      name: "enabled setting restore failure skips svc",
      state: { applied: true, method: "svc", originalStayOnWhilePluggedIn: "7" },
      reject: [setting],
      calls: [`${setting} 7`],
      warnings: ["Failed to restore global"],
    },
    {
      name: "unknown setting restore failure skips svc",
      state: { applied: true, method: "svc", originalStayOnWhilePluggedIn: "unknown" },
      reject: [setting],
      calls: [`${setting} unknown`],
      warnings: ["Failed to restore global", "prior state unknown"],
    },
    {
      name: "disabled setting and svc disable both fail",
      state: { applied: true, method: "svc", originalStayOnWhilePluggedIn: "0" },
      reject: [setting, disable],
      calls: [`${setting} 0`, disable],
      warnings: ["Failed to restore global", "Failed to disable svc stayon"],
    },
    { name: "unknown method", state: { applied: true }, calls: [] },
    {
      name: "settings without applied flags",
      state: { applied: true, method: "settings" },
      calls: [],
    },
    {
      name: "settings with no applied keys",
      state: {
        applied: true,
        method: "settings",
        appliedSettings: { stayOnWhilePluggedIn: false, screenOffTimeout: false },
      },
      calls: [],
    },
    {
      name: "settings restore continues after first failure",
      state: {
        applied: true,
        method: "settings",
        originalStayOnWhilePluggedIn: "0",
        originalScreenOffTimeout: "60000",
        appliedSettings: { stayOnWhilePluggedIn: true, screenOffTimeout: true },
      },
      reject: [setting],
      calls: [`${setting} 0`, "shell settings put system screen_off_timeout 60000"],
      warnings: ["Failed to restore global"],
    },
  ];
  for (const row of cases) {
    test(row.name, async () => {
      const adb = new FakeAdb({ reject: row.reject });
      const warn = spyOn(logger, "warn").mockImplementation(() => {});
      try {
        await new KeepScreenAwakeManager(
          physicalDevice,
          makeFactory(adb),
          () => failingSettingsClient,
        ).restore(row.state);
        expect(adb.calls).toEqual(row.calls);
        expect(warn.mock.calls).toHaveLength(row.warnings?.length ?? 0);
        for (const [index, message] of (row.warnings ?? []).entries()) {
          expect(warn.mock.calls[index][0]).toContain(message);
        }
      } finally {
        warn.mockRestore();
      }
    });
  }
  test("applied state on iOS performs no commands", async () => {
    const adb = new FakeAdb();
    await new KeepScreenAwakeManager(
      { ...physicalDevice, platform: "ios" },
      makeFactory(adb),
      () => failingSettingsClient,
    ).restore({ applied: true, method: "svc", svcWasEnabled: false });
    expect(adb.calls).toEqual([]);
  });
});
