import { describe, expect, test } from "bun:test";
import type {
  BootedDevice,
  Element,
  ObserveResult,
  ViewHierarchyResult,
} from "../../../src/models";
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
 * device whose clock trails the host makes every post-action read stale. It is
 * derived from the single action-start device read (skew = device - host there),
 * never from a second device read after the tap: that read lands one adb round
 * trip after the tap and would reject a push stamped between the two.
 */

const HOST_NOW = 1_000_000;
const ADB_ROUND_TRIP_MS = 50;

const device: BootedDevice = {
  name: "test-device",
  platform: "android",
  deviceId: "emulator-5554",
};

const toggle = (checked: string): Element => ({
  text: "Wi-Fi",
  "resource-id": "android:id/switch_widget",
  checkable: "true",
  checked,
  clickable: "true",
  bounds: { left: 10, top: 10, right: 110, bottom: 60 },
});

/** Stamps captures with the device clock (or a fixed push stamp) and judges freshness like the real pipeline. */
class DeviceClockObserveScreen extends FakeObserveScreen {
  readonly floors: Array<number | undefined> = [];
  /** Device stamp of a hierarchy push that landed just after the tap; dropped once a floor rejects it. */
  pushStamp: number | undefined;
  constructor(private readonly deviceNow: () => number) {
    super();
    this.setObserveResult({} as ObserveResult);
  }
  override async execute(options?: ObserveScreenExecuteOptions): Promise<ObserveResult> {
    await super.execute(options);
    this.floors.push(options?.minTimestamp);
    const floor = options?.minTimestamp ?? 0;
    const updatedAt = this.pushStamp ?? this.deviceNow();
    if (updatedAt < floor) {
      // Rejected like the real freshness check: the next read is a fresh one.
      this.pushStamp = undefined;
    }
    return {
      updatedAt,
      screenSize: { width: 1080, height: 1920 },
      systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
      viewHierarchy: { hierarchy: { node: [] }, updatedAt } as ViewHierarchyResult,
      freshness: { isFresh: floor === 0 || updatedAt >= floor },
    } as unknown as ObserveResult;
  }
}

async function runEnsureChecked(
  deviceSkewMs: number,
  options: { platform?: BootedDevice["platform"]; deviceClockUnavailable?: boolean } = {},
) {
  const platform = options.platform ?? "android";
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  timer.setCurrentTime(HOST_NOW);
  const deviceNow = () => timer.now() + deviceSkewMs;
  const adb = new FakeAdbClient();
  let deviceClockReads = 0;
  adb.getDeviceTimestampMs = async () => {
    deviceClockReads++;
    // One adb round trip; an unavailable device clock falls back to host time.
    await timer.sleep(ADB_ROUND_TRIP_MS);
    return options.deviceClockUnavailable ? timer.now() : deviceNow();
  };
  adb.isScreenOn = async () => true;
  const selector = new FakeElementSelector(toggle("false"));
  const screen = new DeviceClockObserveScreen(deviceNow);
  const tap = new TapOnElement({ ...device, platform }, adb, {
    timer,
    elementSelector: selector,
    selectionStateTracker: { prepare: async () => null, finalize: async () => [] },
    hierarchyCapture: {
      capture: async (request) => ({
        captureId: "fake-capture",
        platform,
        requestedFreshness: request.freshness,
        updatedAt: deviceNow(),
        receivedAt: timer.now(),
        hierarchy: { hierarchy: { node: [] }, updatedAt: deviceNow() } as ViewHierarchyResult,
        nodes: [],
      }),
    },
  });
  const window = new FakeWindow();
  window.configureCachedActiveWindow(null);
  const hierarchy = { hierarchy: { node: [] }, updatedAt: deviceNow() } as ViewHierarchyResult;
  let hostTapTime = 0;
  let deviceTapTime = 0;
  const dispatchTap = async () => {
    hostTapTime = timer.now();
    deviceTapTime = deviceNow();
    // The accessibility push carrying the flipped toggle lands right after the tap.
    screen.pushStamp = deviceTapTime + 1;
    selector.setNextElement(toggle("true"));
  };
  Object.assign(tap, {
    awaitIdle: new FakeAwaitIdle(),
    observeScreen: screen,
    window,
    strategy: {
      isAccessibilityServiceEnabled: async () => false,
      shouldRunPreTapStability: () => false,
    },
    executeAndroidTap: dispatchTap,
    executeiOSTap: dispatchTap,
    prepareSelectionCapture: async () => null,
    refreshViewHierarchy: async () => hierarchy,
    captureTerminalObservationScreenshot: async () => {},
    recordDeferredPredictionOutcome: async () => {},
    deriveTapEffectAfterPostTapObservation: async (_previous: unknown, current: ObserveResult) => ({
      effect: { screenChanged: false, basis: "viewHierarchy unchanged" },
      observation: current,
    }),
  });
  const result = await tap.execute({
    text: "Wi-Fi",
    action: "tap",
    ensureChecked: true,
    skipUiStability: true,
  });
  const postActionFloors = screen.floors.filter((floor): floor is number => (floor ?? 0) > 0);
  return { result, postActionFloors, deviceClockReads, hostTapTime, deviceTapTime };
}

describe("tapOn ensureChecked post-tap floor clock domain (#9879)", () => {
  for (const [label, skewMs] of [
    ["zero skew", 0],
    ["device 20s behind the host", -20_000],
    ["device 5s ahead of the host", 5_000],
  ] as const) {
    test(`${label}: one post-action read, accepts the push right after the tap`, async () => {
      const { result, postActionFloors, deviceClockReads, deviceTapTime } =
        await runEnsureChecked(skewMs);

      expect(result.success).toBe(true);
      expect(postActionFloors).toHaveLength(1);
      // The floor is the tap time in the device clock, so tap + 1 is accepted.
      expect(postActionFloors[0]).toBe(deviceTapTime);
      // Only the action-start read: no device read after the tap.
      expect(deviceClockReads).toBe(1);
      expect(JSON.stringify(result)).not.toContain("may be stale");
    });
  }

  test("action-start device read unavailable: the floor is the host tap time", async () => {
    const { result, postActionFloors, deviceClockReads, hostTapTime } = await runEnsureChecked(0, {
      deviceClockUnavailable: true,
    });

    expect(result.success).toBe(true);
    expect(postActionFloors).toEqual([hostTapTime]);
    expect(deviceClockReads).toBe(1);
  });

  test("iOS shares the host clock: floor is the host tap time with no device read", async () => {
    const { result, postActionFloors, deviceClockReads, hostTapTime } = await runEnsureChecked(0, {
      platform: "ios",
    });

    expect(result.success).toBe(true);
    expect(postActionFloors).toEqual([hostTapTime]);
    expect(deviceClockReads).toBe(0);
  });
});
