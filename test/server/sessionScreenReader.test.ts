import { describe, expect, test } from "bun:test";
import { SessionManager } from "../../src/daemon/sessionManager";
import {
  restoreScreenReaderState,
  type ScreenReaderRestoreState,
  type ScreenReaderToggles,
} from "../../src/features/accessibility/ScreenReaderRestore";
import type {
  ScreenReaderToggleOptions,
  TalkBackResult,
  VoiceOverResult,
} from "../../src/models/AccessibilityResult";
import { runSessionScreenReaderMutation } from "../../src/server/sessionScreenReader";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../fakes/FakeTimer";

const android = { deviceId: "emulator-5554", name: "Pixel", platform: "android" as const };
const ios = { deviceId: "SIM-UDID-1", name: "iPhone", platform: "ios" as const };
const flush = async () => {
  for (let index = 0; index < 50; index++) {
    await Promise.resolve();
  }
};

/** What a fake device's screen reader is doing, shared by the tool path and the restorer. */
class FakeScreenReaderDevices {
  private readonly state = new Map<string, boolean>();
  /** Device ids whose restore write does not stick. */
  readonly stuck = new Set<string>();
  readonly restoreCalls: Array<{ deviceId: string; state: ScreenReaderRestoreState }> = [];

  setEnabled(deviceId: string, enabled: boolean): void {
    this.state.set(deviceId, enabled);
  }
  isEnabled(deviceId: string): boolean {
    return this.state.get(deviceId) ?? false;
  }

  /** Stand-in for TalkBackToggle / VoiceOverToggle: reads, reports through the hook, writes. */
  async toggle(
    deviceId: string,
    enabled: boolean,
    options?: ScreenReaderToggleOptions,
    failAfterHook = false,
  ): Promise<TalkBackResult & VoiceOverResult> {
    const previous = this.isEnabled(deviceId);
    if (previous === enabled) {
      return { supported: true, applied: false, currentState: enabled };
    }
    await options?.beforeChange?.(previous);
    if (failAfterHook) {
      return { supported: true, applied: false, currentState: previous, reason: "write failed" };
    }
    if (!this.stuck.has(deviceId)) {
      this.state.set(deviceId, enabled);
    }
    return { supported: true, applied: true, currentState: this.isEnabled(deviceId) };
  }

  readonly toggles: ScreenReaderToggles = {
    talkBack: (device) => ({
      toggle: (enabled, options) => this.toggle(device.deviceId, enabled, options),
    }),
    voiceOver: (device) => ({
      toggle: (enabled, options) => this.toggle(device.deviceId, enabled, options),
    }),
  };
}

function harness() {
  const timer = new FakeTimer();
  const devices = new FakeScreenReaderDevices();
  const manager = new SessionManager(
    timer,
    new FakeDeviceSessionPersistence(),
    () => new FakeDbWriteBarrier(),
    () => ({ restore: async () => {} }),
    () => ({ restore: async () => {} }),
    {
      networkCondition: () => ({ restore: async () => {} }),
      clock: () => ({ restore: async () => {} }),
      screenReader: (target) => ({
        restore: async (state, signal) => {
          devices.restoreCalls.push({ deviceId: target.deviceId, state });
          await restoreScreenReaderState(target, state, signal, devices.toggles);
        },
      }),
    },
  );
  /** The `accessibility` tool's recording: slot written in beforeChange, as accessibilityTools does. */
  const toggleInSession = (
    sessionUuid: string,
    device: typeof android | typeof ios,
    enabled: boolean,
    failAfterHook = false,
  ) =>
    runSessionScreenReaderMutation(manager, sessionUuid, device.deviceId, (slot) =>
      devices.toggle(
        device.deviceId,
        enabled,
        {
          beforeChange: (previousEnabled) => {
            if (slot && !slot.get()) {
              slot.record({ platform: device.platform, previousEnabled });
            }
          },
        },
        failAfterHook,
      ),
    );
  return { timer, devices, manager, toggleInSession };
}

describe("session screen reader restoration (#10146)", () => {
  test("a screen reader the session turned on is turned off again on release", async () => {
    const h = harness();
    try {
      await h.manager.createSession("s1", android.deviceId, "android");
      await h.toggleInSession("s1", android, true);
      expect(h.devices.isEnabled(android.deviceId)).toBe(true);
      expect(h.manager.getScreenReader("s1")).toEqual({
        platform: "android",
        previousEnabled: false,
      });

      await h.manager.releaseSession("s1");

      expect(h.devices.restoreCalls).toEqual([
        { deviceId: android.deviceId, state: { platform: "android", previousEnabled: false } },
      ]);
      expect(h.devices.isEnabled(android.deviceId)).toBe(false);
    } finally {
      h.manager.stopCleanupTimer();
    }
  });

  test("a device that already had the screen reader on keeps it on after the session turns it off", async () => {
    const h = harness();
    h.devices.setEnabled(android.deviceId, true);
    try {
      await h.manager.createSession("s1", android.deviceId, "android");
      await h.toggleInSession("s1", android, false);
      expect(h.devices.isEnabled(android.deviceId)).toBe(false);

      await h.manager.releaseSession("s1");

      expect(h.devices.restoreCalls[0]?.state.previousEnabled).toBe(true);
      expect(h.devices.isEnabled(android.deviceId)).toBe(true);
    } finally {
      h.manager.stopCleanupTimer();
    }
  });

  test("toggling twice restores the original value, recorded once", async () => {
    const h = harness();
    try {
      await h.manager.createSession("s1", android.deviceId, "android");
      await h.toggleInSession("s1", android, true);
      await h.toggleInSession("s1", android, false);
      await h.toggleInSession("s1", android, true);
      expect(h.manager.getScreenReader("s1")).toEqual({
        platform: "android",
        previousEnabled: false,
      });

      await h.manager.releaseSession("s1");

      expect(h.devices.restoreCalls).toHaveLength(1);
      expect(h.devices.restoreCalls[0]?.state.previousEnabled).toBe(false);
      expect(h.devices.isEnabled(android.deviceId)).toBe(false);
    } finally {
      h.manager.stopCleanupTimer();
    }
  });

  test("a session that never toggled restores nothing", async () => {
    const h = harness();
    h.devices.setEnabled(android.deviceId, true);
    try {
      await h.manager.createSession("s1", android.deviceId, "android");
      await h.manager.releaseSession("s1");

      expect(h.devices.restoreCalls).toEqual([]);
      expect(h.devices.isEnabled(android.deviceId)).toBe(true);
    } finally {
      h.manager.stopCleanupTimer();
    }
  });

  test("a toggle that finds the screen reader already in the requested state restores nothing", async () => {
    const h = harness();
    h.devices.setEnabled(android.deviceId, true);
    try {
      await h.manager.createSession("s1", android.deviceId, "android");
      await h.toggleInSession("s1", android, true);
      expect(h.manager.getScreenReader("s1")).toBeUndefined();

      await h.manager.releaseSession("s1");

      expect(h.devices.restoreCalls).toEqual([]);
    } finally {
      h.manager.stopCleanupTimer();
    }
  });

  test("a write that failed after the state was recorded is still restored", async () => {
    const h = harness();
    try {
      await h.manager.createSession("s1", android.deviceId, "android");
      await h.toggleInSession("s1", android, true, true);
      expect(h.manager.getScreenReader("s1")).toBeDefined();

      await h.manager.releaseSession("s1");

      expect(h.devices.restoreCalls).toHaveLength(1);
    } finally {
      h.manager.stopCleanupTimer();
    }
  });

  test("an iOS session restores through the VoiceOver toggle on its own device", async () => {
    const h = harness();
    try {
      await h.manager.createSession("s-ios", ios.deviceId, "ios");
      await h.toggleInSession("s-ios", ios, true);

      await h.manager.releaseSession("s-ios");

      expect(h.devices.restoreCalls).toEqual([
        { deviceId: ios.deviceId, state: { platform: "ios", previousEnabled: false } },
      ]);
      expect(h.devices.isEnabled(ios.deviceId)).toBe(false);
    } finally {
      h.manager.stopCleanupTimer();
    }
  });

  test("a restore that does not stick quarantines the device and retries on FakeTimer", async () => {
    const h = harness();
    try {
      const session = await h.manager.createSession("s1", android.deviceId, "android");
      await h.toggleInSession("s1", android, true);
      h.devices.stuck.add(android.deviceId);

      await h.manager.releaseSession("s1");

      const pending = h.manager.getPendingDeviceCleanup(android.deviceId);
      expect(pending).not.toBeNull();
      expect(session.cacheData.screenReader).toBeDefined();
      expect(h.devices.isEnabled(android.deviceId)).toBe(true);

      h.devices.stuck.delete(android.deviceId);
      h.timer.advanceTime(250);
      await pending;

      expect(h.devices.restoreCalls.length).toBeGreaterThanOrEqual(2);
      expect(session.cacheData.screenReader).toBeUndefined();
      expect(h.devices.isEnabled(android.deviceId)).toBe(false);
    } finally {
      h.manager.stopCleanupTimer();
    }
  });

  test("retiring the device stops further restore retries", async () => {
    const h = harness();
    try {
      await h.manager.createSession("s1", android.deviceId, "android");
      await h.toggleInSession("s1", android, true);
      h.devices.stuck.add(android.deviceId);
      await h.manager.releaseSession("s1");
      const pending = h.manager.getPendingDeviceCleanup(android.deviceId);
      const calls = h.devices.restoreCalls.length;

      h.manager.retireScreenReaderRestoration(android.deviceId);
      h.timer.advanceTime(250);
      await pending;
      await flush();

      expect(h.devices.restoreCalls).toHaveLength(calls);
    } finally {
      h.manager.stopCleanupTimer();
    }
  });

  test("rebinding restores the old device and leaves the replacement's slot empty", async () => {
    const h = harness();
    try {
      await h.manager.createSession("s1", android.deviceId, "android");
      await h.toggleInSession("s1", android, true);

      await h.manager.rebindSession("s1", "replacement-device", "android");

      expect(h.devices.restoreCalls.map((call) => call.deviceId)).toEqual([android.deviceId]);
      expect(h.devices.isEnabled(android.deviceId)).toBe(false);
      expect(h.manager.getScreenReader("s1")).toBeUndefined();
      await h.manager.releaseSession("s1");
      expect(h.devices.restoreCalls).toHaveLength(1);
    } finally {
      h.manager.stopCleanupTimer();
    }
  });

  test("a toggle on a released session is refused and records nothing", async () => {
    const h = harness();
    try {
      await h.manager.createSession("s1", android.deviceId, "android");
      await h.manager.releaseSession("s1");

      await expect(h.toggleInSession("s1", android, true)).rejects.toThrow();

      expect(h.devices.isEnabled(android.deviceId)).toBe(false);
    } finally {
      h.manager.stopCleanupTimer();
    }
  });

  test("without a session the toggle runs untracked", async () => {
    const h = harness();
    try {
      const result = await runSessionScreenReaderMutation(
        undefined,
        undefined,
        android.deviceId,
        async (slot) => {
          expect(slot).toBeUndefined();
          return "ran";
        },
      );
      expect(result).toBe("ran");
    } finally {
      h.manager.stopCleanupTimer();
    }
  });
});

describe("restoreScreenReaderState", () => {
  test.each([
    ["android", true],
    ["android", false],
    ["ios", true],
    ["ios", false],
  ] as const)(
    "%s previousEnabled=%s drives the matching platform toggle",
    async (platform, previous) => {
      const devices = new FakeScreenReaderDevices();
      devices.setEnabled(android.deviceId, !previous);
      const target = platform === "android" ? android : ios;
      devices.setEnabled(target.deviceId, !previous);

      await restoreScreenReaderState(
        target,
        { platform, previousEnabled: previous },
        undefined,
        devices.toggles,
      );

      expect(devices.isEnabled(target.deviceId)).toBe(previous);
    },
  );

  test("throws, with the toggle's reason, when the state is not confirmed", async () => {
    const toggles: ScreenReaderToggles = {
      talkBack: () => ({
        toggle: async () => ({ supported: true, applied: false, reason: "TalkBack stuck" }),
      }),
      voiceOver: () => ({
        toggle: async () => ({ supported: true, applied: false, currentState: true }),
      }),
    };

    await expect(
      restoreScreenReaderState(
        android,
        { platform: "android", previousEnabled: false },
        undefined,
        toggles,
      ),
    ).rejects.toThrow("TalkBack stuck");
    await expect(
      restoreScreenReaderState(
        ios,
        { platform: "ios", previousEnabled: false },
        undefined,
        toggles,
      ),
    ).rejects.toThrow("VoiceOver was not confirmed disabled");
  });

  test("an aborted restore never reaches the device", async () => {
    const devices = new FakeScreenReaderDevices();
    devices.setEnabled(android.deviceId, true);
    const controller = new AbortController();
    controller.abort();

    await expect(
      restoreScreenReaderState(
        android,
        { platform: "android", previousEnabled: false },
        controller.signal,
        devices.toggles,
      ),
    ).rejects.toThrow();

    expect(devices.isEnabled(android.deviceId)).toBe(true);
  });
});
