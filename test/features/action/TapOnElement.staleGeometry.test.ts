import { afterEach, describe, expect, test } from "bun:test";
import { TapOnElement } from "../../../src/features/action/TapOnElement";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import { recordObservationRead } from "../../../src/features/observe/observationReadScope";
import type { ObserveResult } from "../../../src/models";
import { DEFAULT_VISION_CONFIG } from "../../../src/vision";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeTapStrategy } from "../../fakes/FakeTapStrategy";
import { FakeTimer } from "../../fakes/FakeTimer";
import { runBlockWithEnvelope } from "../../helpers/observedInteractionStub";
import { buildObserveResult } from "../../helpers/observeFixture";

afterEach(() => AndroidCtrlProxyClient.resetInstances());

type Frame = [number, number, number, number];

const boundsOf = ([left, top, right, bottom]: Frame) => ({ left, top, right, bottom });

function capture(
  size: { width: number; height: number },
  header: Frame,
  button: Frame,
): ObserveResult {
  return buildObserveResult({
    updatedAt: 1,
    screenSize: size,
    systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
    rotation: 0,
    viewHierarchy: {
      updatedAt: 1,
      packageName: "com.example.inbox",
      rotation: 0,
      screenWidth: size.width,
      screenHeight: size.height,
      hierarchy: {
        node: {
          bounds: boundsOf([0, 0, size.width, size.height]),
          class: "UIWindow",
          node: [
            { bounds: boundsOf(header), class: "UINavigationBar", text: "Inbox" },
            {
              bounds: boundsOf(button),
              class: "UIButton",
              text: "Compose",
              clickable: "true",
            },
          ],
        },
      },
    },
  });
}

// The captured #18245 sample: rotation 0, 669x951, elements laid out landscape up to x≈951.
const stale = capture({ width: 669, height: 951 }, [0, 0, 951, 64], [300, 300, 400, 340]);
const landscapeNative = capture({ width: 951, height: 669 }, [0, 0, 951, 64], [300, 300, 400, 340]);
const portrait = capture({ width: 669, height: 951 }, [0, 0, 669, 96], [300, 800, 400, 840]);

async function tapOn(observation: ObserveResult) {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const tap = new TapOnElement(
    { name: "iPhone Duo", platform: "ios", deviceId: "duo" },
    new FakeAdbExecutor(),
    {
      timer,
      tapStrategy: FakeTapStrategy.ios(),
      visionConfig: { ...DEFAULT_VISION_CONFIG, enabled: false },
      selectionStateTracker: { prepare: async () => null, finalize: async () => [] },
    },
  );
  const points: Array<{ x: number; y: number }> = [];
  tap.observedInteraction = runBlockWithEnvelope(() => recordObservationRead(observation), {
    observation,
  });
  tap.refreshViewHierarchy = async () => observation.viewHierarchy!;
  tap.testHooks.setIosCoordinateTap(async (_action, x, y) => {
    points.push({ x, y });
  });
  tap.deriveTapEffectAfterPostTapObservation = async (_before, current) => ({
    effect: undefined,
    observation: current,
  });
  tap.prepareSelectionCapture = async () => null;
  tap.testHooks.setTerminalScreenshotCapture(async () => {});
  tap.testHooks.setDeferredPredictionRecorder(async () => {});
  tap.enforceFreshnessConsistencyWithEffect = () => {};
  const result = await tap
    .execute({ text: "Compose", action: "tap", searchUntil: { duration: 100 } })
    .catch((error: unknown) => ({ success: false, error: String(error) }));
  return { result, points };
}

describe("tapOn stale posture geometry (#18245)", () => {
  test("refuses a portrait-reported observation laid out landscape and dispatches nothing", async () => {
    const { result, points } = await tapOn(stale);
    expect(result.success).toBe(false);
    expect(result.error).toContain(
      "Screen geometry is stale after a posture change: observe reports rotation 0 and 669x951, " +
        "but elements are laid out for 951x669. Nothing was tapped. Observe again, then retry.",
    );
    expect(points).toEqual([]);
  });

  test("taps a landscape-native app whose elements fit the reported size", async () => {
    const { result, points } = await tapOn(landscapeNative);
    expect(result.success).toBe(true);
    expect(points).toEqual([{ x: 350, y: 320 }]);
  });

  test("taps a portrait app", async () => {
    const { result, points } = await tapOn(portrait);
    expect(result.success).toBe(true);
    expect(points).toEqual([{ x: 350, y: 820 }]);
  });
});
