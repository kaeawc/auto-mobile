import { describe, expect, test } from "bun:test";
import { SimHidLaunchSettle } from "../../../../src/utils/ios/simHid/SimHidLaunchSettle";
import { FakeTimer } from "../../../fakes/FakeTimer";

describe("SimHidLaunchSettle", () => {
  test("waits out the rest of the settle window after a launch on that device only", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const settle = new SimHidLaunchSettle(timer, 3000);
    await settle.wait("sim-a");
    expect(timer.getSleepHistory()).toEqual([]);
    settle.noteLaunch("sim-a");
    timer.advanceTime(1000);
    expect(settle.remainingMs("sim-b")).toBe(0);
    await settle.wait("sim-a");
    expect(timer.getSleepHistory()).toEqual([2000]);
    expect(settle.remainingMs("sim-a")).toBe(0);
  });
});
