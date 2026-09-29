import { describe, expect, test } from "bun:test";
import type { ObserveResult } from "../../../src/models";
import { waitForObservation } from "../../../src/server/observeTools";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeTimer } from "../../fakes/FakeTimer";

function observation(updatedAt: number, appId: string): ObserveResult {
  return {
    updatedAt,
    screenSize: { width: 200, height: 200 },
    systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
    activeWindow: { appId, activityName: ".Main", layoutSeqSum: 0 },
    viewHierarchy: {
      updatedAt,
      hierarchy: { node: { bounds: { left: 0, top: 0, right: 200, bottom: 200 } } },
    },
  } as ObserveResult;
}

describe("legacy waitForObservation device clock floor", () => {
  test("accepts an already matching first observation without another poll", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    timer.advanceTime(10_000);
    const screen = new FakeObserveScreen();
    screen.setObserveSequence([observation(10_000, "com.example")]);

    const outcome = await waitForObservation(
      screen,
      { activeWindow: { appId: "com.example" }, timeout: 500 },
      undefined,
      false,
      timer,
      "android",
    );

    expect(outcome.matched).toBe(true);
    expect(outcome.polls).toBe(1);
    expect(outcome.waitMs).toBe(0);
    expect(screen.getExecuteMinTimestamps()).toEqual([0]);
  });

  test("uses device-domain floors when the host clock is far ahead", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    timer.advanceTime(1_000_000);
    const screen = new FakeObserveScreen();
    screen.setObserveSequence([observation(20, "com.other"), observation(30, "com.example")]);

    const outcome = await waitForObservation(
      screen,
      { activeWindow: { appId: "com.example" }, timeout: 500 },
      undefined,
      false,
      timer,
      "android",
    );

    expect(outcome.matched).toBe(true);
    expect(screen.getExecuteMinTimestamps()).toEqual([0, 21]);
  });

  test("accepts a post-request hierarchy with the device clock 5000ms ahead", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    timer.advanceTime(10_000);
    const screen = new FakeObserveScreen();
    screen.setObserveSequence([
      observation(15_000, "com.other"),
      observation(15_001, "com.example"),
    ]);

    const outcome = await waitForObservation(
      screen,
      { activeWindow: { appId: "com.example" }, timeout: 500 },
      undefined,
      false,
      timer,
      "android",
    );

    expect(outcome.matched).toBe(true);
    expect(outcome.polls).toBe(2);
    expect(outcome.observation.viewHierarchy?.updatedAt).toBe(15_001);
    expect(screen.getExecuteMinTimestamps()).toEqual([0, 15_001]);
  });

  test("rejects a pre-request cache entry with the device clock 5000ms behind", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    timer.advanceTime(10_000);
    const screen = new FakeObserveScreen();
    screen.setObserveSequence([
      observation(5_000, "com.other"),
      observation(5_000, "com.example"),
      observation(5_001, "com.example"),
    ]);

    const outcome = await waitForObservation(
      screen,
      { activeWindow: { appId: "com.example" }, timeout: 500 },
      undefined,
      false,
      timer,
      "android",
    );

    expect(outcome.matched).toBe(true);
    expect(outcome.polls).toBe(3);
    expect(outcome.observation.viewHierarchy?.updatedAt).toBe(5_001);
    expect(screen.getExecuteMinTimestamps()).toEqual([0, 5_001, 5_001]);
  });

  test("keeps the zero-skew legacy predicate and polling cadence", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    timer.advanceTime(10_000);
    const screen = new FakeObserveScreen();
    screen.setObserveSequence([
      observation(10_000, "com.other"),
      observation(10_100, "com.example"),
    ]);

    const outcome = await waitForObservation(
      screen,
      { activeWindow: { appId: "com.example" }, timeout: 500 },
      undefined,
      false,
      timer,
      "android",
    );

    expect(outcome.matched).toBe(true);
    expect(outcome.polls).toBe(2);
    expect(outcome.waitMs).toBe(100);
    expect(screen.getExecuteMinTimestamps()).toEqual([0, 10_001]);
  });
});
