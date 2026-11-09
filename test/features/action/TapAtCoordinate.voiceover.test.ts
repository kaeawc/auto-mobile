import { describe, expect, test } from "bun:test";
import { TapAtCoordinate } from "../../../src/features/action/TapAtCoordinate";
import {
  indeterminateTapError,
  type CoordinateTapClient,
} from "../../../src/features/action/coordinateTapDispatch";
import type { FeatureFlagReader } from "../../../src/features/featureFlags/FeatureFlagService";
import type { BootedDevice } from "../../../src/models";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeIosVoiceOverDetector } from "../../fakes/FakeIosVoiceOverDetector";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeTimer } from "../../fakes/FakeTimer";
import { observation, setFakeTapAtWindow } from "../../helpers/tapAtCoordinate";

// #17626: tapAt has no up-front VoiceOver probe; a timeout reads the state and names the remedy.
const DEVICE = { name: "iOS test device", platform: "ios", deviceId: "ios-test" } as BootedDevice;
const TIMEOUT = "Timeout waiting for tap_result";
const flags: FeatureFlagReader = { isEnabled: () => true };

function createTapAt(dispatchError: Error | undefined, detector: FakeIosVoiceOverDetector) {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const unused: CoordinateTapClient = { requestTapCoordinates: async () => ({ success: true }) };
  const fail = async () => {
    if (dispatchError) {
      throw dispatchError;
    }
  };
  const tapAt = new TapAtCoordinate(DEVICE, new FakeAdbExecutor(), {
    timer,
    featureFlags: flags,
    androidClient: unused,
    iosClient: { ...unused, requestDoubleTapCoordinates: async () => ({ success: true }) },
    invalidateIosCache: () => {},
    dispatchIosCoordinateTap: fail,
    dispatchIosDoubleTap: fail,
    iosVoiceOverDetector: detector,
    iosVoiceOverStateClient: {
      requestVoiceOverState: async () => {
        throw new Error("the fake detector answers without a client");
      },
    },
  });
  const observeScreen = new FakeObserveScreen();
  observeScreen.setObserveResult(observation(100, 200));
  setFakeTapAtWindow(tapAt);
  tapAt.observeScreen = observeScreen;
  return tapAt;
}

describe("tapAt iOS tap timeout under VoiceOver", () => {
  test.each(["tap", "doubleTap", "longPress"] as const)(
    "%s: VoiceOver on names the remedy",
    async (action) => {
      const detector = new FakeIosVoiceOverDetector();
      detector.setVoiceOverEnabled(true);
      const tapAt = createTapAt(indeterminateTapError(TIMEOUT), detector);
      const result = await tapAt.execute({ x: 10, y: 20, action });
      expect(result.success).toBe(false);
      for (const text of [TIMEOUT, "Do not retry automatically", "voiceover:false", "observe"]) {
        expect(result.error).toContain(text);
      }
      expect(result.error).not.toContain("Duo");
      expect(detector.getCallCount()).toBe(1);
      expect(detector.isVoiceOverEnabledTimeoutMsArgs).toEqual([1000]);
    },
  );

  test("VoiceOver off leaves the timeout unchanged", async () => {
    const detector = new FakeIosVoiceOverDetector();
    detector.setVoiceOverEnabled(false);
    const result = await createTapAt(indeterminateTapError(TIMEOUT), detector).execute({
      x: 10,
      y: 20,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain(TIMEOUT);
    expect(result.error).not.toContain("voiceover:false");
    expect(detector.getCallCount()).toBe(1);
  });

  test("a probe failure keeps the original timeout", async () => {
    const detector = new FakeIosVoiceOverDetector();
    detector.isVoiceOverEnabled = async () => {
      throw new Error("runner busy");
    };
    const result = await createTapAt(indeterminateTapError(TIMEOUT), detector).execute({
      x: 10,
      y: 20,
    });
    expect(result.error).toContain(TIMEOUT);
    expect(result.error).not.toContain("voiceover:false");
  });

  test.each([
    ["a successful tap", undefined],
    ["a non-timeout failure", new Error("CtrlProxy iOS tap failed: refused")],
  ])("%s never probes VoiceOver", async (_case, error) => {
    const detector = new FakeIosVoiceOverDetector();
    detector.setVoiceOverEnabled(true);
    const result = await createTapAt(error, detector).execute({ x: 10, y: 20 });
    expect(result.success).toBe(error === undefined);
    expect(detector.getCallCount()).toBe(0);
  });
});
