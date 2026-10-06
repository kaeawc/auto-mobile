import { describe, expect, spyOn, test } from "bun:test";
import { TalkBackSwipeExecutor } from "../../../../src/features/action/swipeon/TalkBackSwipeExecutor";
import { VoiceOverSwipeExecutor } from "../../../../src/features/action/swipeon/VoiceOverSwipeExecutor";
import type {
  BoomerangConfig,
  GestureExecutor,
} from "../../../../src/features/action/swipeon/types";
import { DeviceLostError } from "../../../../src/models/DeviceLostError";
import type { BootedDevice } from "../../../../src/models";
import type { SwipeResult } from "../../../../src/models/SwipeResult";
import { NoOpPerformanceTracker } from "../../../../src/utils/PerformanceTracker";
import { FakeAccessibilityDetector } from "../../../fakes/FakeAccessibilityDetector";
import { FakeAdbClient } from "../../../fakes/FakeAdbClient";
import { FakeCtrlProxy } from "../../../fakes/FakeCtrlProxy";
import { FakeIOSCtrlProxy } from "../../../fakes/FakeIOSCtrlProxy";
import { FakeIosVoiceOverDetector } from "../../../fakes/FakeIosVoiceOverDetector";
import { FakeTimer } from "../../../fakes/FakeTimer";
import type { AdbExecutor } from "../../../../src/utils/android-cmdline-tools/interfaces/AdbExecutor";

const BOOMERANG: BoomerangConfig = { apexPauseMs: 50, returnSpeed: 1 };
const perf = new NoOpPerformanceTracker();

type SwipeScript = Array<SwipeResult | Error>;

/** Gesture fake that replays a script of per-call outcomes and records each call. */
function scriptedGesture(script: SwipeScript): { gesture: GestureExecutor; calls: number[] } {
  const calls: number[] = [];
  const gesture: GestureExecutor = {
    swipe: async (x1, y1, x2, y2, options) => {
      calls.push(calls.length);
      const next = script[calls.length - 1] ?? { success: true, x1, y1, x2, y2, duration: 0 };
      if (next instanceof Error) {
        throw next;
      }
      return { ...next, x1, y1, x2, y2, duration: options?.duration ?? 0 };
    },
  };
  return { gesture, calls };
}

const ok = (): SwipeResult => ({ success: true, x1: 0, y1: 0, x2: 0, y2: 0, duration: 0 });
const failed = (extra: Partial<SwipeResult> = {}): SwipeResult => ({
  ...ok(),
  success: false,
  error: "Swipe timed out after 5000ms",
  ...extra,
});

type Boomerang = (
  gesture: GestureExecutor,
  timer: FakeTimer,
  signal?: AbortSignal,
) => Promise<SwipeResult>;

function androidBoomerang(): Boomerang {
  const device = { platform: "android", deviceId: "emulator-5554" } as unknown as BootedDevice;
  return (gesture, timer, signal) => {
    const proxy = new FakeCtrlProxy();
    spyOn(proxy, "getAccessibilityHierarchy").mockResolvedValue({
      hierarchy: { node: { $: {} } },
    });
    const executor = new TalkBackSwipeExecutor(
      device,
      gesture,
      proxy as unknown as ConstructorParameters<typeof TalkBackSwipeExecutor>[2],
      new FakeAccessibilityDetector(),
      new FakeAdbClient() as unknown as AdbExecutor,
      timer,
    );
    return executor.executeBoomerangGesture(
      100,
      500,
      100,
      200,
      { duration: 300 },
      BOOMERANG,
      perf,
      signal,
    );
  };
}

function iosBoomerang(): Boomerang {
  const device = { platform: "ios", deviceId: "ios-sim" } as unknown as BootedDevice;
  return (gesture, timer, signal) => {
    const executor = new VoiceOverSwipeExecutor(
      device,
      gesture,
      new FakeIOSCtrlProxy() as unknown as ConstructorParameters<typeof VoiceOverSwipeExecutor>[2],
      new FakeIosVoiceOverDetector(),
      timer,
    );
    return executor.executeBoomerangGesture(
      100,
      500,
      100,
      200,
      { duration: 300 },
      BOOMERANG,
      perf,
      signal,
    );
  };
}

function autoTimer(): FakeTimer {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  return timer;
}

describe.each([
  ["TalkBackSwipeExecutor (Android)", androidBoomerang],
  ["VoiceOverSwipeExecutor (iOS)", iosBoomerang],
])("%s boomerang partial application (#9973)", (_name, makeBoomerang) => {
  test("return swipe failure says the forward swipe was delivered and is not retryable", async () => {
    const { gesture, calls } = scriptedGesture([ok(), failed()]);
    const result = await makeBoomerang()(gesture, autoTimer());

    expect(calls).toHaveLength(2);
    expect(result.success).toBe(false);
    expect(result.error).toContain("Boomerang partially applied");
    expect(result.error).toContain("forward swipe was delivered");
    expect(result.error).toContain("Swipe timed out after 5000ms");
    expect(result.error).toContain("Observe before retrying");
    expect(result.retryable).toBe(false);
    expect(result.partialApplication).toBe(true);
    expect(result).toMatchObject({ x1: 100, y1: 500, x2: 100, y2: 200, duration: 650 });
  });

  test("indeterminate return leg keeps outcomeIndeterminate and fallbackReason", async () => {
    const { gesture } = scriptedGesture([
      ok(),
      failed({
        error: "Swipe outcome is indeterminate: the request was dispatched but no result",
        outcomeIndeterminate: true,
        fallbackReason: "a11y rejected",
      }),
    ]);
    const result = await makeBoomerang()(gesture, autoTimer());

    expect(result.outcomeIndeterminate).toBe(true);
    expect(result.fallbackReason).toBe("a11y rejected");
    expect(result.error).toContain("forward swipe was delivered");
    expect(result.error).toContain("indeterminate");
    expect(result.retryable).toBe(false);
  });

  test("forward swipe failure is unchanged and sends no return swipe", async () => {
    const { gesture, calls } = scriptedGesture([failed()]);
    const timer = autoTimer();
    const result = await makeBoomerang()(gesture, timer);

    expect(calls).toHaveLength(1);
    expect(timer.getSleepHistory()).toEqual([]);
    expect(result.success).toBe(false);
    expect(result.error).toBe("Swipe timed out after 5000ms");
    expect(result.retryable).toBeUndefined();
    expect(result.partialApplication).toBeUndefined();
  });

  test("successful boomerang carries no partial-application fields", async () => {
    const { gesture, calls } = scriptedGesture([ok(), ok()]);
    const result = await makeBoomerang()(gesture, autoTimer());

    expect(calls).toHaveLength(2);
    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.retryable).toBeUndefined();
    expect(result.partialApplication).toBeUndefined();
  });

  test("a throw from the return swipe is rethrown with the delivered-forward note", async () => {
    const { gesture } = scriptedGesture([ok(), new Error("socket closed")]);
    const error = await makeBoomerang()(gesture, autoTimer()).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("socket closed");
    expect((error as Error).message).toContain("forward swipe was delivered");
  });

  test("a typed device-loss throw from the return swipe passes through unchanged", async () => {
    const lost = new DeviceLostError("emulator-5554", "gone");
    const { gesture } = scriptedGesture([ok(), lost]);
    const error = await makeBoomerang()(gesture, autoTimer()).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(error).toBe(lost);
  });

  test("abort during the apex pause sends no return swipe and names the delivered forward swipe", async () => {
    const { gesture, calls } = scriptedGesture([ok(), ok()]);
    const timer = new FakeTimer(); // manual: the pause never resolves on its own
    const controller = new AbortController();
    const pending = makeBoomerang()(gesture, timer, controller.signal);
    const outcome = pending.then(
      () => undefined,
      (caught: unknown) => caught,
    );
    // The forward swipe resolves in a microtask; let the pause start, then cancel it.
    while (timer.getSleepCallCount() === 0) {
      await Promise.resolve();
    }
    controller.abort();
    const error = await outcome;

    expect(calls).toHaveLength(1);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("Operation cancelled");
    expect((error as Error).message).toContain("forward swipe was delivered");
  });
});
