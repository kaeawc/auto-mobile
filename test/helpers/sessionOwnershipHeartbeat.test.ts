import { describe, expect, test } from "bun:test";
import { FakeTimer } from "../fakes/FakeTimer";
import { startSessionOwnershipHeartbeat } from "./sessionOwnershipHeartbeat";

describe("startSessionOwnershipHeartbeat", () => {
  test("renews immediately and at the configured cadence until cleanup", async () => {
    const timer = new FakeTimer();
    const calls: AbortSignal[] = [];
    const heartbeat = await startSessionOwnershipHeartbeat({
      intervalMs: 2_000,
      timer,
      renew: async (signal) => {
        calls.push(signal);
      },
    });

    expect(calls).toHaveLength(1);
    await timer.advanceTimeAsync(1_999);
    expect(calls).toHaveLength(1);
    await timer.advanceTimeAsync(1);
    expect(calls).toHaveLength(2);

    expect(await heartbeat.stop()).toBeNull();
    await timer.advanceTimeAsync(2_000);
    expect(calls).toHaveLength(2);
  });

  test("cancels an in-flight renewal during bounded cleanup", async () => {
    const timer = new FakeTimer();
    let renewal = 0;
    let inFlightSignal: AbortSignal | undefined;
    const heartbeat = await startSessionOwnershipHeartbeat({
      intervalMs: 2_000,
      timer,
      renew: async (signal) => {
        renewal++;
        if (renewal === 1) {
          return;
        }
        inFlightSignal = signal;
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
      },
    });

    await timer.advanceTimeAsync(2_000);
    expect(inFlightSignal).toBeDefined();

    expect(await heartbeat.stop()).toBeNull();
    expect(inFlightSignal!.aborted).toBe(true);
  });
});
