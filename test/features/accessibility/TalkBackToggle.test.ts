import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { TalkBackToggle } from "../../../src/features/accessibility/TalkBackToggle";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeAccessibilityDetector } from "../../fakes/FakeAccessibilityDetector";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeSecureSettingsRpc } from "../../fakes/FakeSecureSettingsRpc";
import type { BootedDevice } from "../../../src/models";

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
  let fakeAdb: FakeAdbExecutor;
  let fakeDetector: FakeAccessibilityDetector;
  let fakeTimer: FakeTimer;
  let fakeSecureSettings: FakeSecureSettingsRpc;

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

  describe("enable TalkBack", () => {
    test("returns supported:true applied:true when TalkBack is installed and currently disabled", async () => {
      // Pre-apply idempotency detect: not talkback -> proceed. Post-apply
      // confirmation detect: talkback -> applied:true (#3921).
      fakeDetector.enqueueDetectMethodResults("unknown", "talkback");

      const toggle = new TalkBackToggle(
        ANDROID_DEVICE,
        fakeAdb,
        fakeDetector,
        fakeTimer,
        fakeSecureSettings,
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
      );
      await toggle.toggle(true);

      // Cache must have been invalidated at least once before detectMethod was called
      expect(fakeDetector.getInvalidationCountBeforeFirstDetection()).toBeGreaterThanOrEqual(1);
    });

    test("attempts dialog dismissal via a file dump (not /dev/tty) after enabling", async () => {
      fakeDetector.setDefaultResult(false);

      const toggle = new TalkBackToggle(
        ANDROID_DEVICE,
        fakeAdb,
        fakeDetector,
        fakeTimer,
        fakeSecureSettings,
      );
      await toggle.toggle(true);

      // #3921: dump to a device file and read it back, never to /dev/tty.
      expect(fakeAdb.wasCommandExecuted("shell uiautomator dump /sdcard/window_dump.xml")).toBe(
        true,
      );
      expect(fakeAdb.wasCommandExecuted("shell cat /sdcard/window_dump.xml")).toBe(true);
      expect(fakeAdb.wasCommandExecuted("/dev/tty")).toBe(false);
    });

    test("taps Allow button when permission dialog is present (English)", async () => {
      fakeAdb.setCommandResponse(
        "shell cat /sdcard/window_dump.xml",
        makeExecResult(DIALOG_XML_WITH_BUTTON1),
      );
      fakeDetector.setDefaultResult(false);

      const toggle = new TalkBackToggle(
        ANDROID_DEVICE,
        fakeAdb,
        fakeDetector,
        fakeTimer,
        fakeSecureSettings,
      );
      await toggle.toggle(true);

      // Center of [180,684][540,740] = (360, 712)
      expect(fakeAdb.wasCommandExecuted("shell input tap 360 712")).toBe(true);
    });

    test("taps Allow button on non-English locale using resource-id", async () => {
      fakeAdb.setCommandResponse(
        "shell cat /sdcard/window_dump.xml",
        makeExecResult(DIALOG_XML_NON_ENGLISH),
      );
      fakeDetector.setDefaultResult(false);

      const toggle = new TalkBackToggle(
        ANDROID_DEVICE,
        fakeAdb,
        fakeDetector,
        fakeTimer,
        fakeSecureSettings,
      );
      await toggle.toggle(true);

      // Center of [180,684][540,740] = (360, 712)
      expect(fakeAdb.wasCommandExecuted("shell input tap 360 712")).toBe(true);
    });

    test("does not tap when no permission dialog appears", async () => {
      fakeAdb.setCommandResponse(
        "shell cat /sdcard/window_dump.xml",
        makeExecResult("<hierarchy><node text='Home' /></hierarchy>"),
      );
      // Idempotency: not talkback -> proceed. Confirmation: talkback -> applied:true.
      fakeDetector.enqueueDetectMethodResults("unknown", "talkback");

      const toggle = new TalkBackToggle(
        ANDROID_DEVICE,
        fakeAdb,
        fakeDetector,
        fakeTimer,
        fakeSecureSettings,
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
      fakeDetector.enqueueDetectMethodResults("unknown", "talkback");

      const toggle = new TalkBackToggle(
        ANDROID_DEVICE,
        fakeAdb,
        fakeDetector,
        fakeTimer,
        fakeSecureSettings,
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
      );
      const result = await toggle.toggle(true);

      expect(result.supported).toBe(true);
      expect(result.applied).toBe(false);
      expect(result.currentState).toBe(true);
      expect(fakeAdb.wasCommandExecuted("accessibility_enabled 1")).toBe(false);
    });

    test("enables TalkBack when another service is active but TalkBack is not", async () => {
      // Idempotency: another service active but not talkback ("unknown") -> proceed.
      // Confirmation: talkback -> applied:true (#3921).
      fakeDetector.enqueueDetectMethodResults("unknown", "talkback");

      const toggle = new TalkBackToggle(
        ANDROID_DEVICE,
        fakeAdb,
        fakeDetector,
        fakeTimer,
        fakeSecureSettings,
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
      );
      const result = await toggle.toggle(false);

      expect(result.supported).toBe(true);
      expect(result.applied).toBe(false);
      expect(result.currentState).toBe(false);
      expect(fakeAdb.wasCommandExecuted("accessibility_enabled 0")).toBe(false);
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
      fakeDetector.enqueueDetectMethodResults("unknown", "talkback");

      const toggle = new TalkBackToggle(
        ANDROID_DEVICE,
        fakeAdb,
        fakeDetector,
        fakeTimer,
        fakeSecureSettings,
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
