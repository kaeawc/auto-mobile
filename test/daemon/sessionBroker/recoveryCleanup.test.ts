import { expect, spyOn, test } from "bun:test";
import { RecoveryCleanup } from "../../../src/daemon/sessionBroker/RecoveryCleanup";
import { logger } from "../../../src/utils/logger";
import { FakeTimer } from "../../fakes/FakeTimer";
import { drainUntilQuiescent } from "../../helpers/fakeTimerStepping";

test("elapsed recovery wait logs debug and keeps the native concurrency slot", async () => {
  const timer = new FakeTimer();
  const cleanup = new RecoveryCleanup(1, 5000, timer);
  const debug = spyOn(logger, "debug").mockImplementation(() => {});
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  let finish = () => {};
  let runs = 0;
  const item = {
    resourceId: "slow-reset",
    run: async () => {
      runs++;
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    },
  };
  try {
    const pass = cleanup.run([item]);
    await drainUntilQuiescent(timer);
    timer.advanceTime(5000);
    await pass;
    expect(debug).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
    await cleanup.run([item]);
    expect(runs).toBe(1);
    finish();
    await cleanup.join();
    await cleanup.run([
      {
        resourceId: "next",
        run: async () => {
          runs++;
        },
      },
    ]);
    expect(runs).toBe(2);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  } finally {
    finish();
    cleanup.stop();
    await cleanup.join();
    debug.mockRestore();
    warn.mockRestore();
  }
});

test("shutdown errors still warn", async () => {
  const timer = new FakeTimer();
  const cleanup = new RecoveryCleanup(1, 5000, timer);
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  let finish = () => {};
  try {
    const pass = cleanup.run([
      {
        resourceId: "reset",
        run: () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      },
    ]);
    await drainUntilQuiescent(timer);
    cleanup.stop();
    await pass;
    expect(warn).toHaveBeenCalledTimes(1);
  } finally {
    finish();
    await cleanup.join();
    warn.mockRestore();
  }
});
