import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { VoiceOverToggle } from "../../../src/features/accessibility/VoiceOverToggle";
import { FakeIosVoiceOverDetector } from "../../fakes/FakeIosVoiceOverDetector";
import { FakeProcessExecutor } from "../../fakes/FakeProcessExecutor";
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

  describe("physical device", () => {
    test("returns supported:false for physical device UDID", async () => {
      const toggle = new VoiceOverToggle(PHYSICAL_DEVICE, fakeDetector, fakeExec);
      const result = await toggle.toggle(true);

      expect(result.supported).toBe(false);
      expect(result.applied).toBe(false);
      expect(result.reason).toBe("VoiceOver toggle is only supported on iOS Simulator");
    });

    test("does not run any process commands for physical device", async () => {
      const toggle = new VoiceOverToggle(PHYSICAL_DEVICE, fakeDetector, fakeExec);
      await toggle.toggle(true);

      expect(fakeExec.getExecutedCommands()).toHaveLength(0);
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

      const toggle = new VoiceOverToggle(SIMULATOR_DEVICE, fakeDetector, fakeExec);
      const result = await toggle.toggle(true);

      expect(result.supported).toBe(true);
      expect(result.applied).toBe(false);
      expect(result.currentState).toBe(false);
    });

    test("runs correct xcrun simctl spawn commands when enabling", async () => {
      const udid = SIMULATOR_DEVICE.deviceId;

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
      const toggle = new VoiceOverToggle(SIMULATOR_DEVICE, fakeDetector, fakeExec);
      const result = await toggle.toggle(false);

      expect(result.supported).toBe(true);
      expect(result.applied).toBe(true);
      expect(result.currentState).toBe(false);
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
      const toggle = new VoiceOverToggle(SIMULATOR_DEVICE, fakeDetector, fakeExec);
      await toggle.toggle(true);

      expect(fakeDetector.getInvalidatedDevices()).toContain(SIMULATOR_DEVICE.deviceId);
    });

    test("does not invalidate cache for physical device (no commands run)", async () => {
      const toggle = new VoiceOverToggle(PHYSICAL_DEVICE, fakeDetector, fakeExec);
      await toggle.toggle(true);

      expect(fakeDetector.getInvalidatedDevices()).toHaveLength(0);
    });
  });
});
