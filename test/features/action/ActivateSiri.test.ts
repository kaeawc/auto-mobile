import { beforeEach, describe, expect, test } from "bun:test";
import { ActivateSiri, SIRI_PHRASE_MAX_LENGTH } from "../../../src/features/action/ActivateSiri";
import type { BootedDevice, ObserveResult } from "../../../src/models";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeAwaitIdle } from "../../fakes/FakeAwaitIdle";
import { FakeIOSCtrlProxy } from "../../fakes/FakeIOSCtrlProxy";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeWindow } from "../../fakes/FakeWindow";

const SIMULATOR: BootedDevice = {
  name: "iPhone 17",
  platform: "ios",
  deviceId: "A1B2C3D4-E5F6-7890-ABCD-EF1234567890",
};
const ANDROID: BootedDevice = { name: "Pixel", platform: "android", deviceId: "emulator-5554" };

const observation = (): ObserveResult => ({
  display: { key: "default", role: "unknown", posture: "unknown", generation: 0 },
  observationId: "siri-observation",
  updatedAt: 1_700_000_000_000,
  screenSize: { width: 393, height: 852 },
  systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
  viewHierarchy: { hierarchy: {} },
});

describe("ActivateSiri (#14109)", () => {
  let runner: FakeIOSCtrlProxy;
  let observeScreen: FakeObserveScreen;
  let timer: FakeTimer;

  const siri = (device: BootedDevice) =>
    new ActivateSiri(device, new FakeAdbExecutor(), timer, {
      observeScreen,
      awaitIdle: new FakeAwaitIdle(),
      window: new FakeWindow(),
      iosClientProvider: () => runner,
    });

  beforeEach(() => {
    runner = new FakeIOSCtrlProxy();
    observeScreen = new FakeObserveScreen();
    observeScreen.setObserveResult(observation());
    timer = new FakeTimer();
    timer.enableAutoAdvance();
  });

  test("sends the trimmed phrase to the runner and returns the observation", async () => {
    const result = await siri(SIMULATOR).execute("  Show my orders in Playground ");
    expect(result.success).toBe(true);
    expect(result.phrase).toBe("Show my orders in Playground");
    expect(result.unsupported).toBeUndefined();
    expect(runner.siriHistory).toEqual(["Show my orders in Playground"]);
    expect(result.observation?.observationId).toBe("siri-observation");
  });

  test("Android is unsupported and never reaches a runner", async () => {
    const result = await siri(ANDROID).execute("Start a workout");
    expect(result).toMatchObject({ success: false, unsupported: true });
    expect(result.error).toContain("iOS only");
    expect(runner.siriHistory).toEqual([]);
  });

  test("an old runner without request_siri reports unsupported", async () => {
    runner.siriResult = { success: false, unsupported: true, totalTimeMs: 0, error: "unknown" };
    const result = await siri(SIMULATOR).execute("Start a workout");
    expect(result).toMatchObject({ success: false, unsupported: true });
    expect(result.error).toContain("update the AutoMobile runner");
  });

  test("a runner failure is a failed result, not unsupported", async () => {
    runner.siriResult = { success: false, totalTimeMs: 3, error: "Siri unavailable" };
    const result = await siri(SIMULATOR).execute("Start a workout");
    expect(result.success).toBe(false);
    expect(result.unsupported).toBeUndefined();
    expect(result.error).toContain("Siri unavailable");
  });

  test("a thrown runner error is a failed result", async () => {
    runner.setFailureMode("requestSiri", new Error("runner disconnected"));
    const result = await siri(SIMULATOR).execute("Start a workout");
    expect(result.success).toBe(false);
    expect(result.error).toContain("runner disconnected");
  });

  test.each(["   ", "x".repeat(SIRI_PHRASE_MAX_LENGTH + 1)])(
    "rejects a blank or oversized phrase before the runner",
    async (phrase) => {
      const result = await siri(SIMULATOR).execute(phrase);
      expect(result.success).toBe(false);
      expect(result.error).toContain("siri phrase");
      expect(runner.siriHistory).toEqual([]);
    },
  );
});
