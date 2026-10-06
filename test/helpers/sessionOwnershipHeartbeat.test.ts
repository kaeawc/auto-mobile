import { describe, expect, test } from "bun:test";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";
import {
  createSingleClaimSessionOwnershipRenewal,
  createReclaimingSessionOwnershipRenewal,
  isLivenessOwnerConflict,
  isLivenessOwnerSuperseded,
  startSessionOwnershipHeartbeat,
} from "./sessionOwnershipHeartbeat";

describe("startSessionOwnershipHeartbeat", () => {
  test("reclaims a displaced keeper with a fresh token in the same tick", async () => {
    const timer = new FakeTimer();
    const idGenerator = new FakeIdGenerator(["keeper-first", "keeper-fresh"]);
    const claims = new Set<string>();
    const calls: Array<{ token: string; claim: boolean; signal: AbortSignal }> = [];
    let owner: string | undefined;
    const heartbeat = await startSessionOwnershipHeartbeat({
      intervalMs: 2_000,
      timer,
      renew: createReclaimingSessionOwnershipRenewal(async (token, claim, signal) => {
        calls.push({ token, claim, signal });
        if (claim) {
          // Like the daemon, a previously seen token's claim succeeds without
          // displacing the current owner. Only a fresh token takes ownership.
          if (!claims.has(token)) {
            claims.add(token);
            owner = token;
          }
        } else if (owner !== token) {
          throw Object.assign(new Error("keeper displaced by one-shot CLI"), {
            code: "liveness_owner_superseded",
          });
        }
      }, idGenerator),
    });

    owner = "one-shot-cli";
    claims.add(owner);
    await timer.advanceTimeAsync(2_000);

    expect(calls.map(({ token, claim }) => ({ token, claim }))).toEqual([
      { token: "keeper-first", claim: true },
      { token: "keeper-first", claim: false },
      { token: "keeper-fresh", claim: true },
    ]);
    expect(calls[2]!.token).not.toBe(calls[0]!.token);
    expect(calls[2]!.signal).toBe(calls[1]!.signal);
    expect(owner).toBe("keeper-fresh");
    expect(() => heartbeat.assertHealthy()).not.toThrow();

    await timer.advanceTimeAsync(2_000);
    expect(calls.map(({ token, claim }) => ({ token, claim }))).toEqual([
      { token: "keeper-first", claim: true },
      { token: "keeper-first", claim: false },
      { token: "keeper-fresh", claim: true },
      { token: "keeper-fresh", claim: false },
    ]);
    expect(() => heartbeat.assertHealthy()).not.toThrow();
    expect(await heartbeat.stop()).toBeNull();
  });

  test.each([
    Object.assign(new Error("Session not found: lost-session"), {
      code: "daemon_session_not_found",
    }),
    new Error("daemon heartbeat timed out"),
  ])("fails without reclaiming on %s", async (error) => {
    const timer = new FakeTimer();
    const idGenerator = new FakeIdGenerator(["keeper-first", "unused-fresh-token"]);
    const calls: boolean[] = [];
    const heartbeat = await startSessionOwnershipHeartbeat({
      intervalMs: 2_000,
      timer,
      renew: createReclaimingSessionOwnershipRenewal(async (_token, claim) => {
        calls.push(claim);
        if (!claim) {
          throw error;
        }
      }, idGenerator),
    });

    await timer.advanceTimeAsync(2_000);
    expect(calls).toEqual([true, false]);
    expect(idGenerator.pendingCount()).toBe(1);
    expect(() => heartbeat.assertHealthy()).toThrow("session ownership heartbeat failed");
    expect(await heartbeat.stop()).toBe(error);
  });

  test("propagates a failed re-claim without another re-claim in the tick", async () => {
    const timer = new FakeTimer();
    const idGenerator = new FakeIdGenerator(["keeper-first", "keeper-fresh", "unused-token"]);
    const error = Object.assign(new Error("re-claim rejected"), {
      code: "liveness_owner_superseded",
    });
    const calls: Array<{ token: string; claim: boolean }> = [];
    const heartbeat = await startSessionOwnershipHeartbeat({
      intervalMs: 2_000,
      timer,
      renew: createReclaimingSessionOwnershipRenewal(async (token, claim) => {
        calls.push({ token, claim });
        if (calls.length > 1) {
          throw error;
        }
      }, idGenerator),
    });

    await timer.advanceTimeAsync(2_000);
    expect(calls).toEqual([
      { token: "keeper-first", claim: true },
      { token: "keeper-first", claim: false },
      { token: "keeper-fresh", claim: true },
    ]);
    expect(idGenerator.pendingCount()).toBe(1);
    expect(() => heartbeat.assertHealthy()).toThrow("session ownership heartbeat failed");
    expect(await heartbeat.stop()).toBe(error);
  });

  test("skips a tick whose re-claim hits a live CLI owner and re-claims on the next tick", async () => {
    const timer = new FakeTimer();
    const idGenerator = new FakeIdGenerator(["keeper-first", "keeper-second", "keeper-third"]);
    const calls: Array<{ token: string; claim: boolean }> = [];
    let cliHoldsLiveLease = false;
    let owner = "";
    const heartbeat = await startSessionOwnershipHeartbeat({
      intervalMs: 2_000,
      timer,
      renew: createReclaimingSessionOwnershipRenewal(async (token, claim) => {
        calls.push({ token, claim });
        if (claim && cliHoldsLiveLease && owner !== token) {
          throw Object.assign(new Error("owner holds a live lease"), {
            code: "liveness_owner_conflict",
          });
        }
        if (claim) {
          owner = token;
        } else if (owner !== token) {
          throw Object.assign(new Error("displaced"), { code: "liveness_owner_superseded" });
        }
      }, idGenerator),
    });

    owner = "one-shot-cli";
    cliHoldsLiveLease = true;
    await timer.advanceTimeAsync(2_000);
    expect(() => heartbeat.assertHealthy()).not.toThrow();
    expect(owner).toBe("one-shot-cli");

    cliHoldsLiveLease = false;
    await timer.advanceTimeAsync(2_000);
    expect(() => heartbeat.assertHealthy()).not.toThrow();
    expect(owner).toBe("keeper-third");
    expect(await heartbeat.stop()).toBeNull();
  });

  test("recognizes conflict only by its structured code", () => {
    expect(isLivenessOwnerConflict(new Error("liveness_owner_conflict"))).toBe(false);
    expect(isLivenessOwnerConflict({ code: "liveness_owner_superseded" })).toBe(false);
    expect(isLivenessOwnerConflict({ code: "liveness_owner_conflict" })).toBe(true);
  });

  test("recognizes supersession only by its structured code", () => {
    expect(isLivenessOwnerSuperseded(null)).toBe(false);
    expect(isLivenessOwnerSuperseded("liveness_owner_superseded")).toBe(false);
    expect(isLivenessOwnerSuperseded(new Error("liveness_owner_superseded"))).toBe(false);
    expect(isLivenessOwnerSuperseded({ code: "daemon_session_not_found" })).toBe(false);
    expect(isLivenessOwnerSuperseded({ code: "liveness_owner_superseded" })).toBe(true);
  });

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
