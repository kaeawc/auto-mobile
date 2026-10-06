import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  registerAccessibilityTools,
  accessibilitySchema,
} from "../../src/server/accessibilityTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { TalkBackToggle } from "../../src/features/accessibility/TalkBackToggle";
import { defaultAdbClientFactory } from "../../src/utils/android-cmdline-tools/AdbClientFactory";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { accessibilityStateSchema } from "../../src/server/toolOutputSchemas";
import { VoiceOverToggle } from "../../src/features/accessibility/VoiceOverToggle";
import type { BootedDevice } from "../../src/models";
import type { VoiceOverResult } from "../../src/models/AccessibilityResult";
import { ActionableError } from "../../src/models/ActionableError";
import { accessibilityDetector } from "../../src/features/accessibility/AccessibilityDetector";
import { iosVoiceOverDetector } from "../../src/features/accessibility/IosVoiceOverDetector";
import { IOSCtrlProxyClient } from "../../src/features/observe/ios";
import { FakeIOSCtrlProxy } from "../fakes/FakeIOSCtrlProxy";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { SessionManager } from "../../src/daemon/sessionManager";
import { DevicePool } from "../../src/daemon/devicePool";
import { DaemonState } from "../../src/daemon/daemonState";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import type { ScreenReaderToggleOptions } from "../../src/models/AccessibilityResult";

const ANDROID_DEVICE = {
  name: "a",
  deviceId: "emulator-5554",
  platform: "android",
} as BootedDevice;
const IOS_DEVICE = { name: "i", deviceId: "00008130-001", platform: "ios" } as BootedDevice;

function accessibilityHandler() {
  const tool = ToolRegistry.getAllTools({ includeUnavailable: true }).find(
    (t) => t.name === "accessibility",
  );
  if (!tool?.deviceAwareHandler) {
    throw new Error("accessibility tool not registered");
  }
  return tool.deviceAwareHandler;
}

describe("accessibilityTools", () => {
  beforeEach(() => {
    ToolRegistry.clearTools();
    accessibilityDetector.clearAllCache();
  });

  afterEach(() => {
    ToolRegistry.clearTools();
    accessibilityDetector.clearAllCache();
  });

  test("unreadable Android status reports a reason without enabled false", async () => {
    accessibilityDetector.clearAllCache();
    const adb = new FakeAdbExecutor();
    adb.setCommandError("enabled_accessibility_services", new Error("device offline"));
    const factory = spyOn(defaultAdbClientFactory, "create").mockReturnValue(adb);
    try {
      registerAccessibilityTools();
      const response = await accessibilityHandler()(ANDROID_DEVICE, {});
      expect(response).toMatchObject({
        structuredContent: {
          service: "unknown",
          reason:
            "could not determine TalkBack state: device accessibility settings read unavailable",
        },
      });
      expect(response.structuredContent).not.toHaveProperty("enabled");
      expect(accessibilityStateSchema.safeParse(response.structuredContent).success).toBe(true);
    } finally {
      factory.mockRestore();
      accessibilityDetector.clearAllCache();
    }
  });

  describe("registration", () => {
    test("registers the accessibility tool", () => {
      registerAccessibilityTools();
      const names = ToolRegistry.getToolDefinitions().map((t) => t.name);
      expect(names).toContain("accessibility");
    });
  });

  describe("platform rejection", () => {
    // Both rows short-circuit before any toggle/client is constructed, so no real
    // device is touched. Only the two THROW rows are covered (issue #4179).
    test("rejects voiceover on an Android device", async () => {
      registerAccessibilityTools();
      await expect(accessibilityHandler()(ANDROID_DEVICE, { voiceover: true })).rejects.toThrow(
        "VoiceOver is not supported on Android devices",
      );
    });

    test("rejects talkback on an iOS device", async () => {
      registerAccessibilityTools();
      await expect(accessibilityHandler()(IOS_DEVICE, { talkback: true })).rejects.toThrow(
        "TalkBack is not supported on iOS devices",
      );
    });
  });

  describe("VoiceOver unconfirmed toggle (#6496)", () => {
    afterEach(() => {
      // spyOn is restorable per-mock (unlike mock.module, which leaks across
      // test files), so the real VoiceOverToggle.toggle is back in place for
      // every other suite that constructs a real instance.
      toggleSpy?.mockRestore();
      toggleSpy = undefined;
    });

    let toggleSpy: ReturnType<typeof spyOn> | undefined;

    // An unconfirmed toggle (applied:false with a reason, e.g. a CtrlProxy
    // outage during confirmation polling) must surface as an actionable
    // failure at the MCP boundary rather than a normal enabled:false
    // response — otherwise the client can't distinguish "confirmed off"
    // from "we don't actually know" (codex review on PR #6768).
    test("throws with the reason when the toggle result is unconfirmed", async () => {
      const unconfirmedResult: VoiceOverResult = {
        supported: true,
        applied: false,
        reason: "VoiceOver state could not be confirmed within 10000ms",
      };
      toggleSpy = spyOn(VoiceOverToggle.prototype, "toggle").mockResolvedValue(unconfirmedResult);

      registerAccessibilityTools();
      await expect(accessibilityHandler()(IOS_DEVICE, { voiceover: false })).rejects.toThrow(
        "VoiceOver state could not be confirmed within 10000ms",
      );
    });
  });

  describe("TalkBack prompt reporting", () => {
    test.each([true, false])(
      "passes through a failure reason when present: %s",
      async (hasReason) => {
        const reasonFields = hasReason
          ? {
              reason:
                "TalkBack requested enabled but observed disabled after 1500ms of confirmation waits",
            }
          : {};
        const promptFields = {
          warning: "System permission prompt; nothing was tapped",
          blockingPrompt: {
            kind: "runtime-permission" as const,
            package: "com.google.android.permissioncontroller",
            activity:
              "com.google.android.permissioncontroller.permission.ui.GrantPermissionsActivity",
          },
        };
        const factory = spyOn(defaultAdbClientFactory, "create").mockReturnValue(
          new FakeAdbExecutor(),
        );
        const toggle = spyOn(TalkBackToggle.prototype, "toggle").mockResolvedValue({
          supported: true,
          applied: false,
          currentState: false,
          ...reasonFields,
          ...promptFields,
        });
        try {
          registerAccessibilityTools();
          const response = await accessibilityHandler()(ANDROID_DEVICE, { talkback: hasReason });
          const expected = { enabled: false, service: "unknown", ...reasonFields, ...promptFields };
          expect(response).toHaveProperty("structuredContent", expected);
          expect(accessibilityStateSchema.parse(expected)).toEqual(expected);
        } finally {
          toggle.mockRestore();
          factory.mockRestore();
        }
      },
    );

    test.each([true, false])(
      "threads optional prompt fields when present: %s",
      async (hasPrompt) => {
        const blockingPrompt = {
          kind: "runtime-permission" as const,
          package: "com.google.android.permissioncontroller",
          activity:
            "com.google.android.permissioncontroller.permission.ui.GrantPermissionsActivity",
        };
        const promptFields = hasPrompt
          ? { warning: "System permission prompt; nothing was tapped", blockingPrompt }
          : {};
        const factory = spyOn(defaultAdbClientFactory, "create").mockReturnValue(
          new FakeAdbExecutor(),
        );
        const toggle = spyOn(TalkBackToggle.prototype, "toggle").mockResolvedValue({
          supported: true,
          applied: true,
          currentState: true,
          ...promptFields,
        });
        try {
          registerAccessibilityTools();
          const response = await accessibilityHandler()(ANDROID_DEVICE, { talkback: true });
          expect(response).toMatchObject({
            structuredContent: { enabled: true, service: "talkback", ...promptFields },
          });
          const expected = { enabled: true, service: "talkback", ...promptFields };
          expect(response).toHaveProperty("structuredContent", expected);
          expect(accessibilityStateSchema.parse(expected)).toEqual(expected);
        } finally {
          toggle.mockRestore();
          factory.mockRestore();
        }
      },
    );

    test.each([
      { warning: 42 },
      { blockingPrompt: { kind: "notification-permission", package: "p", activity: "a" } },
      { blockingPrompt: { kind: "runtime-permission", package: "p" } },
    ])("validates optional prompt fields: %j", (fields) => {
      expect(
        accessibilityStateSchema.safeParse({ enabled: true, service: "talkback", ...fields })
          .success,
      ).toBe(false);
    });
  });

  describe("handler characterization", () => {
    test.each([true, false])("detects fresh Android state (%s)", async (enabled) => {
      const calls: string[] = [];
      const adb = new FakeAdbExecutor();
      const spies = [
        spyOn(accessibilityDetector, "invalidateCache").mockImplementation(() => {
          calls.push("invalidate");
        }),
        spyOn(defaultAdbClientFactory, "create").mockImplementation(() => {
          calls.push("client");
          return adb;
        }),
        spyOn(accessibilityDetector, "resolveState").mockImplementation(async () => {
          calls.push("state");
          return { enabled, service: enabled ? "talkback" : "unknown", ctrlProxyEnabled: false };
        }),
      ];
      try {
        registerAccessibilityTools();
        expect(await accessibilityHandler()(ANDROID_DEVICE, {})).toMatchObject({
          structuredContent: { enabled, service: enabled ? "talkback" : "unknown" },
        });
        expect(calls).toEqual(["invalidate", "client", "state"]);
      } finally {
        spies.forEach((spy) => spy.mockRestore());
      }
    });

    test.each([true, false])("detects fresh iOS state (%s)", async (enabled) => {
      const calls: string[] = [];
      const client = new FakeIOSCtrlProxy(new FakeTimer());
      const spies = [
        spyOn(iosVoiceOverDetector, "invalidateCache").mockImplementation(() => {
          calls.push("invalidate");
        }),
        spyOn(IOSCtrlProxyClient, "getInstance").mockImplementation(() => {
          calls.push("client");
          return client as IOSCtrlProxyClient;
        }),
        spyOn(iosVoiceOverDetector, "isVoiceOverEnabled").mockImplementation(async () => {
          calls.push("enabled");
          return enabled;
        }),
      ];
      try {
        registerAccessibilityTools();
        expect(await accessibilityHandler()(IOS_DEVICE, {})).toMatchObject({
          structuredContent: { enabled, service: enabled ? "voiceover" : "unknown" },
        });
        expect(calls).toEqual(["invalidate", "client", "enabled"]);
      } finally {
        spies.forEach((spy) => spy.mockRestore());
      }
    });

    test.each([undefined, "unavailable"])("rejects unsupported TalkBack (%s)", async (reason) => {
      const factory = spyOn(defaultAdbClientFactory, "create").mockReturnValue(
        new FakeAdbExecutor(),
      );
      const toggle = spyOn(TalkBackToggle.prototype, "toggle").mockResolvedValue({
        supported: false,
        applied: false,
        reason,
      });
      try {
        registerAccessibilityTools();
        await expect(accessibilityHandler()(ANDROID_DEVICE, { talkback: true })).rejects.toThrow(
          reason ?? "TalkBack toggle is not supported on this device",
        );
      } finally {
        toggle.mockRestore();
        factory.mockRestore();
      }
    });

    test.each([new ActionableError("known"), new Error("unexpected")])(
      "preserves actionable errors and wraps unexpected failures: %s",
      async (error) => {
        const factory = spyOn(defaultAdbClientFactory, "create").mockReturnValue(
          new FakeAdbExecutor(),
        );
        const toggle = spyOn(TalkBackToggle.prototype, "toggle").mockRejectedValue(error);
        try {
          registerAccessibilityTools();
          if (error instanceof ActionableError) {
            await expect(accessibilityHandler()(ANDROID_DEVICE, { talkback: false })).rejects.toBe(
              error,
            );
          } else {
            await expect(
              accessibilityHandler()(ANDROID_DEVICE, { talkback: false }),
            ).rejects.toThrow("Failed to toggle accessibility services");
          }
        } finally {
          toggle.mockRestore();
          factory.mockRestore();
        }
      },
    );

    test("rejects an absent TalkBack state instead of defaulting to disabled", async () => {
      const factory = spyOn(defaultAdbClientFactory, "create").mockReturnValue(
        new FakeAdbExecutor(),
      );
      const toggle = spyOn(TalkBackToggle.prototype, "toggle").mockResolvedValue({
        supported: true,
        applied: true,
        reason: "already applied",
      });
      try {
        registerAccessibilityTools();
        await expect(accessibilityHandler()(ANDROID_DEVICE, { talkback: false })).rejects.toThrow(
          "already applied",
        );
      } finally {
        toggle.mockRestore();
        factory.mockRestore();
      }
    });

    test.each([true, false, undefined])(
      "reports confirmed VoiceOver with state %s",
      async (currentState) => {
        const toggle = spyOn(VoiceOverToggle.prototype, "toggle").mockResolvedValue({
          supported: true,
          applied: true,
          currentState,
        });
        try {
          registerAccessibilityTools();
          expect(await accessibilityHandler()(IOS_DEVICE, { voiceover: false })).toMatchObject({
            structuredContent: {
              enabled: currentState ?? false,
              service: currentState ? "voiceover" : "unknown",
            },
          });
        } finally {
          toggle.mockRestore();
        }
      },
    );

    test.each([
      { supported: false, applied: false, reason: "unsupported" },
      { supported: false, applied: false },
      { supported: true, applied: false },
    ])("rejects VoiceOver failures: %j", async (result) => {
      const toggle = spyOn(VoiceOverToggle.prototype, "toggle").mockResolvedValue(result);
      try {
        registerAccessibilityTools();
        await expect(accessibilityHandler()(IOS_DEVICE, { voiceover: true })).rejects.toThrow(
          result.reason ??
            (result.supported
              ? "VoiceOver toggle could not be confirmed"
              : "VoiceOver toggle is not supported on this device"),
        );
      } finally {
        toggle.mockRestore();
      }
    });

    test("rejects an unsupported platform", async () => {
      registerAccessibilityTools();
      await expect(
        accessibilityHandler()({ ...ANDROID_DEVICE, platform: "other" } as BootedDevice, {}),
      ).rejects.toThrow("Unsupported platform: other");
    });
  });

  describe("session restore of the screen reader (#10146)", () => {
    // Fake devices: [deviceId] -> whether the screen reader is currently on.
    const enabledByDevice = new Map<string, boolean>();
    const restores: Array<{ deviceId: string; previousEnabled: boolean }> = [];
    let manager: SessionManager;
    let daemon: DaemonState;
    const spies: Array<{ mockRestore(): void }> = [];

    const sessionTimer = () => {
      const timer = new FakeTimer();
      timer.enableAutoAdvance();
      return timer;
    };

    /** A toggle that reads the fake device, reports through the hook, then writes. */
    const fakeToggle =
      (supported = true) =>
      async (deviceId: string, enabled: boolean, options?: ScreenReaderToggleOptions) => {
        const previous = enabledByDevice.get(deviceId) ?? false;
        if (!supported) {
          return { supported: false, applied: false, reason: "TalkBack service not installed" };
        }
        if (previous === enabled) {
          return { supported: true, applied: false, currentState: enabled };
        }
        await options?.beforeChange?.(previous);
        enabledByDevice.set(deviceId, enabled);
        return { supported: true, applied: true, currentState: enabled };
      };

    beforeEach(() => {
      enabledByDevice.clear();
      restores.length = 0;
      const timer = sessionTimer();
      manager = new SessionManager(
        timer,
        new FakeDeviceSessionPersistence(),
        () => new FakeDbWriteBarrier(),
        () => ({ restore: async () => {} }),
        () => ({ restore: async () => {} }),
        {
          networkCondition: () => ({ restore: async () => {} }),
          clock: () => ({ restore: async () => {} }),
          screenReader: (target) => ({
            restore: async (state) => {
              restores.push({ deviceId: target.deviceId, previousEnabled: state.previousEnabled });
              enabledByDevice.set(target.deviceId, state.previousEnabled);
            },
          }),
        },
      );
      const pool = new DevicePool(
        createDevicePoolDependencies(manager, "accessibility-session", { timer }),
      );
      daemon = DaemonState.getInstance();
      daemon.initialize(manager, pool);
      spies.push(
        spyOn(TalkBackToggle.prototype, "toggle").mockImplementation(function (
          this: TalkBackToggle,
          enabled,
          options,
        ) {
          return fakeToggle()(ANDROID_DEVICE.deviceId, enabled, options);
        }),
        spyOn(VoiceOverToggle.prototype, "toggle").mockImplementation(function (
          this: VoiceOverToggle,
          enabled,
          options,
        ) {
          return fakeToggle()(IOS_DEVICE.deviceId, enabled, options);
        }),
      );
    });

    afterEach(() => {
      spies
        .splice(0)
        .reverse()
        .forEach((spy) => spy.mockRestore());
      daemon.reset();
      manager.stopCleanupTimer();
    });

    test("TalkBack turned on through the tool is turned off when the session is released", async () => {
      registerAccessibilityTools();
      await manager.createSession("a11y-session", ANDROID_DEVICE.deviceId, "android");

      await accessibilityHandler()(ANDROID_DEVICE, {
        talkback: true,
        sessionUuid: "a11y-session",
      });
      expect(enabledByDevice.get(ANDROID_DEVICE.deviceId)).toBe(true);
      expect(manager.getScreenReader("a11y-session")).toEqual({
        platform: "android",
        previousEnabled: false,
      });

      await manager.releaseSession("a11y-session");

      expect(restores).toEqual([{ deviceId: ANDROID_DEVICE.deviceId, previousEnabled: false }]);
      expect(enabledByDevice.get(ANDROID_DEVICE.deviceId)).toBe(false);
    });

    test("VoiceOver turned on through the tool is turned off when the session is released", async () => {
      registerAccessibilityTools();
      await manager.createSession("a11y-session", IOS_DEVICE.deviceId, "ios");

      await accessibilityHandler()(IOS_DEVICE, { voiceover: true, sessionUuid: "a11y-session" });
      await manager.releaseSession("a11y-session");

      expect(restores).toEqual([{ deviceId: IOS_DEVICE.deviceId, previousEnabled: false }]);
      expect(enabledByDevice.get(IOS_DEVICE.deviceId)).toBe(false);
    });

    test("a device that started with TalkBack on is left on after the session turns it off", async () => {
      enabledByDevice.set(ANDROID_DEVICE.deviceId, true);
      registerAccessibilityTools();
      await manager.createSession("a11y-session", ANDROID_DEVICE.deviceId, "android");

      await accessibilityHandler()(ANDROID_DEVICE, {
        talkback: false,
        sessionUuid: "a11y-session",
      });
      expect(enabledByDevice.get(ANDROID_DEVICE.deviceId)).toBe(false);
      await manager.releaseSession("a11y-session");

      expect(enabledByDevice.get(ANDROID_DEVICE.deviceId)).toBe(true);
    });

    test("a second toggle in the session does not overwrite the recorded original", async () => {
      registerAccessibilityTools();
      await manager.createSession("a11y-session", ANDROID_DEVICE.deviceId, "android");
      const args = { sessionUuid: "a11y-session" };

      await accessibilityHandler()(ANDROID_DEVICE, { talkback: true, ...args });
      await accessibilityHandler()(ANDROID_DEVICE, { talkback: false, ...args });
      await accessibilityHandler()(ANDROID_DEVICE, { talkback: true, ...args });
      await manager.releaseSession("a11y-session");

      expect(restores).toEqual([{ deviceId: ANDROID_DEVICE.deviceId, previousEnabled: false }]);
    });

    test("a toggle that changes nothing, and a read of the state, register no restore", async () => {
      enabledByDevice.set(ANDROID_DEVICE.deviceId, true);
      registerAccessibilityTools();
      await manager.createSession("a11y-session", ANDROID_DEVICE.deviceId, "android");
      const factory = spyOn(defaultAdbClientFactory, "create").mockReturnValue(
        new FakeAdbExecutor(),
      );
      spies.push(factory);
      const state = spyOn(accessibilityDetector, "resolveState").mockResolvedValue({
        enabled: true,
        service: "talkback",
        ctrlProxyEnabled: false,
      });
      spies.push(state);

      await accessibilityHandler()(ANDROID_DEVICE, { talkback: true, sessionUuid: "a11y-session" });
      await accessibilityHandler()(ANDROID_DEVICE, { sessionUuid: "a11y-session" });
      await manager.releaseSession("a11y-session");

      expect(manager.getScreenReader("a11y-session")).toBeUndefined();
      expect(restores).toEqual([]);
    });

    test("an unsupported toggle leaves no restore behind", async () => {
      registerAccessibilityTools();
      await manager.createSession("a11y-session", ANDROID_DEVICE.deviceId, "android");
      const recording = spyOn(TalkBackToggle.prototype, "toggle").mockImplementation(
        async (enabled, options) => {
          await options?.beforeChange?.(false);
          void enabled;
          return { supported: false, applied: false, reason: "TalkBack service not installed" };
        },
      );
      spies.push(recording);

      await expect(
        accessibilityHandler()(ANDROID_DEVICE, { talkback: true, sessionUuid: "a11y-session" }),
      ).rejects.toThrow("TalkBack service not installed");

      expect(manager.getScreenReader("a11y-session")).toBeUndefined();
    });

    test("without a session the toggle still runs and nothing is recorded", async () => {
      registerAccessibilityTools();

      await accessibilityHandler()(ANDROID_DEVICE, { talkback: true });

      expect(enabledByDevice.get(ANDROID_DEVICE.deviceId)).toBe(true);
      expect(restores).toEqual([]);
    });
  });

  describe("schema validation", () => {
    // Collapsed from 8 hand-rolled siblings into a single table so a failing
    // row is named, plus the boundary rows the siblings never specified: null,
    // explicit undefined, and an unknown key (issue #4183 item 18).
    const cases: ReadonlyArray<{ name: string; input: unknown; valid: boolean }> = [
      { name: "talkback: true", input: { talkback: true }, valid: true },
      { name: "talkback: false", input: { talkback: false }, valid: true },
      { name: "empty object (all params optional)", input: {}, valid: true },
      { name: "talkback as a string", input: { talkback: "yes" }, valid: false },
      { name: "talkback as a number", input: { talkback: 1 }, valid: false },
      { name: "talkback as null", input: { talkback: null }, valid: false },
      { name: "talkback explicitly undefined", input: { talkback: undefined }, valid: true },
      { name: "voiceover: true", input: { voiceover: true }, valid: true },
      { name: "voiceover: false", input: { voiceover: false }, valid: true },
      { name: "voiceover as a string", input: { voiceover: "yes" }, valid: false },
      { name: "voiceover as a number", input: { voiceover: 1 }, valid: false },
      { name: "voiceover as null", input: { voiceover: null }, valid: false },
      { name: "an unknown key", input: { unknownKey: true }, valid: false },
    ];

    test.each(cases)("$valid for $name", ({ input, valid }) => {
      if (valid) {
        expect(() => accessibilitySchema.parse(input)).not.toThrow();
      } else {
        expect(() => accessibilitySchema.parse(input)).toThrow();
      }
    });
  });
});
