import { describe, expect, spyOn, test } from "bun:test";
import {
  sweepExpiredDisposableApps,
  type DisposableAppExpirySweeper,
} from "../../../src/daemon/sessionBroker/disposableAppSweep";
import { logger } from "../../../src/utils/logger";
import { FakeTimer } from "../../fakes/FakeTimer";

function recordingSweeper(calls: string[]): DisposableAppExpirySweeper {
  return {
    async sweepExpired(deviceId, platform, reportRemoval) {
      calls.push(`${platform}:${deviceId}`);
      reportRemoval(`${platform}.expired`);
    },
  };
}

describe("sweepExpiredDisposableApps (#14184)", () => {
  test.each(["android", "ios"] as const)(
    "sweeps a %s device by its transport id",
    async (platform) => {
      const calls: string[] = [];
      const warn = spyOn(logger, "warn").mockImplementation(() => {});
      try {
        const timer = new FakeTimer();
        const removed = await sweepExpiredDisposableApps(
          recordingSweeper(calls),
          timer,
          { platform, transportId: "SERIAL-OR-UDID" },
          { deadlineMs: timer.now() + 1000 },
        );
        expect(calls).toEqual([`${platform}:SERIAL-OR-UDID`]);
        expect(removed).toEqual([`${platform}.expired`]);
      } finally {
        warn.mockRestore();
      }
    },
  );

  test.each([
    ["a watch", { platform: "watchos", transportId: "WATCH-UDID" }],
    ["an unbooted device", { platform: "ios", transportId: null }],
  ])("skips %s", async (_label, device) => {
    const calls: string[] = [];
    const timer = new FakeTimer();
    expect(
      await sweepExpiredDisposableApps(recordingSweeper(calls), timer, device, {
        deadlineMs: timer.now() + 1000,
      }),
    ).toEqual([]);
    expect(calls).toEqual([]);
  });
});
