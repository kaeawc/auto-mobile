import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { DragPath } from "../../../src/features/action/DragPath";
import { TapAtCoordinate } from "../../../src/features/action/TapAtCoordinate";
import { followUpDisplaySelector } from "../../../src/features/action/TargetDisplayAction";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import { assertDisplayInventoryAvailable } from "../../../src/features/observe/DisplaySelection";
import { displayTransitions } from "../../../src/features/observe/DisplayTransition";
import type { ObserveScreenExecuteOptions } from "../../../src/features/observe/interfaces/ObserveScreen";
import type { BootedDevice, ObserveResult } from "../../../src/models";
import { displayInventoryOutcome } from "../../../src/models/DeviceInfo";
import { createExecResult } from "../../../src/utils/execResult";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeCtrlProxy } from "../../fakes/FakeCtrlProxy";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeWindow } from "../../fakes/FakeWindow";

// `dumpsys display` timed out: `active` falls back to display 0, explicit selectors are refused.
const device: BootedDevice = {
  deviceId: "unreadable-follow-up-android",
  platform: "android",
  name: "Android",
  [displayInventoryOutcome]: { kind: "unreadable", reason: "dumpsys display timed out" },
};

/** Applies RealObserveScreen's unreadable-inventory guard to every read's selector. */
class GuardedObserveScreen extends FakeObserveScreen {
  readonly displays: Array<string | undefined> = [];

  override async execute(options?: ObserveScreenExecuteOptions): Promise<ObserveResult> {
    this.displays.push(options?.display);
    assertDisplayInventoryAvailable(device, options?.display);
    return super.execute(options);
  }
}

function screen(): ObserveResult {
  return {
    observationId: "observe-0",
    updatedAt: 1,
    displayRevision: 0,
    display: { key: "0", role: "unknown", posture: "unknown", generation: 1 },
    screenSize: { width: 200, height: 200 },
    rotation: 0,
    systemInsets: { left: 0, top: 0, right: 0, bottom: 0 },
    viewHierarchy: {
      hierarchy: { node: { bounds: { left: 0, top: 0, right: 200, bottom: 200 } } },
      displayId: 0,
      screenWidth: 200,
      screenHeight: 200,
    },
  } satisfies ObserveResult;
}

function adb(): FakeAdbExecutor {
  const executor = new FakeAdbExecutor();
  executor.setCommandResponse(
    "cmd display get-displays",
    createExecResult(
      'Display id 0: DisplayInfo{uniqueId "local:0" type INTERNAL, real 200 x 200}',
      "",
    ),
  );
  return executor;
}

function autoTimer(): FakeTimer {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  return timer;
}

const rendered = () => ({ display: { key: "0", generation: 1 } });

let spies: Array<ReturnType<typeof spyOn>> = [];
beforeEach(() => {
  displayTransitions.reset(device.deviceId);
  const proxy = new FakeCtrlProxy();
  const existing = AndroidCtrlProxyClient.createForTesting(device, new FakeAdbExecutor());
  existing.invalidateCache = (...args) => proxy.invalidateCache(...args);
  spies = [
    spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue(proxy),
    spyOn(AndroidCtrlProxyClient, "getExistingInstance").mockReturnValue(existing),
  ];
});
afterEach(() => {
  for (const spy of spies) {
    spy.mockRestore();
  }
  spies = [];
  displayTransitions.reset(device.deviceId);
});

describe("followUpDisplaySelector (#16741)", () => {
  test("active on an unreadable inventory stays active", () => {
    expect(followUpDisplaySelector(device, "active", "0")).toBe("active");
  });

  test("an explicit selector on an unreadable inventory pins its key", () => {
    expect(followUpDisplaySelector(device, "0", "0")).toBe("0");
  });

  test("active on a readable inventory pins the resolved panel", () => {
    const readable = { [displayInventoryOutcome]: { kind: "multi" as const } };
    expect(followUpDisplaySelector(readable, "active", "inner")).toBe("inner");
    expect(followUpDisplaySelector({}, "active", "0")).toBe("0");
  });
});

describe("display-targeted gestures on an unreadable inventory (#16741)", () => {
  test("tapAt active keeps its post-action observation", async () => {
    const observe = new GuardedObserveScreen();
    observe.setObserveResult(screen());
    const action = new TapAtCoordinate(device, adb(), {
      timer: autoTimer(),
      lastRenderedObservation: rendered,
    });
    action.observeScreen = observe;
    const result = await action.execute({ x: 50, y: 60, display: "active" });
    expect(result).toMatchObject({ success: true });
    expect(result.observation).toBeDefined();
    expect(observe.displays.length).toBeGreaterThanOrEqual(2);
    expect(observe.displays.every((display) => display === "active")).toBe(true);
  });

  test("dragPath active keeps its post-action observation", async () => {
    const observe = new GuardedObserveScreen();
    observe.setObserveResult(screen());
    const ok = async () => ({ success: true, totalTimeMs: 0 });
    const action = new DragPath(device, adb(), {
      timer: autoTimer(),
      lastRenderedObservation: rendered,
      androidClient: { requestGestureStart: ok, requestGestureMove: ok, requestGestureEnd: ok },
    });
    action.window = new FakeWindow();
    action.observeScreen = observe;
    const result = await action.execute({
      points: [
        { x: 10, y: 10 },
        { x: 100, y: 100 },
      ],
      display: "active",
    });
    expect(result).toMatchObject({ success: true });
    expect(observe.displays.every((display) => display === "active")).toBe(true);
  });
});
