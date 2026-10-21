import { isolatedTapStrategy } from "../../helpers/observedInteractionStub";
import { buildObserveResult } from "../../helpers/observeFixture";
import { describe, expect, test } from "bun:test";
import type {
  BootedDevice,
  Element,
  ObserveResult,
  ViewHierarchyResult,
} from "../../../src/models";
import type { ObserveScreenExecuteOptions } from "../../../src/features/observe/interfaces/ObserveScreen";
import { TapOnElement } from "../../../src/features/action/TapOnElement";
import { runWithToolDispatchReporter } from "../../../src/utils/ToolDispatchContext";
import { FakeAdbClient } from "../../fakes/FakeAdbClient";
import { FakeAwaitIdle } from "../../fakes/FakeAwaitIdle";
import { FakeElementSelector } from "../../fakes/FakeElementSelector";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeWindow } from "../../fakes/FakeWindow";

/**
 * #10196: tapOn reports the moment its gesture goes out to the tool call running it, so the
 * navigation graph measures its correlation window from the dispatch rather than from the
 * start of a call that may have waited seconds for its target.
 */

const START = 1_000_000;
const WAIT_FOR_TARGET_MS = 3000;

const device: BootedDevice = {
  name: "test-device",
  platform: "android",
  deviceId: "emulator-5554",
};

const button: Element = {
  text: "Continue",
  clickable: "true",
  bounds: { left: 10, top: 10, right: 110, bottom: 60 },
};

class StaticObserveScreen extends FakeObserveScreen {
  constructor(private readonly now: () => number) {
    super();
    this.setObserveResult(
      buildObserveResult({
        updatedAt: 0,
        screenSize: { width: 1080, height: 1920 },
        systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
      }),
    );
  }
  override async execute(options?: ObserveScreenExecuteOptions): Promise<ObserveResult> {
    await super.execute(options);
    const updatedAt = this.now();
    return buildObserveResult({
      updatedAt,
      screenSize: { width: 1080, height: 1920 },
      systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
      viewHierarchy: { hierarchy: { node: [] }, updatedAt } as ViewHierarchyResult,
      freshness: { isFresh: true },
    });
  }
}

async function runTap() {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  timer.setCurrentTime(START);
  const adb = new FakeAdbClient();
  adb.getDeviceTimestampMs = async () => timer.now();
  adb.isScreenOn = async () => true;
  const selector = new FakeElementSelector(button);
  const window = new FakeWindow();
  window.configureCachedActiveWindow(null);
  const tap = new TapOnElement(device, adb, {
    timer,
    awaitIdle: new FakeAwaitIdle(),
    observeScreen: new StaticObserveScreen(() => timer.now()),
    window,
    tapStrategy: isolatedTapStrategy(),
    elementSelector: selector,
    selectionStateTracker: { prepare: async () => null, finalize: async () => [] },
    hierarchyCapture: {
      capture: async (request) => ({
        captureId: "fake-capture",
        platform: "android",
        requestedFreshness: request.freshness,
        updatedAt: timer.now(),
        receivedAt: timer.now(),
        hierarchy: { hierarchy: { node: [] }, updatedAt: timer.now() } as ViewHierarchyResult,
        nodes: [],
      }),
    },
  });
  const hierarchy = { hierarchy: { node: [] }, updatedAt: timer.now() } as ViewHierarchyResult;
  const reports: number[] = [];
  const taps: Array<{ reportsBefore: number; at: number }> = [];
  tap.executeAndroidTap = async () => {
    taps.push({ reportsBefore: reports.length, at: timer.now() });
  };
  // The last step before the gesture: all waiting for the target is done here.
  tap.prepareSelectionCapture = async () => {
    timer.advanceTime(WAIT_FOR_TARGET_MS);
    return null;
  };
  tap.refreshViewHierarchy = async () => hierarchy;
  tap.testHooks.setTerminalScreenshotCapture(async () => {});
  tap.testHooks.setDeferredPredictionRecorder(async () => {});
  tap.deriveTapEffectAfterPostTapObservation = async (_previous, current) => ({
    effect: { screenChanged: false, basis: "viewHierarchy unchanged" },
    observation: current,
  });
  const tapOptions = { text: "Continue", action: "tap" as const, skipUiStability: true };
  const result = await runWithToolDispatchReporter(
    () => reports.push(timer.now()),
    () => tap.execute(tapOptions),
  );
  return { result, reports, taps };
}

describe("tapOn reports its dispatch to the running tool call (#10196)", () => {
  test("reports once, after waiting for the target and before the gesture goes out", async () => {
    const { result, reports, taps } = await runTap();

    expect(result.success).toBe(true);
    expect(taps).toHaveLength(1);
    expect(reports).toHaveLength(1);
    // Reported before the tap was sent, and after the wait for the target.
    expect(taps[0].reportsBefore).toBe(1);
    expect(reports[0]).toBeGreaterThanOrEqual(START + WAIT_FOR_TARGET_MS);
    expect(reports[0]).toBe(taps[0].at);
  });
});
