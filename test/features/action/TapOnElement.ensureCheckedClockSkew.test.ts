import { describe, expect, test } from "bun:test";
import type { Element, ObserveResult, ViewHierarchyResult } from "../../../src/models";
import type { ObserveScreenExecuteOptions } from "../../../src/features/observe/interfaces/ObserveScreen";
import { TapOnElement } from "../../../src/features/action/TapOnElement";
import { FakeAdbClient } from "../../fakes/FakeAdbClient";
import { FakeAwaitIdle } from "../../fakes/FakeAwaitIdle";
import { FakeElementSelector } from "../../fakes/FakeElementSelector";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeWindow } from "../../fakes/FakeWindow";

/**
 * #9879: the post-tap observation floor of `tapOn { ensureChecked }` must be in
 * the device clock domain (like `BaseVisualChange`'s `actionStartTime`), or a
 * device whose clock trails the host makes every post-action read stale.
 */

const HOST_NOW = 1_000_000;

const toggle = (checked: string): Element => ({
  text: "Wi-Fi",
  "resource-id": "android:id/switch_widget",
  checkable: "true",
  checked,
  clickable: "true",
  bounds: { left: 10, top: 10, right: 110, bottom: 60 },
});

/** Stamps each capture with the device clock and judges freshness like the real pipeline. */
class DeviceClockObserveScreen extends FakeObserveScreen {
  readonly floors: Array<number | undefined> = [];
  constructor(private readonly deviceNow: () => number) {
    super();
    this.setObserveResult({} as ObserveResult);
  }
  override async execute(options?: ObserveScreenExecuteOptions): Promise<ObserveResult> {
    await super.execute(options);
    this.floors.push(options?.minTimestamp);
    const updatedAt = this.deviceNow();
    const floor = options?.minTimestamp ?? 0;
    return {
      updatedAt,
      screenSize: { width: 1080, height: 1920 },
      systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
      viewHierarchy: { hierarchy: { node: [] }, updatedAt } as ViewHierarchyResult,
      freshness: { isFresh: floor === 0 || updatedAt >= floor },
    } as unknown as ObserveResult;
  }
}

async function runEnsureChecked(deviceSkewMs: number, platform: "android" | "ios" = "android") {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  timer.setCurrentTime(HOST_NOW);
  const deviceNow = () => timer.now() + deviceSkewMs;
  const adb = new FakeAdbClient();
  const selector = new FakeElementSelector(toggle("false"));
  const screen = new DeviceClockObserveScreen(deviceNow);
  const tap = new TapOnElement(
    { name: "test-device", platform, deviceId: "emulator-5554" } as any,
    adb as any,
    {
      timer,
      elementSelector: selector,
      hierarchyCapture: {
        capture: async (request: any) => ({
          captureId: "fake-capture",
          platform: platform,
          requestedFreshness: request.freshness,
          updatedAt: deviceNow(),
          receivedAt: timer.now(),
          hierarchy: { hierarchy: { node: [] }, updatedAt: deviceNow() } as ViewHierarchyResult,
          nodes: [],
        }),
      },
    },
  );
  const origDeviceNow = adb.getDeviceTimestampMs.bind(adb);
  adb.getDeviceTimestampMs = async () => {
    await origDeviceNow();
    return deviceNow();
  };
  const window = new FakeWindow();
  window.configureCachedActiveWindow(null);
  const hierarchy = { hierarchy: { node: [] }, updatedAt: deviceNow() } as ViewHierarchyResult;
  Object.assign(tap as any, {
    awaitIdle: new FakeAwaitIdle(),
    observeScreen: screen,
    window,
    strategy: {
      isAccessibilityServiceEnabled: async () => false,
      shouldRunPreTapStability: () => false,
    },
    executeAndroidTap: async () => {
      selector.setNextElement(toggle("true"));
    },
    executeiOSTap: async () => {
      selector.setNextElement(toggle("true"));
    },
    prepareSelectionCapture: async () => null,
    refreshViewHierarchy: async () => hierarchy,
    captureTerminalObservationScreenshot: async () => {},
    recordDeferredPredictionOutcome: async () => {},
    deriveTapEffectAfterPostTapObservation: async (_previous: unknown, current: ObserveResult) => ({
      effect: { screenChanged: false, basis: "viewHierarchy unchanged" },
      observation: current,
    }),
  });
  (tap as any).selectionStateTracker.finalize = async () => [];
  (adb as any).isScreenOn = async () => true;
  const result = await tap.execute({
    text: "Wi-Fi",
    action: "tap",
    ensureChecked: true,
    skipUiStability: true,
  } as any);
  return { result, screen, deviceNow };
}

describe("tapOn ensureChecked post-tap floor clock domain (#9879)", () => {
  for (const [label, skewMs] of [
    ["zero skew", 0],
    ["device 20s behind the host", -20_000],
    ["device 5s ahead of the host", 5_000],
  ] as const) {
    test(`${label}: one post-action read, no stale warning`, async () => {
      const { result, screen, deviceNow } = await runEnsureChecked(skewMs);

      expect(result.success).toBe(true);
      const postActionFloors = screen.floors.filter((floor) => (floor ?? 0) > 0);
      expect(postActionFloors).toHaveLength(1);
      expect(postActionFloors[0]!).toBeLessThanOrEqual(deviceNow());
      expect(JSON.stringify(result)).not.toContain("may be stale");
    });
  }
});
