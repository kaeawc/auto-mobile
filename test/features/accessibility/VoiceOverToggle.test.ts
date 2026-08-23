import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { VoiceOverToggle } from "../../../src/features/accessibility/VoiceOverToggle";
import { FakeIosVoiceOverDetector } from "../../fakes/FakeIosVoiceOverDetector";
import { FakeProcessExecutor } from "../../fakes/FakeProcessExecutor";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeIOSCtrlProxy } from "../../fakes/FakeIOSCtrlProxy";
import type { BootedDevice } from "../../../src/models";

const SIMULATOR_DEVICE: BootedDevice = {
  deviceId: "A1B2C3D4-E5F6-7890-ABCD-EF1234567890",
  name: "iPhone 15 Pro",
  platform: "ios"
};

const PHYSICAL_DEVICE: BootedDevice = {
  deviceId: "00008130-001234567890abcd",
  name: "iPhone 15 Pro",
  platform: "ios"
};

describe("VoiceOverToggle", () => {
  let fakeDetector: FakeIosVoiceOverDetector;
  let fakeExec: FakeProcessExecutor;

  beforeEach(() => {
    fakeDetector = new FakeIosVoiceOverDetector();
    fakeExec = new FakeProcessExecutor();
  });

  afterEach(() => {
    fakeDetector.reset();
  });

  describe("physical device (Settings-driven via CtrlProxy)", () => {
    let fakeClient: FakeIOSCtrlProxy;

    const makeToggle = () =>
      new VoiceOverToggle(PHYSICAL_DEVICE, fakeDetector, fakeExec, defaultPhysicalTimer(), () => fakeClient);

    const defaultPhysicalTimer = () => {
      const t = new FakeTimer();
      t.enableAutoAdvance();
      return t;
    };

    beforeEach(() => {
      fakeClient = new FakeIOSCtrlProxy();
    });

    test("enable routes to the runner and reports applied:true", async () => {
      const result = await makeToggle().toggle(true);

      expect(result.supported).toBe(true);
      expect(result.applied).toBe(true);
      expect(result.currentState).toBe(true);
      expect(result.reason).toBeUndefined();
      expect(fakeClient.getSetVoiceOverEnabledHistory()).toEqual([true]);
    });

    test("disable routes to the runner and reports applied:false state", async () => {
      const result = await makeToggle().toggle(false);

      expect(result.supported).toBe(true);
      expect(result.applied).toBe(true);
      expect(result.currentState).toBe(false);
      expect(fakeClient.getSetVoiceOverEnabledHistory()).toEqual([false]);
    });

    test("never runs simctl for a physical device (no Simulator mechanism)", async () => {
      await makeToggle().toggle(true);

      expect(fakeExec.getExecutedCommands()).toHaveLength(0);
    });

    test("invalidates the detector cache after a successful physical toggle", async () => {
      await makeToggle().toggle(true);

      expect(fakeDetector.getInvalidatedDevices()).toContain(PHYSICAL_DEVICE.deviceId);
    });

    test("surfaces a runner failure as supported:false with the reason (never silent success)", async () => {
      fakeClient.setSetVoiceOverEnabledResult({
        success: false,
        error: "VoiceOver toggle row not found",
      });

      const result = await makeToggle().toggle(true);

      expect(result.supported).toBe(false);
      expect(result.applied).toBe(false);
      expect(result.reason).toContain("VoiceOver toggle row not found");
      // A failed toggle must not falsely invalidate the cache as if state changed.
      expect(fakeDetector.getInvalidatedDevices()).not.toContain(PHYSICAL_DEVICE.deviceId);
    });
  });

  describe("enable VoiceOver on simulator", () => {
    test("returns supported:true applied:true", async () => {
      // Post-apply confirmation re-detect reports VoiceOver on (#3921).
      fakeDetector.setVoiceOverEnabled(true);

      const toggle = new VoiceOverToggle(SIMULATOR_DEVICE, fakeDetector, fakeExec);
      const result = await toggle.toggle(true);

      expect(result.supported).toBe(true);
      expect(result.applied).toBe(true);
      expect(result.currentState).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    test("reports applied:false when VoiceOver did not turn on after apply", async () => {
      // simctl write ran but the confirmation re-detect still reports off — the
      // toggle must not claim success optimistically (#3921).
      fakeDetector.setVoiceOverEnabled(false);
      const fakeTimer = new FakeTimer();
      fakeTimer.enableAutoAdvance();

      const toggle = new VoiceOverToggle(SIMULATOR_DEVICE, fakeDetector, fakeExec, fakeTimer);
      const result = await toggle.toggle(true);

      expect(result.supported).toBe(true);
      expect(result.applied).toBe(false);
      expect(result.currentState).toBe(false);
    });

    test("retries confirmation until VoiceOver becomes detectable", async () => {
      fakeDetector.enqueueVoiceOverEnabledResults(false, true);
      const fakeTimer = new FakeTimer();
      fakeTimer.enableAutoAdvance();

      const toggle = new VoiceOverToggle(SIMULATOR_DEVICE, fakeDetector, fakeExec, fakeTimer);
      const result = await toggle.toggle(true);

      expect(result).toMatchObject({ supported: true, applied: true, currentState: true });
      expect(fakeDetector.getCallCount()).toBe(2);
      expect(fakeDetector.getInvalidatedDevices()).toEqual([
        SIMULATOR_DEVICE.deviceId,
        SIMULATOR_DEVICE.deviceId
      ]);
      expect(fakeDetector.isVoiceOverEnabledTimeoutMsArgs).toEqual([10_000, 9_500]);
      expect(fakeTimer.getSleepHistory()).toEqual([500]);
    });

    test("returns the conservative result after the bounded confirmation timeout", async () => {
      fakeDetector.setVoiceOverEnabled(false);
      const fakeTimer = new FakeTimer();
      fakeTimer.enableAutoAdvance();

      const toggle = new VoiceOverToggle(SIMULATOR_DEVICE, fakeDetector, fakeExec, fakeTimer);
      const result = await toggle.toggle(true);

      expect(result).toMatchObject({ supported: true, applied: false, currentState: false });
      expect(fakeTimer.getCurrentTime()).toBe(10_000);
      expect(fakeDetector.getCallCount()).toBe(20);
      expect(fakeDetector.isVoiceOverEnabledTimeoutMsArgs.at(-1)).toBe(500);
    });

    test("runs correct xcrun simctl spawn commands when enabling", async () => {
      const udid = SIMULATOR_DEVICE.deviceId;
      fakeDetector.setVoiceOverEnabled(true);

      const toggle = new VoiceOverToggle(SIMULATOR_DEVICE, fakeDetector, fakeExec);
      await toggle.toggle(true);

      expect(
        fakeExec.wasCommandExecuted(
          `xcrun simctl spawn ${udid} defaults write com.apple.Accessibility VoiceOverTouchEnabled -bool YES`
        )
      ).toBe(true);
      expect(
        fakeExec.wasCommandExecuted(
          `xcrun simctl spawn ${udid} notifyutil -p com.apple.accessibility.VoiceOverStatusDidChange`
        )
      ).toBe(true);
      expect(
        fakeExec.wasCommandExecuted(
          `xcrun simctl spawn ${udid} launchctl kickstart -p system/com.apple.VoiceOverTouch`
        )
      ).toBe(true);
    });

    test("reports applied:false with the failure reason when the enable kickstart fails", async () => {
      // On enable, a failing `launchctl kickstart` must NOT be swallowed as an
      // already-stopped service (that swallow is disable-only). Even when the
      // error text matches the already-stopped signature, the enable path must
      // surface it as a typed failure rather than claim success.
      fakeExec.setCommandHandler("launchctl kickstart", () => {
        throw new Error("Command failed: launchctl kickstart\nexit code: 3\nstderr:\nNo process to signal.");
      });
      // Detection returns off by default; autoAdvance keeps the (mutated) confirm
      // loop from blocking on real time.
      const fakeTimer = new FakeTimer();
      fakeTimer.enableAutoAdvance();

      const toggle = new VoiceOverToggle(SIMULATOR_DEVICE, fakeDetector, fakeExec, fakeTimer);
      const result = await toggle.toggle(true);

      expect(result.supported).toBe(true);
      expect(result.applied).toBe(false);
      expect(result.reason).toContain("No process to signal.");
    });

    test("always applies even when detection would report already-enabled (CtrlProxy-safe)", async () => {
      // Simulates a CtrlProxy outage: detection always returns false regardless of reality.
      // toggle(false) must still run simctl rather than silently no-op.
      fakeDetector.setVoiceOverEnabled(false);

      const toggle = new VoiceOverToggle(SIMULATOR_DEVICE, fakeDetector, fakeExec);
      const result = await toggle.toggle(false);

      expect(result.applied).toBe(true);
      expect(fakeExec.wasCommandExecuted("VoiceOverTouchEnabled -bool NO")).toBe(true);
    });
  });

  describe("disable VoiceOver on simulator", () => {
    test("returns supported:true applied:true", async () => {
      const fakeTimer = new FakeTimer();
      fakeTimer.enableAutoAdvance();
      const toggle = new VoiceOverToggle(SIMULATOR_DEVICE, fakeDetector, fakeExec, fakeTimer);
      const result = await toggle.toggle(false);

      expect(result.supported).toBe(true);
      expect(result.applied).toBe(true);
      expect(result.currentState).toBe(false);
      expect(fakeTimer.getSleepHistory()).toEqual([]);
    });

    test("runs correct xcrun simctl spawn commands when disabling", async () => {
      const udid = SIMULATOR_DEVICE.deviceId;

      const toggle = new VoiceOverToggle(SIMULATOR_DEVICE, fakeDetector, fakeExec);
      await toggle.toggle(false);

      expect(
        fakeExec.wasCommandExecuted(
          `xcrun simctl spawn ${udid} defaults write com.apple.Accessibility VoiceOverTouchEnabled -bool NO`
        )
      ).toBe(true);
      expect(
        fakeExec.wasCommandExecuted(
          `xcrun simctl spawn ${udid} notifyutil -p com.apple.accessibility.VoiceOverStatusDidChange`
        )
      ).toBe(true);
      expect(
        fakeExec.wasCommandExecuted(
          `xcrun simctl spawn ${udid} launchctl kill SIGTERM system/com.apple.VoiceOverTouch`
        )
      ).toBe(true);
    });

    test("treats an already-stopped VoiceOver service as a successful disable", async () => {
      fakeExec.setCommandHandler("launchctl kill SIGTERM", () => {
        throw new Error("Command failed: launchctl kill SIGTERM\nexit code: 3\nstderr:\nNo process to signal.");
      });

      const toggle = new VoiceOverToggle(SIMULATOR_DEVICE, fakeDetector, fakeExec);
      const result = await toggle.toggle(false);

      expect(result.supported).toBe(true);
      expect(result.applied).toBe(true);
      expect(result.currentState).toBe(false);
    });
  });

  describe("simctl failure during apply phase", () => {
    test("returns a typed failure (not an uncaught throw) when a simctl command fails", async () => {
      fakeExec.setCommandHandler("VoiceOverTouchEnabled", () => {
        throw new Error("simctl spawn failed");
      });

      const toggle = new VoiceOverToggle(SIMULATOR_DEVICE, fakeDetector, fakeExec);
      // #3921: the simctl failure is wrapped into a typed result, matching
      // TalkBackToggle's graceful contract, rather than propagating raw.
      const result = await toggle.toggle(true);

      expect(result.supported).toBe(true);
      expect(result.applied).toBe(false);
      expect(result.reason).toContain("simctl spawn failed");
    });
  });

  describe("cache invalidation", () => {
    test("invalidates detector cache after applying", async () => {
      fakeDetector.setVoiceOverEnabled(true);
      const toggle = new VoiceOverToggle(SIMULATOR_DEVICE, fakeDetector, fakeExec);
      await toggle.toggle(true);

      expect(fakeDetector.getInvalidatedDevices()).toContain(SIMULATOR_DEVICE.deviceId);
    });

    test("invalidates cache for physical device after a Settings-driven toggle", async () => {
      const fakeClient = new FakeIOSCtrlProxy();
      const fakeTimer = new FakeTimer();
      fakeTimer.enableAutoAdvance();
      const toggle = new VoiceOverToggle(
        PHYSICAL_DEVICE,
        fakeDetector,
        fakeExec,
        fakeTimer,
        () => fakeClient,
      );
      await toggle.toggle(true);

      expect(fakeDetector.getInvalidatedDevices()).toContain(PHYSICAL_DEVICE.deviceId);
    });
  });
});
