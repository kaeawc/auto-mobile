import { describe, expect, test } from "bun:test";
import { FakeTimer } from "../fakes/FakeTimer";
import {
  createSingleClaimSessionOwnershipRenewal,
  startSessionOwnershipHeartbeat,
} from "./sessionOwnershipHeartbeat";

describe("startSessionOwnershipHeartbeat", () => {
  test("does not reclaim after an applied claim response is lost and another owner takes over", async () => {
    const originalOwner = "ios-video-keeper";
    const newerOwner = "newer-owner";
    const sentClaims: boolean[] = [];
    let owner: string | undefined;
    let attempts = 0;
    const renew = createSingleClaimSessionOwnershipRenewal(async (claimLivenessOwnership) => {
      attempts++;
      sentClaims.push(claimLivenessOwnership);

      if (claimLivenessOwnership) {
        owner = originalOwner;
      } else if (!owner) {
        // This models the daemon's unowned-session proof fallback when a
        // single-shot claim request never reached the daemon.
        owner = originalOwner;
      }

      if (attempts === 1) {
        throw new Error("heartbeat response lost after daemon applied it");
      }
    });

    await expect(renew(new AbortController().signal)).rejects.toThrow("response lost");
    expect(owner).toBe(originalOwner);

    owner = newerOwner;
    await renew(new AbortController().signal);

    expect(sentClaims).toEqual([true, false]);
    expect(owner).toBe(newerOwner);
  });

  test("propagates an initial renewal failure before starting the keeper", async () => {
    const timer = new FakeTimer();
    let calls = 0;

    await expect(
      startSessionOwnershipHeartbeat({
        intervalMs: 2_000,
        timer,
        renew: async () => {
          calls++;
          throw new Error("daemon heartbeat timed out");
        },
      }),
    ).rejects.toThrow("daemon heartbeat timed out");

    expect(calls).toBe(1);
    await timer.advanceTimeAsync(10_000);
    expect(calls).toBe(1);
  });

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

  test("returns a renewal failure discovered after the last health assertion", async () => {
    const timer = new FakeTimer();
    let renewal = 0;
    const heartbeat = await startSessionOwnershipHeartbeat({
      intervalMs: 2_000,
      timer,
      renew: async () => {
        renewal++;
        if (renewal === 2) {
          throw new Error("daemon heartbeat rejected mid-recording");
        }
      },
    });

    heartbeat.assertHealthy();
    // Renewal 2 fires and rejects here, after the last assertHealthy() call a
    // caller would make before starting a long-running CLI step.
    await timer.advanceTimeAsync(2_000);

    const stopError = await heartbeat.stop();
    expect(stopError?.message).toContain("daemon heartbeat rejected mid-recording");
  });

  test("returns null from a keeper that never fails", async () => {
    const timer = new FakeTimer();
    const heartbeat = await startSessionOwnershipHeartbeat({
      intervalMs: 2_000,
      timer,
      renew: async () => {},
    });

    heartbeat.assertHealthy();
    await timer.advanceTimeAsync(2_000);

    expect(await heartbeat.stop()).toBeNull();
  });
});
