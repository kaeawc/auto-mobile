import { describe, expect, test } from "bun:test";
import {
  STEADY_WALL_CLOCK_STEP_TOLERANCE_MS,
  SteadyWallClock,
  type Timer,
} from "../../src/utils/SystemTimer";
import { FakeTimer } from "../fakes/FakeTimer";

// #11080: the session clock advances with the monotonic clock plus measured host sleep, anchored
// on the wall clock's first reading, so wall-clock steps move neither leases nor idle windows.

function clockAt(
  wall: number,
  sleepCounting = false,
): { timer: FakeTimer; clock: SteadyWallClock } {
  const timer = new FakeTimer();
  timer.setCurrentTime(wall);
  if (sleepCounting) {
    timer.simulateSleepCountingMonotonicClock();
  }
  const clock = new SteadyWallClock(timer);
  return { timer, clock };
}

describe("SteadyWallClock", () => {
  test("starts at the wall clock and advances with it while nothing steps", () => {
    const { timer, clock } = clockAt(5_000);
    expect(clock.now()).toBe(5_000);
    timer.advanceTime(1_234);
    expect(clock.now()).toBe(timer.now());
  });

  for (const sleepCounting of [false, true]) {
    const platform = sleepCounting ? "sleep-counting clock" : "darwin clock";

    test(`ignores a backward wall step (${platform})`, () => {
      const { timer, clock } = clockAt(100_000, sleepCounting);
      clock.now();
      timer.stepWallClock(-60_000);
      timer.advanceTime(1_000);
      expect(clock.now()).toBe(101_000);
    });

    test(`counts host sleep in full, even after a backward step (${platform})`, () => {
      const { timer, clock } = clockAt(100_000, sleepCounting);
      clock.now();
      timer.stepWallClock(-60_000);
      clock.now();
      timer.simulateHostSleep(30_000);
      expect(clock.now()).toBe(130_000);
    });
  }

  test("counts a forward step as sleep where the monotonic clock pauses for sleep (darwin)", () => {
    const { timer, clock } = clockAt(100_000);
    clock.now();
    timer.stepWallClock(45_000);
    expect(clock.now()).toBe(145_000);
  });

  test("ignores a forward step where the monotonic clock runs through sleep", () => {
    const { timer, clock } = clockAt(100_000, true);
    clock.now();
    timer.stepWallClock(45_000);
    expect(clock.now()).toBe(100_000);
  });

  test("never accumulates reading jitter between the two clocks", () => {
    // Wall readings in whole ms against a fractional monotonic clock that wobbles around them.
    let mono = 0;
    let wall = 1_000_000;
    class JitteryTimer extends FakeTimer {
      override now(): number {
        return wall;
      }
      override monotonicNow(): number {
        return mono;
      }
    }
    const clock = new SteadyWallClock(new JitteryTimer());
    clock.now();
    for (let step = 1; step <= 10_000; step++) {
      mono = step + (step % 2 === 0 ? 0.4 : -0.4);
      wall = 1_000_000 + step;
      clock.now();
    }
    expect(Math.abs(clock.now() - wall)).toBeLessThanOrEqual(1);
  });

  test("a lead that dips by less than the tolerance is jitter, not a step", () => {
    const { timer, clock } = clockAt(100_000);
    clock.now();
    timer.stepWallClock(-(STEADY_WALL_CLOCK_STEP_TOLERANCE_MS - 1));
    clock.now();
    timer.stepWallClock(STEADY_WALL_CLOCK_STEP_TOLERANCE_MS - 1);
    expect(clock.now()).toBe(100_000);
  });

  test("reads the wall clock as-is from a timer with no monotonic clock", () => {
    let wall = 7_000;
    const fake = new FakeTimer();
    const timer: Timer = {
      sleep: (ms) => fake.sleep(ms),
      setTimeout: (callback, ms) => fake.setTimeout(callback, ms),
      clearTimeout: (handle) => fake.clearTimeout(handle),
      setInterval: (callback, ms) => fake.setInterval(callback, ms),
      clearInterval: (handle) => fake.clearInterval(handle),
      now: () => wall,
    };
    const clock = new SteadyWallClock(timer);
    expect(clock.now()).toBe(7_000);
    wall = 3_000;
    expect(clock.now()).toBe(3_000);
  });
});
