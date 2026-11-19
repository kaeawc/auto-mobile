import { afterEach, describe, expect, test } from "bun:test";
import { TapOnElement } from "../../../src/features/action/TapOnElement";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import { recordObservationRead } from "../../../src/features/observe/observationReadScope";
import { DEFAULT_VISION_CONFIG } from "../../../src/vision";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeIOSCtrlProxy } from "../../fakes/FakeIOSCtrlProxy";
import { FakeTapStrategy } from "../../fakes/FakeTapStrategy";
import { FakeTimer } from "../../fakes/FakeTimer";
import { spyOnIosClientInstance } from "../../helpers/iosCtrlProxyClientSpies";
import { buildObserveResult } from "../../helpers/observeFixture";
import { runBlockWithEnvelope } from "../../helpers/observedInteractionStub";

const observation = buildObserveResult({
  updatedAt: 1,
  screenSize: { width: 400, height: 800 },
  systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
  viewHierarchy: {
    updatedAt: 1,
    hierarchy: {
      node: {
        class: "UIWindow",
        bounds: { left: 0, top: 0, right: 400, bottom: 800 },
        node: [
          {
            class: "UIButton",
            text: "Settings",
            clickable: "true",
            bounds: { left: 100, top: 200, right: 200, bottom: 250 },
          },
        ],
      },
    },
  },
});

function harness(voiceOver = false) {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const strategy = FakeTapStrategy.ios();
  strategy.setAccessibilityServiceEnabled(voiceOver);
  const tap = new TapOnElement(
    { name: "iphone", platform: "ios", deviceId: "iphone" },
    new FakeAdbExecutor(),
    {
      timer,
      tapStrategy: strategy,
      visionConfig: { ...DEFAULT_VISION_CONFIG, enabled: false },
      selectionStateTracker: { prepare: async () => null, finalize: async () => [] },
    },
  );
  tap.observedInteraction = runBlockWithEnvelope(() => recordObservationRead(observation), {
    observation,
  });
  tap.refreshViewHierarchy = async () => observation.viewHierarchy!;
  tap.deriveTapEffectAfterPostTapObservation = async (_before, current) => ({
    effect: undefined,
    observation: current,
  });
  tap.prepareSelectionCapture = async () => null;
  tap.testHooks.setTerminalScreenshotCapture(async () => {});
  tap.testHooks.setDeferredPredictionRecorder(async () => {});
  tap.enforceFreshnessConsistencyWithEffect = () => {};
  return { tap, timer };
}

afterEach(() => AndroidCtrlProxyClient.resetInstances());

describe("iOS tapOn dispatchRoute", () => {
  test.each(["tap", "doubleTap", "longPress"] as const)(
    "%s reports the coordinate dispatch route",
    async (action) => {
      const { tap } = harness();
      tap.testHooks.setIosCoordinateTap(async () => ({ route: "xcuiCoordinate" }));
      const result = await tap.execute({ text: "Settings", action });
      expect(result.success).toBe(true);
      expect(result).toHaveProperty("dispatchRoute", "xcuiCoordinate");
    },
  );

  test.each(["tap", "doubleTap", "longPress"] as const)(
    "%s carries the runner route through the real coordinate dispatcher",
    async (action) => {
      const { tap, timer } = harness();
      const client = new FakeIOSCtrlProxy(timer);
      client.setTapResult({
        success: true,
        totalTimeMs: 1,
        tapDiagnostics: { route: "xcuiCoordinate" },
      });
      const instance = spyOnIosClientInstance(client);
      try {
        const result = await tap.execute({ text: "Settings", action });
        expect(result.success).toBe(true);
        expect(result).toHaveProperty("dispatchRoute", "xcuiCoordinate");
      } finally {
        instance.mockRestore();
      }
    },
  );

  test("omits the key when the coordinate dispatch has no route", async () => {
    const { tap } = harness();
    tap.testHooks.setIosCoordinateTap(async () => ({}));
    const result = await tap.execute({ text: "Settings", action: "tap" });
    expect(result.success).toBe(true);
    expect(result).not.toHaveProperty("dispatchRoute");
  });

  test.each([true, false])(
    "VoiceOver activation success=%s reports only a fallback route",
    async (success) => {
      const { tap, timer } = harness(true);
      const client = new FakeIOSCtrlProxy(timer);
      client.setVoiceOverActivateResult({ success });
      const instance = spyOnIosClientInstance(client);
      let coordinateCalls = 0;
      tap.testHooks.setIosCoordinateTap(async () => {
        coordinateCalls++;
        return { route: "xcuiCoordinate" };
      });
      try {
        const result = await tap.execute({ text: "Settings", action: "tap" });
        expect(result.success).toBe(true);
        expect(client.getVoiceOverActivateHistory()).toHaveLength(1);
        expect(coordinateCalls).toBe(success ? 0 : 1);
        if (success) {
          expect(result).not.toHaveProperty("dispatchRoute");
        } else {
          expect(result).toHaveProperty("dispatchRoute", "xcuiCoordinate");
        }
      } finally {
        instance.mockRestore();
      }
    },
  );
});
