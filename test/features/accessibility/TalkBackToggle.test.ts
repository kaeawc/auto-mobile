import { DefaultAccessibilityDetector } from "../../../src/features/accessibility/AccessibilityDetector";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  TalkBackToggle,
  isTalkBackRuntimePermissionPrompt,
} from "../../../src/features/accessibility/TalkBackToggle";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeAccessibilityDetector } from "../../fakes/FakeAccessibilityDetector";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeTalkBackDialogProbe } from "../../fakes/FakeTalkBackDialogProbe";
import { FakeSecureSettingsRpc } from "../../fakes/FakeSecureSettingsRpc";
import type { BootedDevice } from "../../../src/models";

import { logger } from "../../../src/utils/logger";

const ANDROID_DEVICE: BootedDevice = {
  deviceId: "emulator-5554",
  name: "Pixel 7 API 35",
  platform: "android",
};

const PACKAGE_LIST_WITH_TALKBACK = `
package:com.google.android.marvin.talkback
`;

const DIALOG_XML_WITH_BUTTON1 = `<?xml version="1.0" encoding="UTF-8"?>
<hierarchy><node index="0" text="" resource-id="android:id/content">
  <node index="0" text="Allow TalkBack to have full control?" resource-id="" />
  <node index="1" text="Allow" resource-id="android:id/button1" bounds="[180,684][540,740]" />
</hierarchy>`;

// Same dialog but with a non-English "Allow" text — resource-id should still match
const DIALOG_XML_NON_ENGLISH = `<?xml version="1.0" encoding="UTF-8"?>
<hierarchy><node index="0" text="" resource-id="android:id/content">
  <node index="0" text="TalkBack に全画面制御を許可しますか？" resource-id="" />
  <node index="1" text="許可" resource-id="android:id/button1" bounds="[180,684][540,740]" />
</hierarchy>`;

function makeExecResult(stdout: string) {
  return {
    stdout,
    stderr: "",
    toString: () => stdout,
    trim: () => stdout.trim(),
    includes: (s: string) => stdout.includes(s),
  };
}

describe("TalkBackToggle", () => {
  let fakeProbe = new FakeTalkBackDialogProbe();
  beforeEach(() => {
    fakeProbe = new FakeTalkBackDialogProbe();
  });
  let fakeAdb: FakeAdbExecutor;
  let fakeDetector: FakeAccessibilityDetector;
  let fakeTimer: FakeTimer;
  let fakeSecureSettings: FakeSecureSettingsRpc;

  test("unreadable disabling state is a typed failure, never already disabled", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandError("enabled_accessibility_services", new Error("device offline"));
    const detector = new DefaultAccessibilityDetector(new FakeTimer());
    detector.clearAllCache();
    const result = await new TalkBackToggle(
      ANDROID_DEVICE,
      adb,
      detector,
      new FakeTimer(),
      new FakeSecureSettingsRpc(),
      fakeProbe,
    ).toggle(false);
    expect(result.applied).toBe(false);
    expect(result.currentState).toBeUndefined();
    expect(result.reason).toContain("could not determine");
    expect(adb.getExecutedCommands()).not.toContain(
      "shell settings delete secure enabled_accessibility_services",
    );
  });

  test("disable confirms device state and replaces the shared detection cache immediately", async () => {
    const service = "com.google.android.marvin.talkback/.TalkBackService";
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("enabled_accessibility_services", { stdout: service, stderr: "" });
    const timer = new FakeTimer();
    const detector = new DefaultAccessibilityDetector(timer);
    detector.clearAllCache();
    expect(await detector.detectMethod(ANDROID_DEVICE.deviceId, adb)).toBe("talkback");
    const secure = new FakeSecureSettingsRpc();
    secure.setGetResult({ success: true, found: true, value: service });
    secure.setPutResult({ success: true });
    adb.setCommandResponseSequence("enabled_accessibility_services", [
      { stdout: service, stderr: "" },
      { stdout: "null", stderr: "" },
    ]);
    const result = await new TalkBackToggle(
      ANDROID_DEVICE,
      adb,
      detector,
      timer,
      secure,
      fakeProbe,
    ).toggle(false);
    expect(result).toEqual({ supported: true, applied: true, currentState: false });
    expect(secure.putCalls).toContainEqual({
      key: "enabled_accessibility_services",
      value: null,
      valueType: undefined,
    });
    const reads = adb.getExecutedCommands().length;
    expect(await detector.detectMethod(ANDROID_DEVICE.deviceId, adb)).toBe("unknown");
    expect(adb.getExecutedCommands()).toHaveLength(reads);
    detector.clearAllCache();
  });

  test("unreadable post-change confirmation omits currentState and reports unknown", async () => {
    fakeDetector.setDefaultResult(null);
    const state = spyOn(fakeDetector, "resolveState").mockResolvedValue(null);
    state.mockResolvedValueOnce({ enabled: true, service: "talkback", ctrlProxyEnabled: false });
    try {
      const result = await new TalkBackToggle(
        ANDROID_DEVICE,
        fakeAdb,
        fakeDetector,
        fakeTimer,
        fakeSecureSettings,
        fakeProbe,
      ).toggle(false);
      expect(result.applied).toBe(false);
      expect(result.currentState).toBeUndefined();
      expect(result.reason).toContain("unknown (could not determine)");
      expect(
        fakeAdb.wasCommandExecuted("settings delete secure enabled_accessibility_services"),
      ).toBe(true);
      expect(fakeTimer.getSleepHistory()).toEqual([500, 500, 500]);
    } finally {
      state.mockRestore();
    }
  });

  beforeEach(() => {
    fakeAdb = new FakeAdbExecutor();
    fakeDetector = new FakeAccessibilityDetector();
    fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
    // Default: a11y-service path unavailable, so writes fall back to ADB (the
    // path the existing assertions target). No real AdbClient enters the static
    // singleton map (issue #4179).
    fakeSecureSettings = new FakeSecureSettingsRpc();
    fakeAdb.setCommandResponse(
      "pm list packages com.google.android.marvin.talkback",
      makeExecResult(PACKAGE_LIST_WITH_TALKBACK),
    );
  });

  afterEach(() => {
    fakeAdb.clearHistory();
    fakeDetector.reset();
    fakeTimer.reset();
  });

  describe("system runtime permission prompt", () => {
    test("reports API 36 foreground prompt without dispatching any input", async () => {
      fakeAdb.setForegroundApp({
        packageName: "com.google.android.permissioncontroller",
        userId: 0,
        activityName:
          "com.google.android.permissioncontroller.permission.ui.GrantPermissionsActivity",
      });
      fakeDetector.enqueueDetectMethodResults("unknown", "talkback", "talkback");
      const foreground = spyOn(fakeAdb, "getForegroundApp");
      const warn = spyOn(logger, "warn").mockImplementation(() => {});
      try {
        const result = await new TalkBackToggle(
          ANDROID_DEVICE,
          fakeAdb,
          fakeDetector,
          fakeTimer,
          fakeSecureSettings,
          fakeProbe,
        ).toggle(true);
        expect(result).toMatchObject({
          supported: true,
          applied: true,
          currentState: true,
          blockingPrompt: {
            kind: "runtime-permission",
            package: "com.google.android.permissioncontroller",
            activity:
              "com.google.android.permissioncontroller.permission.ui.GrantPermissionsActivity",
          },
          warning: expect.stringContaining("Nothing was tapped"),
        });
        expect(result.reason).toBeUndefined();
        expect(foreground).toHaveBeenCalledTimes(1);
        expect(fakeAdb.getCommandCalls().filter((c) => c.command.includes("input"))).toEqual([]);
        expect(warn.mock.calls.some(([message]) => message.includes("dialog not found"))).toBe(
          false,
        );
      } finally {
        foreground.mockRestore();
        warn.mockRestore();
      }
    });

    test.each([
      ["normal app", { packageName: "com.example.home", userId: 0 }],
      ["null foreground", null],
    ])("no prompt for %s preserves the result", async (_name, app) => {
      fakeAdb.setForegroundApp(app);
      fakeDetector.enqueueDetectMethodResults("unknown", "talkback", "talkback");
      const debug = spyOn(logger, "debug").mockImplementation(() => {});
      try {
        const result = await new TalkBackToggle(
          ANDROID_DEVICE,
          fakeAdb,
          fakeDetector,
          fakeTimer,
          fakeSecureSettings,
          fakeProbe,
        ).toggle(true);
        expect(result).toEqual({ supported: true, applied: true, currentState: true });
        if (app === null) {
          expect(
            debug.mock.calls.some(([message]) => message.includes("Foreground app unavailable")),
          ).toBe(true);
        }
      } finally {
        debug.mockRestore();
      }
    });

    test("dismissed consent dialog is followed by one foreground read", async () => {
      fakeProbe.enqueue({ kind: "dialog", tap: { x: 360, y: 712 } }, { kind: "none" });
      fakeAdb.setForegroundApp({ packageName: "com.example.home", userId: 0 });
      fakeDetector.enqueueDetectMethodResults("unknown", "unknown", "talkback");
      const foreground = spyOn(fakeAdb, "getForegroundApp");
      try {
        const result = await new TalkBackToggle(
          ANDROID_DEVICE,
          fakeAdb,
          fakeDetector,
          fakeTimer,
          fakeSecureSettings,
          fakeProbe,
        ).toggle(true);
        expect(result).toEqual({ supported: true, applied: true, currentState: true });
        expect(foreground).toHaveBeenCalledTimes(1);
        expect(
          fakeAdb.getCommandCalls().filter((c) => c.command.startsWith("shell input")),
        ).toHaveLength(1);
      } finally {
        foreground.mockRestore();
      }
    });

    test("a runtime prompt following dismissed consent is reported", async () => {
      fakeProbe.enqueue({ kind: "dialog", tap: { x: 360, y: 712 } }, { kind: "none" });
      fakeAdb.setForegroundApp({
        packageName: "com.android.permissioncontroller",
        userId: 0,
        activityName: "com.android.permissioncontroller.permission.ui.GrantPermissionsActivity",
      });
      fakeDetector.enqueueDetectMethodResults("unknown", "unknown", "talkback");
      const result = await new TalkBackToggle(
        ANDROID_DEVICE,
        fakeAdb,
        fakeDetector,
        fakeTimer,
        fakeSecureSettings,
        fakeProbe,
      ).toggle(true);
      expect(result.applied).toBe(true);
      expect(result.blockingPrompt?.kind).toBe("runtime-permission");
      expect(
        fakeAdb.getCommandCalls().filter((c) => c.command.startsWith("shell input")),
      ).toHaveLength(1);
    });

    test("persisting consent returns before reading foreground", async () => {
      fakeProbe.setDefault({ kind: "dialog", tap: { x: 360, y: 712 } });
      // Pre-apply read, one read per dialog attempt (never enabled), then the failure read-back.
      fakeDetector.enqueueDetectMethodResults(
        "unknown",
        "unknown",
        "unknown",
        "unknown",
        "unknown",
        "talkback",
      );
      const foreground = spyOn(fakeAdb, "getForegroundApp");
      try {
        const result = await new TalkBackToggle(
          ANDROID_DEVICE,
          fakeAdb,
          fakeDetector,
          fakeTimer,
          fakeSecureSettings,
          fakeProbe,
        ).toggle(true);
        expect(result).toEqual({
          supported: true,
          applied: false,
          currentState: true,
          reason: "TalkBack permission dialog dismissal could not be confirmed",
        });
        expect(foreground).not.toHaveBeenCalled();
      } finally {
        foreground.mockRestore();
      }
    });

    test("disabling does not read or report a foreground prompt", async () => {
      fakeAdb.setForegroundApp({
        packageName: "com.google.android.permissioncontroller",
        userId: 0,
        activityName:
          "com.google.android.permissioncontroller.permission.ui.GrantPermissionsActivity",
      });
      fakeDetector.enqueueDetectMethodResults("talkback", "unknown");
      const foreground = spyOn(fakeAdb, "getForegroundApp");
      try {
        const result = await new TalkBackToggle(
          ANDROID_DEVICE,
          fakeAdb,
          fakeDetector,
          fakeTimer,
          fakeSecureSettings,
          fakeProbe,
        ).toggle(false);
        expect(result).toEqual({ supported: true, applied: true, currentState: false });
        expect(foreground).not.toHaveBeenCalled();
      } finally {
        foreground.mockRestore();
      }
    });

    test("foreground read failure is advisory and debug logged", async () => {
      fakeDetector.enqueueDetectMethodResults("unknown", "talkback", "talkback");
      const foreground = spyOn(fakeAdb, "getForegroundApp").mockRejectedValue(
        new Error("foreground unavailable"),
      );
      const debug = spyOn(logger, "debug").mockImplementation(() => {});
      try {
        const result = await new TalkBackToggle(
          ANDROID_DEVICE,
          fakeAdb,
          fakeDetector,
          fakeTimer,
          fakeSecureSettings,
          fakeProbe,
        ).toggle(true);
        expect(result).toEqual({ supported: true, applied: true, currentState: true });
        expect(foreground).toHaveBeenCalledTimes(1);
        expect(
          debug.mock.calls.some(
            ([message, detail]) =>
              message.includes("Foreground prompt read failed") &&
              detail === "foreground unavailable",
          ),
        ).toBe(true);
      } finally {
        foreground.mockRestore();
        debug.mockRestore();
      }
    });
  });

  describe("bounded state confirmation", () => {
    test.each([true, false])(
      "reports a bounded state mismatch for requested enabled=%s",
      async (enabled) => {
        const initialService = enabled ? "unknown" : "talkback";
        fakeDetector.setTalkBackEnabled(!enabled);
        fakeDetector.enqueueDetectMethodResults(initialService);
        const warn = spyOn(logger, "warn").mockImplementation(() => {});
        try {
          const result = await new TalkBackToggle(
            ANDROID_DEVICE,
            fakeAdb,
            fakeDetector,
            fakeTimer,
            fakeSecureSettings,
            fakeProbe,
          ).toggle(enabled);

          const reason = enabled
            ? "TalkBack requested enabled but observed disabled after 1500ms of confirmation waits"
            : "TalkBack requested disabled but observed enabled after 1500ms of confirmation waits";
          expect(result).toEqual({
            supported: true,
            applied: false,
            currentState: !enabled,
            reason,
          });
          expect(warn).toHaveBeenCalledWith(`[TalkBackToggle] ${reason}`);
          // One idempotency read + four confirmation reads. Enabling also reads the
          // setting on each of the four dialog attempts (three sleeps between them).
          expect(fakeDetector.getDetectionCallCount()).toBe(enabled ? 9 : 5);
          // Each settings attempt also invalidates immediately, including partial writes.
          expect(fakeDetector.getInvalidatedDevices()).toHaveLength(enabled ? 11 : 7);
          expect(fakeTimer.getSleepHistory()).toEqual(
            enabled ? [500, 500, 500, 500, 500, 500] : [500, 500, 500],
          );
        } finally {
          warn.mockRestore();
        }
      },
    );

    test.each([true, false])(
      "confirms a delayed state change for requested enabled=%s",
      async (enabled) => {
        const initialService = enabled ? "unknown" : "talkback";
        const requestedService = enabled ? "talkback" : "unknown";
        // Enabling also reads the setting on each of the four dialog attempts.
        const dialogReads = enabled
          ? [initialService, initialService, initialService, initialService]
          : [];
        fakeDetector.enqueueDetectMethodResults(
          initialService,
          ...dialogReads,
          initialService,
          requestedService,
        );
        const result = await new TalkBackToggle(
          ANDROID_DEVICE,
          fakeAdb,
          fakeDetector,
          fakeTimer,
          fakeSecureSettings,
          fakeProbe,
        ).toggle(enabled);

        expect(result).toEqual({ supported: true, applied: true, currentState: enabled });
        expect(result.reason).toBeUndefined();
        expect(fakeDetector.getDetectionCallCount()).toBe(enabled ? 7 : 3);
        // Three dialog sleeps on enable + exactly one confirmation sleep.
        expect(fakeTimer.getSleepHistory()).toEqual(enabled ? [500, 500, 500, 500] : [500]);
      },
    );

    test.each([true, false])(
      "confirms on the last bounded read for requested enabled=%s",
      async (enabled) => {
        const initialService = enabled ? "unknown" : "talkback";
        const requestedService = enabled ? "talkback" : "unknown";
        const dialogReads = enabled
          ? [initialService, initialService, initialService, initialService]
          : [];
        fakeDetector.enqueueDetectMethodResults(
          initialService,
          ...dialogReads,
          initialService,
          initialService,
          initialService,
          requestedService,
        );
        const result = await new TalkBackToggle(
          ANDROID_DEVICE,
          fakeAdb,
          fakeDetector,
          fakeTimer,
          fakeSecureSettings,
          fakeProbe,
        ).toggle(enabled);

        expect(result).toEqual({ supported: true, applied: true, currentState: enabled });
        expect(fakeDetector.getDetectionCallCount()).toBe(enabled ? 9 : 5);
        expect(fakeTimer.getSleepHistory()).toEqual(
          enabled ? [500, 500, 500, 500, 500, 500] : [500, 500, 500],
        );
      },
    );

    test.each([true, false])(
      "confirms immediately without extra sleeps for requested enabled=%s",
      async (enabled) => {
        // Enabling: the first dialog-phase read already shows TalkBack on, so the
        // dialog loop stops there without a probe or a sleep.
        fakeDetector.enqueueDetectMethodResults(
          ...(enabled
            ? (["unknown", "talkback", "talkback"] as const)
            : (["talkback", "unknown"] as const)),
        );
        const result = await new TalkBackToggle(
          ANDROID_DEVICE,
          fakeAdb,
          fakeDetector,
          fakeTimer,
          fakeSecureSettings,
          fakeProbe,
        ).toggle(enabled);

        expect(result).toEqual({ supported: true, applied: true, currentState: enabled });
        expect(fakeDetector.getDetectionCallCount()).toBe(enabled ? 3 : 2);
        expect(fakeProbe.probeCount).toBe(0);
        expect(fakeTimer.getSleepHistory()).toEqual([]);
      },
    );

    test("preserves a blocking prompt and warning when state confirmation fails", async () => {
      fakeDetector.setTalkBackEnabled(false);
      fakeAdb.setForegroundApp({
        packageName: "com.google.android.permissioncontroller",
        userId: 0,
        activityName:
          "com.google.android.permissioncontroller.permission.ui.GrantPermissionsActivity",
      });
      const result = await new TalkBackToggle(
        ANDROID_DEVICE,
        fakeAdb,
        fakeDetector,
        fakeTimer,
        fakeSecureSettings,
        fakeProbe,
      ).toggle(true);

      expect(result).toMatchObject({
        supported: true,
        applied: false,
        currentState: false,
        reason:
          "TalkBack requested enabled but observed disabled after 1500ms of confirmation waits",
        blockingPrompt: {
          kind: "runtime-permission",
          package: "com.google.android.permissioncontroller",
          activity:
            "com.google.android.permissioncontroller.permission.ui.GrantPermissionsActivity",
        },
        warning: expect.stringContaining("Nothing was tapped"),
      });
      expect(fakeAdb.wasCommandExecuted("shell input")).toBe(false);
    });
  });

  describe("enable TalkBack", () => {
    test("returns supported:true applied:true when TalkBack is installed and currently disabled", async () => {
      // Pre-apply idempotency detect: not talkback -> proceed. Post-apply
      // confirmation detect: talkback -> applied:true (#3921).
      fakeDetector.enqueueDetectMethodResults("unknown", "talkback", "talkback");

      const toggle = new TalkBackToggle(
        ANDROID_DEVICE,
        fakeAdb,
        fakeDetector,
        fakeTimer,
        fakeSecureSettings,
        fakeProbe,
      );
      const result = await toggle.toggle(true);

      expect(result.supported).toBe(true);
      expect(result.applied).toBe(true);
      expect(result.currentState).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    test("reports applied:false when TalkBack did not activate after apply (e.g. consent dialog blocked it)", async () => {
      // Idempotency detect: not talkback -> proceed. Confirmation detect: STILL
      // not talkback -> the toggle must not claim success optimistically (#3921).
      fakeDetector.enqueueDetectMethodResults("unknown", "unknown");

      const toggle = new TalkBackToggle(
        ANDROID_DEVICE,
        fakeAdb,
        fakeDetector,
        fakeTimer,
        fakeSecureSettings,
        fakeProbe,
      );
      const result = await toggle.toggle(true);

      expect(result.supported).toBe(true);
      expect(result.applied).toBe(false);
      expect(result.currentState).toBe(false);
    });

    test("runs the correct enable ADB commands", async () => {
      fakeDetector.setDefaultResult(false);

      const toggle = new TalkBackToggle(
        ANDROID_DEVICE,
        fakeAdb,
        fakeDetector,
        fakeTimer,
        fakeSecureSettings,
        fakeProbe,
      );
      await toggle.toggle(true);

      expect(
        fakeAdb.wasCommandExecuted(
          "shell settings put secure enabled_accessibility_services com.google.android.marvin.talkback/com.google.android.marvin.talkback.TalkBackService",
        ),
      ).toBe(true);
      expect(fakeAdb.wasCommandExecuted("shell settings put secure accessibility_enabled 1")).toBe(
        true,
      );
    });

    test("invalidates the detector cache after enabling", async () => {
      fakeDetector.setDefaultResult(false);

      const toggle = new TalkBackToggle(
        ANDROID_DEVICE,
        fakeAdb,
        fakeDetector,
        fakeTimer,
        fakeSecureSettings,
        fakeProbe,
      );
      await toggle.toggle(true);

      expect(fakeDetector.getInvalidatedDevices()).toContain(ANDROID_DEVICE.deviceId);
    });

    test("invalidates cache before idempotency check to avoid stale state", async () => {
      fakeDetector.setDefaultResult(false);

      const toggle = new TalkBackToggle(
        ANDROID_DEVICE,
        fakeAdb,
        fakeDetector,
        fakeTimer,
        fakeSecureSettings,
        fakeProbe,
      );
      await toggle.toggle(true);

      // Cache must have been invalidated at least once before detectMethod was called
      expect(fakeDetector.getInvalidationCountBeforeFirstDetection()).toBeGreaterThanOrEqual(1);
    });

    describe("consent dialog probing without uiautomator dumps (#10147)", () => {
      const DUMP = "shell uiautomator dump /sdcard/window_dump.xml";
      const dumps = () => fakeAdb.getCommandCalls().filter((call) => call.command === DUMP);
      const taps = () =>
        fakeAdb.getCommandCalls().filter((call) => call.command.startsWith("shell input tap"));
      const newToggle = () =>
        new TalkBackToggle(
          ANDROID_DEVICE,
          fakeAdb,
          fakeDetector,
          fakeTimer,
          fakeSecureSettings,
          fakeProbe,
        );

      test("runs no uiautomator dump when no consent dialog appears and the setting never reads enabled", async () => {
        fakeDetector.setDefaultResult(false);

        const result = await newToggle().toggle(true);

        expect(result.applied).toBe(false);
        // Before the fix this ran four `uiautomator dump`s, each of which restarts
        // CtrlProxy and the TalkBack service that was just enabled.
        expect(dumps()).toHaveLength(0);
        expect(fakeAdb.wasCommandExecuted("shell cat /sdcard/window_dump.xml")).toBe(false);
        expect(fakeProbe.probeCount).toBe(4);
        expect(taps()).toHaveLength(0);
      });

      test("stops probing as soon as the setting reads enabled", async () => {
        fakeDetector.enqueueDetectMethodResults("unknown", "unknown", "talkback", "talkback");
        fakeProbe.setDefault({ kind: "none" });

        const result = await newToggle().toggle(true);

        expect(result).toEqual({ supported: true, applied: true, currentState: true });
        // Attempt 0 found the setting still off and probed once; attempt 1 read it enabled.
        expect(fakeProbe.probeCount).toBe(1);
        expect(dumps()).toHaveLength(0);
        expect(fakeTimer.getSleepHistory()).toEqual([500]);
      });

      test("taps the consent button found through the CtrlProxy probe with no dump", async () => {
        fakeProbe.enqueue({ kind: "dialog", tap: { x: 360, y: 712 } }, { kind: "none" });
        fakeDetector.enqueueDetectMethodResults("unknown", "unknown", "talkback");

        const result = await newToggle().toggle(true);

        expect(result.applied).toBe(true);
        expect(taps().map((call) => call.command)).toEqual(["shell input tap 360 712"]);
        expect(dumps()).toHaveLength(0);
        expect(fakeProbe.probeCount).toBe(2);
      });

      test("returns a typed failure when the dialog persists through all retries", async () => {
        fakeProbe.setDefault({ kind: "dialog", tap: { x: 360, y: 712 } });
        fakeDetector.enqueueDetectMethodResults("unknown");

        const result = await newToggle().toggle(true);

        expect(result.supported).toBe(true);
        expect(result.applied).toBe(false);
        expect(result.reason).toContain(
          "TalkBack permission dialog dismissal could not be confirmed",
        );
        expect(taps()).toHaveLength(4);
        expect(dumps()).toHaveLength(0);
        expect(fakeTimer.getSleepHistory()).toEqual([500, 500, 500]);
      });

      test("reads back with the single fallback dump when CtrlProxy drops out after the tap", async () => {
        fakeProbe.enqueue({ kind: "dialog", tap: { x: 360, y: 712 } });
        fakeProbe.setDefault({ kind: "unavailable" });
        // Pre-apply, attempt 0 (off), confirmation.
        fakeDetector.enqueueDetectMethodResults("unknown", "unknown", "talkback");
        fakeAdb.setCommandResponse("shell cat /sdcard/window_dump.xml", makeExecResult(""));

        const result = await newToggle().toggle(true);

        expect(result.applied).toBe(true);
        expect(taps()).toHaveLength(1);
        expect(dumps()).toHaveLength(1);
      });

      test("falls back to one dump to a file (not /dev/tty) when CtrlProxy cannot answer", async () => {
        fakeProbe.setDefault({ kind: "unavailable" });
        fakeDetector.setDefaultResult(false);

        const result = await newToggle().toggle(true);

        expect(result.applied).toBe(false);
        // #3921: dump to a device file and read it back, never to /dev/tty. #10147:
        // and spend that dump at most once per call, however many attempts follow.
        expect(dumps()).toHaveLength(1);
        expect(
          fakeAdb
            .getCommandCalls()
            .filter((c) => c.command === "shell cat /sdcard/window_dump.xml"),
        ).toHaveLength(1);
        expect(fakeAdb.wasCommandExecuted("/dev/tty")).toBe(false);
        expect(dumps()[0]?.timeoutMs).toBe(30_000);
        expect(
          fakeAdb.getCommandCalls().find((c) => c.command === "shell cat /sdcard/window_dump.xml")
            ?.timeoutMs,
        ).toBeUndefined();
      });

      test("taps the Allow button found by the fallback dump (English)", async () => {
        fakeProbe.setDefault({ kind: "unavailable" });
        fakeAdb.setCommandResponse(
          "shell cat /sdcard/window_dump.xml",
          makeExecResult(DIALOG_XML_WITH_BUTTON1),
        );
        fakeDetector.setDefaultResult(false);

        await newToggle().toggle(true);

        // Center of [180,684][540,740] = (360, 712)
        expect(fakeAdb.wasCommandExecuted("shell input tap 360 712")).toBe(true);
        expect(dumps()).toHaveLength(1);
      });

      test("taps the Allow button on a non-English locale using resource-id (fallback dump)", async () => {
        fakeProbe.setDefault({ kind: "unavailable" });
        fakeAdb.setCommandResponse(
          "shell cat /sdcard/window_dump.xml",
          makeExecResult(DIALOG_XML_NON_ENGLISH),
        );
        fakeDetector.setDefaultResult(false);

        await newToggle().toggle(true);

        expect(fakeAdb.wasCommandExecuted("shell input tap 360 712")).toBe(true);
        expect(dumps()).toHaveLength(1);
      });

      test("confirms dismissal from the setting after the fallback dump's tap", async () => {
        fakeProbe.setDefault({ kind: "unavailable" });
        fakeAdb.setCommandResponse(
          "shell cat /sdcard/window_dump.xml",
          makeExecResult(DIALOG_XML_WITH_BUTTON1),
        );
        fakeDetector.enqueueDetectMethodResults("unknown", "unknown", "talkback", "talkback");

        const result = await newToggle().toggle(true);

        expect(result.applied).toBe(true);
        expect(taps()).toHaveLength(1);
        expect(dumps()).toHaveLength(1);
      });

      test("returns a typed failure when CtrlProxy is unavailable and the one fallback dump throws", async () => {
        fakeProbe.setDefault({ kind: "unavailable" });
        fakeAdb.setCommandError(DUMP, new Error("hierarchy dump failed"));
        fakeDetector.enqueueDetectMethodResults("unknown");

        const result = await newToggle().toggle(true);

        expect(result.supported).toBe(true);
        expect(result.applied).toBe(false);
        expect(result.reason).toContain(
          "TalkBack permission dialog dismissal could not be confirmed",
        );
        expect(dumps()).toHaveLength(1);
        expect(fakeTimer.getSleepHistory()).toEqual([500, 500, 500]);
      });

      test("does not dump when disabling", async () => {
        fakeDetector.enqueueDetectMethodResults("talkback", "unknown");

        await newToggle().toggle(false);

        expect(dumps()).toHaveLength(0);
        expect(fakeProbe.probeCount).toBe(0);
      });
    });

    test("does not tap when no permission dialog appears", async () => {
      fakeAdb.setCommandResponse(
        "shell cat /sdcard/window_dump.xml",
        makeExecResult("<hierarchy><node text='Home' /></hierarchy>"),
      );
      // Idempotency: not talkback -> proceed. Confirmation: talkback -> applied:true.
      fakeDetector.enqueueDetectMethodResults("unknown", "talkback", "talkback");

      const toggle = new TalkBackToggle(
        ANDROID_DEVICE,
        fakeAdb,
        fakeDetector,
        fakeTimer,
        fakeSecureSettings,
        fakeProbe,
      );
      const result = await toggle.toggle(true);

      expect(fakeAdb.wasCommandExecuted("shell input tap")).toBe(false);
      expect(result.applied).toBe(true);
    });

    test("does not tap button1 when it belongs to an unrelated dialog (no TalkBack context)", async () => {
      // Simulate a system dialog that happens to use android:id/button1 but has no TalkBack text
      const unrelatedDialogXml = `<?xml version="1.0" encoding="UTF-8"?>
<hierarchy><node index="0" text="" resource-id="android:id/content">
  <node index="0" text="Allow this app to access your location?" resource-id="" />
  <node index="1" text="Allow" resource-id="android:id/button1" bounds="[180,684][540,740]" />
</hierarchy>`;
      fakeAdb.setCommandResponse(
        "shell cat /sdcard/window_dump.xml",
        makeExecResult(unrelatedDialogXml),
      );
      // Idempotency: not talkback -> proceed. Confirmation: talkback -> applied:true.
      fakeDetector.enqueueDetectMethodResults("unknown", "talkback", "talkback");

      const toggle = new TalkBackToggle(
        ANDROID_DEVICE,
        fakeAdb,
        fakeDetector,
        fakeTimer,
        fakeSecureSettings,
        fakeProbe,
      );
      const result = await toggle.toggle(true);

      expect(fakeAdb.wasCommandExecuted("shell input tap")).toBe(false);
      expect(result.applied).toBe(true);
    });

    test("is idempotent when TalkBack is already enabled", async () => {
      fakeDetector.setDefaultResult(true, "talkback");

      const toggle = new TalkBackToggle(
        ANDROID_DEVICE,
        fakeAdb,
        fakeDetector,
        fakeTimer,
        fakeSecureSettings,
        fakeProbe,
      );
      const result = await toggle.toggle(true);

      expect(result.supported).toBe(true);
      expect(result.applied).toBe(false);
      expect(result.currentState).toBe(true);
      expect(fakeAdb.wasCommandExecuted("accessibility_enabled 1")).toBe(false);
      expect(result.reason).toBeUndefined();
      expect(fakeSecureSettings.putCalls).toEqual([]);
      expect(fakeAdb.getCommandCalls().map((call) => call.command)).toEqual([
        "shell pm list packages com.google.android.marvin.talkback",
      ]);
      expect(fakeDetector.getDetectionCallCount()).toBe(1);
      expect(fakeTimer.getSleepHistory()).toEqual([]);
    });

    test("enables TalkBack when another service is active but TalkBack is not", async () => {
      // Idempotency: another service active but not talkback ("unknown") -> proceed.
      // Confirmation: talkback -> applied:true (#3921).
      fakeDetector.enqueueDetectMethodResults("unknown", "talkback", "talkback");

      const toggle = new TalkBackToggle(
        ANDROID_DEVICE,
        fakeAdb,
        fakeDetector,
        fakeTimer,
        fakeSecureSettings,
        fakeProbe,
      );
      const result = await toggle.toggle(true);

      expect(result.applied).toBe(true);
      expect(fakeAdb.wasCommandExecuted("accessibility_enabled 1")).toBe(true);
    });

    test("appends TalkBack to existing services list when enabling", async () => {
      fakeAdb.setCommandResponse(
        "settings get secure enabled_accessibility_services",
        makeExecResult("com.example.other/OtherService"),
      );
      fakeDetector.setDefaultResult(false);

      const toggle = new TalkBackToggle(
        ANDROID_DEVICE,
        fakeAdb,
        fakeDetector,
        fakeTimer,
        fakeSecureSettings,
        fakeProbe,
      );
      await toggle.toggle(true);

      expect(
        fakeAdb.wasCommandExecuted(
          "shell settings put secure enabled_accessibility_services com.example.other/OtherService:com.google.android.marvin.talkback/com.google.android.marvin.talkback.TalkBackService",
        ),
      ).toBe(true);
      expect(fakeAdb.wasCommandExecuted("shell settings put secure accessibility_enabled 1")).toBe(
        true,
      );
    });
  });

  describe("disable TalkBack", () => {
    test("disables an active non-Google TalkBack service even when Google's package is absent", async () => {
      const vendorTalkBackService = "com.android.talkback/com.android.talkback.TalkBackService";
      fakeAdb.setCommandResponse(
        "pm list packages com.google.android.marvin.talkback",
        makeExecResult(""),
      );
      fakeAdb.setCommandResponse(
        "settings get secure enabled_accessibility_services",
        makeExecResult(vendorTalkBackService),
      );
      fakeDetector.enqueueDetectMethodResults("talkback", "unknown");

      const toggle = new TalkBackToggle(
        ANDROID_DEVICE,
        fakeAdb,
        fakeDetector,
        fakeTimer,
        fakeSecureSettings,
        fakeProbe,
      );
      const result = await toggle.toggle(false);

      expect(result).toEqual({ supported: true, applied: true, currentState: false });
      expect(
        fakeAdb.wasCommandExecuted("shell pm list packages com.google.android.marvin.talkback"),
      ).toBe(false);
      expect(
        fakeAdb.wasCommandExecuted("shell settings delete secure enabled_accessibility_services"),
      ).toBe(true);
    });

    test("returns supported:true applied:true when TalkBack is installed and currently enabled", async () => {
      // Idempotency: talkback (currently on) -> proceed to disable. Confirmation:
      // not talkback -> applied:true, currentState:false (#3921).
      fakeDetector.enqueueDetectMethodResults("talkback", "unknown");

      const toggle = new TalkBackToggle(
        ANDROID_DEVICE,
        fakeAdb,
        fakeDetector,
        fakeTimer,
        fakeSecureSettings,
        fakeProbe,
      );
      const result = await toggle.toggle(false);

      expect(result.supported).toBe(true);
      expect(result.applied).toBe(true);
      expect(result.currentState).toBe(false);
    });

    test("runs the correct disable ADB commands", async () => {
      fakeDetector.setDefaultResult(true, "talkback");

      const toggle = new TalkBackToggle(
        ANDROID_DEVICE,
        fakeAdb,
        fakeDetector,
        fakeTimer,
        fakeSecureSettings,
        fakeProbe,
      );
      await toggle.toggle(false);

      expect(
        fakeAdb.wasCommandExecuted("shell settings delete secure enabled_accessibility_services"),
      ).toBe(true);
      expect(fakeAdb.wasCommandExecuted("shell settings put secure accessibility_enabled 0")).toBe(
        true,
      );
    });

    test("does not attempt dialog dismissal when disabling", async () => {
      fakeDetector.setDefaultResult(true, "talkback");

      const toggle = new TalkBackToggle(
        ANDROID_DEVICE,
        fakeAdb,
        fakeDetector,
        fakeTimer,
        fakeSecureSettings,
        fakeProbe,
      );
      await toggle.toggle(false);

      expect(fakeAdb.wasCommandExecuted("shell uiautomator dump /sdcard/window_dump.xml")).toBe(
        false,
      );
    });

    test("invalidates the detector cache after disabling", async () => {
      fakeDetector.setDefaultResult(true, "talkback");

      const toggle = new TalkBackToggle(
        ANDROID_DEVICE,
        fakeAdb,
        fakeDetector,
        fakeTimer,
        fakeSecureSettings,
        fakeProbe,
      );
      await toggle.toggle(false);

      expect(fakeDetector.getInvalidatedDevices()).toContain(ANDROID_DEVICE.deviceId);
    });

    test("preserves other accessibility services when disabling TalkBack", async () => {
      fakeAdb.setCommandResponse(
        "settings get secure enabled_accessibility_services",
        makeExecResult(
          "com.google.android.marvin.talkback/com.google.android.marvin.talkback.TalkBackService:com.example.other/OtherService",
        ),
      );
      fakeDetector.setDefaultResult(true, "talkback");

      const toggle = new TalkBackToggle(
        ANDROID_DEVICE,
        fakeAdb,
        fakeDetector,
        fakeTimer,
        fakeSecureSettings,
        fakeProbe,
      );
      await toggle.toggle(false);

      expect(
        fakeAdb.wasCommandExecuted(
          "shell settings put secure enabled_accessibility_services com.example.other/OtherService",
        ),
      ).toBe(true);
      // Should NOT delete all services or disable accessibility when others remain
      expect(
        fakeAdb.wasCommandExecuted("shell settings delete secure enabled_accessibility_services"),
      ).toBe(false);
      expect(fakeAdb.wasCommandExecuted("shell settings put secure accessibility_enabled 0")).toBe(
        false,
      );
    });

    test("is idempotent when TalkBack is already disabled", async () => {
      fakeDetector.setDefaultResult(false);

      const toggle = new TalkBackToggle(
        ANDROID_DEVICE,
        fakeAdb,
        fakeDetector,
        fakeTimer,
        fakeSecureSettings,
        fakeProbe,
      );
      const result = await toggle.toggle(false);

      expect(result.supported).toBe(true);
      expect(result.applied).toBe(false);
      expect(result.currentState).toBe(false);
      expect(fakeAdb.wasCommandExecuted("accessibility_enabled 0")).toBe(false);
      expect(result.reason).toBeUndefined();
      expect(fakeSecureSettings.putCalls).toEqual([]);
      expect(fakeAdb.getCommandCalls()).toEqual([]);
      expect(fakeDetector.getDetectionCallCount()).toBe(1);
      expect(fakeTimer.getSleepHistory()).toEqual([]);
    });
  });

  describe("previous state hook (#10146)", () => {
    const newToggle = () =>
      new TalkBackToggle(
        ANDROID_DEVICE,
        fakeAdb,
        fakeDetector,
        fakeTimer,
        fakeSecureSettings,
        fakeProbe,
      );
    const writeCount = () =>
      fakeAdb.getExecutedCommands().filter((c) => c.startsWith("shell settings put")).length;

    test.each([
      [true, ["unknown", "talkback", "talkback"] as const, false],
      [false, ["talkback", "unknown"] as const, true],
    ])("enabled=%s reports the pre-change state before any write", async (enabled, queue, was) => {
      fakeDetector.enqueueDetectMethodResults(...queue);
      const seen: string[] = [];

      await newToggle().toggle(enabled, {
        beforeChange: (previous) => {
          seen.push(`previous=${previous} writes=${writeCount()}`);
        },
      });

      expect(seen).toEqual([`previous=${was} writes=0`]);
      expect(writeCount()).toBeGreaterThan(0);
    });

    test("is not called when TalkBack is already in the requested state", async () => {
      fakeDetector.setDefaultResult(true, "talkback");
      const previous: boolean[] = [];

      await newToggle().toggle(true, { beforeChange: (value) => void previous.push(value) });

      expect(previous).toEqual([]);
      expect(writeCount()).toBe(0);
    });

    test("is not called when TalkBack is not installed", async () => {
      fakeAdb.setCommandResponse("pm list packages com.google.android.marvin.talkback", {
        stdout: "",
        stderr: "",
        toString: () => "",
        trim: () => "",
        includes: () => false,
      });
      const previous: boolean[] = [];

      const result = await newToggle().toggle(true, {
        beforeChange: (value) => void previous.push(value),
      });

      expect(result.supported).toBe(false);
      expect(previous).toEqual([]);
    });

    test("a rejecting hook stops the toggle before anything is written", async () => {
      fakeDetector.enqueueDetectMethodResults("unknown");

      await expect(
        newToggle().toggle(true, {
          beforeChange: () => {
            throw new Error("session released");
          },
        }),
      ).rejects.toThrow("session released");

      expect(writeCount()).toBe(0);
    });
  });

  describe("TalkBack not installed", () => {
    test("returns supported:false when package manager contains no TalkBack entry", async () => {
      fakeAdb.setCommandResponse(
        "pm list packages com.google.android.marvin.talkback",
        makeExecResult(""),
      );

      const toggle = new TalkBackToggle(
        ANDROID_DEVICE,
        fakeAdb,
        fakeDetector,
        fakeTimer,
        fakeSecureSettings,
        fakeProbe,
      );
      const result = await toggle.toggle(true);

      expect(result.supported).toBe(false);
      expect(result.applied).toBe(false);
      expect(result.reason).toBeDefined();
    });

    test("does not run settings commands when TalkBack is not installed", async () => {
      fakeAdb.setCommandResponse(
        "pm list packages com.google.android.marvin.talkback",
        makeExecResult(""),
      );

      const toggle = new TalkBackToggle(
        ANDROID_DEVICE,
        fakeAdb,
        fakeDetector,
        fakeTimer,
        fakeSecureSettings,
        fakeProbe,
      );
      await toggle.toggle(true);

      expect(fakeAdb.wasCommandExecuted("accessibility_enabled")).toBe(false);
    });

    test("returns supported:false when package manager command throws", async () => {
      fakeAdb.setCommandError(
        "pm list packages com.google.android.marvin.talkback",
        new Error("ADB connection failed"),
      );

      const toggle = new TalkBackToggle(
        ANDROID_DEVICE,
        fakeAdb,
        fakeDetector,
        fakeTimer,
        fakeSecureSettings,
        fakeProbe,
      );
      const result = await toggle.toggle(true);

      expect(result.supported).toBe(false);
      expect(result.applied).toBe(false);
    });
  });

  describe("ADB error during apply phase", () => {
    test("returns a typed failure (not an uncaught throw) when an apply-phase ADB command fails", async () => {
      // The default PackageManager response confirms that TalkBack is installed.
      // The apply phase reads the current services list; make that command throw
      fakeAdb.setCommandError(
        "settings get secure enabled_accessibility_services",
        new Error("ADB command failed during apply"),
      );
      fakeDetector.setDefaultResult(false);

      const toggle = new TalkBackToggle(
        ANDROID_DEVICE,
        fakeAdb,
        fakeDetector,
        fakeTimer,
        fakeSecureSettings,
        fakeProbe,
      );
      // #3921: the apply failure is wrapped into a typed result, matching the
      // graceful contract of the other paths, rather than propagating raw.
      const result = await toggle.toggle(true);

      expect(result.supported).toBe(true);
      expect(result.applied).toBe(false);
      expect(result.reason).toContain("ADB command failed during apply");
    });
  });

  describe("TalkBack service component", () => {
    test("enables an installed but disabled TalkBack that is absent from dumpsys", async () => {
      fakeDetector.enqueueDetectMethodResults("unknown", "talkback", "talkback");

      const toggle = new TalkBackToggle(
        ANDROID_DEVICE,
        fakeAdb,
        fakeDetector,
        fakeTimer,
        fakeSecureSettings,
        fakeProbe,
      );
      const result = await toggle.toggle(true);

      expect(result).toEqual({ supported: true, applied: true, currentState: true });
      expect(
        fakeAdb.wasCommandExecuted("shell pm list packages com.google.android.marvin.talkback"),
      ).toBe(true);
      expect(fakeAdb.wasCommandExecuted("shell dumpsys accessibility")).toBe(false);
      expect(
        fakeAdb.wasCommandExecuted(
          "shell settings put secure enabled_accessibility_services com.google.android.marvin.talkback/com.google.android.marvin.talkback.TalkBackService",
        ),
      ).toBe(true);
    });

    test("uses the known TalkBack service component", async () => {
      fakeDetector.setDefaultResult(false);

      const toggle = new TalkBackToggle(
        ANDROID_DEVICE,
        fakeAdb,
        fakeDetector,
        fakeTimer,
        fakeSecureSettings,
        fakeProbe,
      );
      await toggle.toggle(true);

      expect(
        fakeAdb.wasCommandExecuted(
          "shell settings put secure enabled_accessibility_services com.google.android.marvin.talkback/com.google.android.marvin.talkback.TalkBackService",
        ),
      ).toBe(true);
    });
  });

  describe("secure settings seam (a11y-first / ADB fallback)", () => {
    test("writes settings through the a11y service and skips the ADB fallback when the a11y put succeeds", async () => {
      // a11y path reports success for every write, so the toggle must NOT issue
      // the `settings put` ADB fallback for the enable writes.
      fakeSecureSettings.setPutResult({ success: true });
      fakeSecureSettings.setGetResult({ success: true, found: false });
      fakeDetector.setDefaultResult(false);

      const toggle = new TalkBackToggle(
        ANDROID_DEVICE,
        fakeAdb,
        fakeDetector,
        fakeTimer,
        fakeSecureSettings,
        fakeProbe,
      );
      await toggle.toggle(true);

      // The a11y seam received the enable writes...
      expect(fakeSecureSettings.putCalls.map((c) => c.key)).toEqual(
        expect.arrayContaining(["enabled_accessibility_services", "accessibility_enabled"]),
      );
      // ...and the ADB `settings put secure` fallback was never used.
      expect(
        fakeAdb.wasCommandExecuted("shell settings put secure enabled_accessibility_services"),
      ).toBe(false);
      expect(fakeAdb.wasCommandExecuted("shell settings put secure accessibility_enabled")).toBe(
        false,
      );
    });

    test("falls back to the ADB write when the a11y put reports failure", async () => {
      // a11y path unavailable (default) → the toggle must issue the ADB fallback.
      fakeSecureSettings.setPutResult({ success: false });
      fakeDetector.setDefaultResult(false);

      const toggle = new TalkBackToggle(
        ANDROID_DEVICE,
        fakeAdb,
        fakeDetector,
        fakeTimer,
        fakeSecureSettings,
        fakeProbe,
      );
      await toggle.toggle(true);

      expect(
        fakeAdb.wasCommandExecuted(
          "shell settings put secure enabled_accessibility_services com.google.android.marvin.talkback/com.google.android.marvin.talkback.TalkBackService",
        ),
      ).toBe(true);
      expect(fakeAdb.wasCommandExecuted("shell settings put secure accessibility_enabled 1")).toBe(
        true,
      );
    });
  });

  describe("enabled_accessibility_services parsing", () => {
    // getOtherServices() reads the existing list and appends TalkBack while
    // preserving unrelated services. These rows pin the parse rules: a literal
    // "null"/empty/whitespace value contributes no other services, and duplicate
    // or padded entries are trimmed. The observable outcome is the exact
    // `enabled_accessibility_services` value written back on enable.
    const TALKBACK =
      "com.google.android.marvin.talkback/com.google.android.marvin.talkback.TalkBackService";
    const OTHER = "com.example.other/OtherService";

    test.each([
      ['literal string "null"', "null", TALKBACK],
      ["empty string", "", TALKBACK],
      ["whitespace only", "   ", TALKBACK],
      ["single other service", OTHER, `${OTHER}:${TALKBACK}`],
      ["padded entries with blanks", `  ${OTHER}  : `, `${OTHER}:${TALKBACK}`],
      ["duplicate other services", `${OTHER}:${OTHER}`, `${OTHER}:${OTHER}:${TALKBACK}`],
    ])(
      "writes the correct services list when the existing value is %s",
      async (_label, existing, expected) => {
        fakeAdb.setCommandResponse(
          "settings get secure enabled_accessibility_services",
          makeExecResult(existing),
        );
        fakeDetector.setDefaultResult(false);

        const toggle = new TalkBackToggle(
          ANDROID_DEVICE,
          fakeAdb,
          fakeDetector,
          fakeTimer,
          fakeSecureSettings,
          fakeProbe,
        );
        await toggle.toggle(true);

        expect(
          fakeAdb.wasCommandExecuted(
            `shell settings put secure enabled_accessibility_services ${expected}`,
          ),
        ).toBe(true);
      },
    );
  });
});

describe("isTalkBackRuntimePermissionPrompt", () => {
  test.each([
    [
      "com.google.android.permissioncontroller",
      "com.google.android.permissioncontroller.permission.ui.GrantPermissionsActivity",
      true,
    ],
    [
      "com.android.permissioncontroller",
      "com.android.permissioncontroller.permission.ui.GrantPermissionsActivity",
      true,
    ],
    [
      "com.google.android.permissioncontroller",
      "com.google.android.permissioncontroller.OtherActivity",
      false,
    ],
    [
      "com.google.android.permissioncontroller",
      "com.google.android.permissioncontroller.NotGrantPermissionsActivity",
      false,
    ],
    ["com.example.app", "com.example.app.GrantPermissionsActivity", false],
    ["com.android.permissioncontroller", undefined, false],
  ])("%s / %s matches: %s", (packageName, activityName, expected) => {
    expect(isTalkBackRuntimePermissionPrompt({ packageName, activityName })).toBe(expected);
  });
});
