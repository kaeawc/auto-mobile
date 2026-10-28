import { describe, expect, test } from "bun:test";
import { BrokerSessions, type BrokerSessionsPort } from "../../../src/daemon/proxy/BrokerSessions";
import type { DaemonClientLike } from "../../../src/daemon/client/client";
import type { SessionConfig } from "../../../src/devices/sessionConfig";
import type { SessionBrokerResult } from "../../../src/devices/sessionBrokerResult";
import { SESSION_OWNERSHIP_LOST_CODE } from "../../../src/daemon/sessionReleasedDuringCall";
import { daemonResponseError } from "../../../src/daemon/client/clientResponseDecoding";
import { BROKER_EXECUTION_RELEASE_TIMEOUT_MS } from "../../../src/daemon/sessionBroker/provisioning/executionLiveness";
import { FakeDaemonClient } from "../../fakes/FakeDaemonClient";
import { FakeTimer } from "../../fakes/FakeTimer";

const config: SessionConfig = {
  contractVersion: 1,
  requestId: "request-1",
  device: {
    schemaVersion: 1,
    platform: "android",
    hardware: { kind: "archetype", archetype: "phone" },
    os: { kind: "major", major: 35 },
  },
  preparationTimeoutMs: 20_000,
};
const ready: SessionBrokerResult = {
  contractVersion: 1,
  requestId: "request-1",
  outcome: "ready",
  sessionUuid: "session-1",
  profile: {
    platform: "android",
    metadataState: "current",
    profileId: "pixel_8",
    systemImagePackage: "system-images;android-35;google_apis;x86_64",
    osVersion: "15",
    versionPrecision: "major",
    apiLevel: 35,
    abi: "x86_64",
    flavor: "google_apis",
  },
  cleanupPending: false,
};

type Call = { method: string; params: Record<string, unknown> };

function rig(answer: (call: Call) => unknown = () => ready) {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const calls: Call[] = [];
  const events: string[] = [];
  const state = { bound: undefined as string | undefined, closing: false };
  const client = new FakeDaemonClient({
    onCallDaemonMethod: (method, params) => {
      calls.push({ method, params });
      if (method === "daemon/capabilities") {
        return { capabilities: ["session-broker/v1"] };
      }
      return answer({ method, params });
    },
  });
  const state2 = {
    client: client as DaemonClientLike | null,
    establishError: undefined as unknown,
  };
  const port: BrokerSessionsPort = {
    ensureConnected: async () => {},
    requireClient: () => client,
    client: () => state2.client,
    isClosing: () => state.closing,
    boundSessionUuid: () => state.bound,
    terminalBoundSessionUuid: () => undefined,
    bindStartupSession: (uuid) => {
      state.bound = uuid;
      events.push(`bind:${uuid}`);
    },
    establishBoundSessionHeartbeat: async () => {
      events.push("establish");
      if (state2.establishError) {
        throw state2.establishError;
      }
    },
    fenceBoundSession: (uuid, code) => events.push(`fence:${uuid}:${code}`),
    forgetBoundSession: (uuid) => {
      events.push(`forget:${uuid}`);
      if (state.bound === uuid) {
        state.bound = undefined;
      }
    },
  };
  const brokerSessions = new BrokerSessions({ timer, livenessOwnerToken: "owner-1", port });
  return { brokerSessions, calls, events, state, state2, client, timer };
}

const handoffPending = {
  code: "session_restart_handoff_pending",
  retryable: true,
  retryAfterMs: 120,
};

describe("BrokerSessions", () => {
  test("acquire binds, establishes ownership and exposes the held binding", async () => {
    const { brokerSessions, events } = rig();
    expect(brokerSessions.result).toBeUndefined();

    expect(await brokerSessions.acquire(config)).toEqual(ready);

    expect(events).toEqual(["bind:session-1", "establish"]);
    expect(brokerSessions.result).toEqual(ready);
    expect(brokerSessions.sessions.get("session-1")).toBe("request-1");
    expect(brokerSessions.heldBinding()).toEqual({
      requestId: "request-1",
      sessionUuid: "session-1",
    });
  });

  test("a failed ownership establishment leaves no held binding and releases the receipt", async () => {
    const { brokerSessions, calls, events, state2 } = rig();
    state2.establishError = new Error("claim refused");

    const result = await brokerSessions.acquire(config);

    expect(result.outcome).toBe("failed");
    expect(brokerSessions.heldBinding()).toBeUndefined();
    expect(brokerSessions.sessions.size).toBe(0);
    expect(events).toContain("forget:session-1");
    expect(calls.some(({ method }) => method === "daemon/releaseBrokerSession")).toBe(true);
  });

  for (const thrown of [false, true]) {
    test(`prepared release retries a ${thrown ? "decoded error" : "result"} handoff pending before forgetting`, async () => {
      let attempts = 0;
      const { brokerSessions, events, state2, timer } = rig(({ method, params }) => {
        if (method !== "daemon/releaseBrokerSession") {
          return ready;
        }
        expect(params).toEqual({
          sessionId: "session-1",
          livenessOwnerToken: "owner-1",
          replyBudgetMs: attempts === 0 ? 6_500 : 6_380,
        });
        expect(brokerSessions.sessions.has("session-1")).toBe(true);
        expect(events).not.toContain("forget:session-1");
        if (++attempts === 1) {
          if (thrown) {
            throw daemonResponseError({
              id: "release-1",
              type: "mcp_response",
              success: false,
              ...handoffPending,
            });
          }
          return handoffPending;
        }
        return { sessionUuid: "session-1", outcome: "released" };
      });
      state2.establishError = new Error("claim refused");

      const result = await brokerSessions.acquire(config);

      expect(attempts).toBe(2);
      expect(timer.getSleepHistory()).toEqual([120]);
      expect(result.cleanupPending).toBe(false);
      expect(brokerSessions.sessions.size).toBe(0);
      expect(events.filter((event) => event === "forget:session-1")).toHaveLength(1);
      expect(timer.getPendingTimeoutCount()).toBe(0);
    });

    test(`prepared release exhausts one budget for repeated handoff ${thrown ? "errors" : "results"}`, async () => {
      let attempts = 0;
      const { brokerSessions, calls, events, state2, timer } = rig(({ method }) => {
        if (method !== "daemon/releaseBrokerSession") {
          return ready;
        }
        attempts++;
        expect(brokerSessions.sessions.has("session-1")).toBe(true);
        expect(events).not.toContain("forget:session-1");
        if (thrown) {
          throw daemonResponseError({
            id: "release-1",
            type: "mcp_response",
            success: false,
            ...handoffPending,
          });
        }
        return handoffPending;
      });
      state2.establishError = new Error("claim refused");
      const started = timer.now();

      const result = await brokerSessions.acquire(config);

      expect(attempts).toBe(58);
      const releases = calls.filter(({ method }) => method === "daemon/releaseBrokerSession");
      expect(releases.at(-1)?.params.replyBudgetMs).toBe(80);
      expect(timer.now() - started).toBe(6_840);
      expect(timer.getSleepHistory()).toEqual(Array<number>(57).fill(120));
      expect(result.cleanupPending).toBe(true);
      expect(brokerSessions.sessions.size).toBe(0);
      expect(events.filter((event) => event === "forget:session-1")).toHaveLength(1);
      expect(timer.getPendingTimeoutCount()).toBe(0);
    });
  }

  for (const refusal of [
    { ...handoffPending, retryable: false },
    { code: handoffPending.code },
    { ...handoffPending, code: "session_owner_mismatch" },
    { ...handoffPending, code: "session_broker_unavailable" },
  ]) {
    for (const thrown of [false, true]) {
      test(`prepared release never retries ${JSON.stringify(refusal)} (${thrown ? "error" : "result"})`, async () => {
        const { brokerSessions, state2, calls, events, timer } = rig(({ method }) => {
          if (method !== "daemon/releaseBrokerSession") {
            return ready;
          }
          if (thrown) {
            throw daemonResponseError({
              id: "release-1",
              type: "mcp_response",
              success: false,
              ...refusal,
            });
          }
          return refusal;
        });
        state2.establishError = new Error("claim refused");

        const result = await brokerSessions.acquire(config);

        expect(result.cleanupPending).toBe(true);
        expect(calls.filter(({ method }) => method === "daemon/releaseBrokerSession")).toHaveLength(
          1,
        );
        expect(timer.getSleepHistory()).toEqual([]);
        expect(brokerSessions.sessions.size).toBe(0);
        expect(events.filter((event) => event === "forget:session-1")).toHaveLength(1);
      });
    }
  }

  test("prepared release rethrows an unrelated error unchanged and forgets immediately", async () => {
    const error = new Error("connection lost");
    const { brokerSessions, events, timer } = rig(() => {
      throw error;
    });
    // Exercise the private acquisition cleanup boundary to verify error identity before its caller logs it.
    brokerSessions.sessions.set("session-1", "request-1");

    await expect(brokerSessions["releasePrepared"]("session-1")).rejects.toBe(error);

    expect(events).toEqual(["forget:session-1"]);
    expect(brokerSessions.sessions.size).toBe(0);
    expect(timer.getSleepHistory()).toEqual([]);
  });

  for (const [retryAfterMs, delay] of [
    [undefined, 250],
    [NaN, 250],
    [Infinity, 250],
    [0, 250],
    [-1, 250],
    [1, 50],
    [5_000, 5_000],
    [10_000, 5_000],
  ] as const) {
    test(`prepared release normalizes retryAfterMs=${String(retryAfterMs)} to ${delay}ms`, async () => {
      let attempts = 0;
      const { brokerSessions, state2, timer } = rig(({ method }) => {
        if (method === "daemon/releaseBrokerSession") {
          return ++attempts === 1
            ? { ...handoffPending, retryAfterMs }
            : { sessionUuid: "session-1", outcome: "released" };
        }
        return ready;
      });
      state2.establishError = new Error("claim refused");

      expect((await brokerSessions.acquire(config)).cleanupPending).toBe(false);

      expect(attempts).toBe(2);
      expect(timer.getSleepHistory()).toEqual([delay]);
    });
  }

  test("a stalled retry only gets the remaining release budget", async () => {
    let attempts = 0;
    const { brokerSessions, state2, events, timer } = rig(({ method }) => {
      if (method !== "daemon/releaseBrokerSession") {
        return ready;
      }
      return ++attempts === 1 ? handoffPending : new Promise<never>(() => {});
    });
    state2.establishError = new Error("claim refused");
    const started = timer.now();

    expect((await brokerSessions.acquire(config)).cleanupPending).toBe(true);

    expect(attempts).toBe(2);
    expect(timer.now() - started).toBe(7_000);
    expect(events.filter((event) => event === "forget:session-1")).toHaveLength(1);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("acquisition abort still completes bounded release cleanup during a handoff", async () => {
    const { brokerSessions, state2, events, timer } = rig(({ method }) => {
      if (method !== "daemon/releaseBrokerSession") {
        return ready;
      }
      brokerSessions.abortAcquisition(new Error("proxy closing"));
      return handoffPending;
    });
    state2.establishError = new Error("claim refused");
    const started = timer.now();

    expect((await brokerSessions.acquire(config)).cleanupPending).toBe(true);

    expect(timer.now() - started).toBe(6_840);
    expect(brokerSessions.sessions.size).toBe(0);
    expect(events.filter((event) => event === "forget:session-1")).toHaveLength(1);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("close takes over a sleeping prepared release so it reaches the successor (#14490)", async () => {
    const successor = { adopted: false, releases: [] as string[] };
    let close: Promise<void> | undefined;
    const { brokerSessions, state, state2, timer } = rig(({ method }) => {
      if (method !== "daemon/releaseBrokerSession") {
        // Shutdown begins while prepare answers: the ready grant is abandoned before its hold.
        state.closing = true;
        brokerSessions.abortAcquisition(new Error("proxy closing"));
        return ready;
      }
      successor.releases.push(`${timer.now()}:${successor.adopted ? "released" : "refused"}`);
      return successor.adopted
        ? { sessionUuid: "session-1", outcome: "released" }
        : { ...handoffPending, retryAfterMs: 5_000 };
    });
    // The successor's recovery pass adopts the handed-off request before close releases.
    timer.setTimeout(() => {
      successor.adopted = true;
    }, 1_000);
    // The `ProxyConnection.closeOnce` order: release within the shutdown budget, then drop the
    // daemon client, while the prepared release still sleeps on its 5 s recovery hint.
    timer.setTimeout(() => {
      close = brokerSessions.releaseAll().then(() => {
        state2.client = null;
        brokerSessions.clear();
      });
    }, 1_200);

    const result = await brokerSessions.acquire(config);
    await close;

    expect(successor.releases).toEqual(["0:refused", "1200:released"]);
    expect(result.failure?.code).toBe("cancelled");
    expect(result.cleanupPending).toBe(false);
    expect(brokerSessions.sessions.size).toBe(0);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("rebindConnection re-registers the held receipt on the new socket", async () => {
    const { brokerSessions, calls, client } = rig();
    await brokerSessions.acquire(config);

    await brokerSessions.rebindConnection(client);

    const register = calls.find(({ method }) => method === "daemon/registerSession")!;
    expect(register.params).toEqual({
      sessionId: "session-1",
      clientName: "auto-mobile-session-broker-proxy",
      sessionBroker: { requestId: "request-1", livenessOwnerToken: "owner-1" },
    });
  });

  test("rebindConnection ignores a stale client and a closing proxy", async () => {
    const { brokerSessions, calls, client, state, state2 } = rig();
    await brokerSessions.acquire(config);

    state2.client = null;
    await brokerSessions.rebindConnection(client);
    state2.client = client;
    state.closing = true;
    await brokerSessions.rebindConnection(client);

    expect(calls.some(({ method }) => method === "daemon/registerSession")).toBe(false);
  });

  test("an ownership-lost rebind fences the binding and drops the receipt", async () => {
    const { brokerSessions, events, client } = rig((call) => {
      if (call.method === "daemon/registerSession") {
        throw Object.assign(new Error("lost"), { code: SESSION_OWNERSHIP_LOST_CODE });
      }
      return ready;
    });
    await brokerSessions.acquire(config);

    await brokerSessions.rebindConnection(client);

    expect(events).toContain(`fence:session-1:${SESSION_OWNERSHIP_LOST_CODE}`);
    expect(brokerSessions.heldBinding()).toBeUndefined();
  });

  test("releaseAll releases each session with the reason, then forgets it", async () => {
    const { brokerSessions, calls, events } = rig((call) =>
      call.method === "daemon/releaseBrokerSession"
        ? { sessionUuid: call.params.sessionId, outcome: "released" }
        : ready,
    );
    await brokerSessions.acquire(config);

    await brokerSessions.releaseAll("session_owner_exited");

    const release = calls.find(({ method }) => method === "daemon/releaseBrokerSession")!;
    expect(release.params).toMatchObject({
      sessionId: "session-1",
      livenessOwnerToken: "owner-1",
      reason: "session_owner_exited",
    });
    expect(brokerSessions.sessions.size).toBe(0);
    expect(brokerSessions.heldBinding()).toBeUndefined();
    expect(events).toContain("forget:session-1");
  });

  test("releaseAll accepts cleanup_pending and drops the heartbeat hold without retrying", async () => {
    const { brokerSessions, calls, events } = rig((call) =>
      call.method === "daemon/releaseBrokerSession"
        ? { sessionUuid: call.params.sessionId, outcome: "cleanup_pending" }
        : ready,
    );
    await brokerSessions.hold("request-1", "session-1");
    await brokerSessions.releaseAll();
    expect(brokerSessions.sessions.size).toBe(0);
    expect(brokerSessions.heldBinding()).toBeUndefined();
    expect(events).toContain("forget:session-1");
    expect(calls.filter((call) => call.method === "daemon/releaseBrokerSession")).toHaveLength(1);
  });

  test("release requests a reply 500 ms before the proxy deadline", async () => {
    const harness = rig((call) => {
      if (call.method !== "daemon/releaseBrokerSession") {
        return ready;
      }
      expect(call.params.replyBudgetMs).toBe(1_000);
      return new Promise((resolve) => {
        harness.timer.setTimeout(
          () => resolve({ sessionUuid: call.params.sessionId, outcome: "cleanup_pending" }),
          Number(call.params.replyBudgetMs),
        );
      });
    });
    await harness.brokerSessions.hold("request-1", "session-1");
    await harness.brokerSessions.releaseAll();
    expect(harness.timer.now()).toBe(1_000);
    expect(harness.timer.getPendingTimeoutCount()).toBe(0);
    expect(harness.brokerSessions.sessions.size).toBe(0);
    expect(
      harness.calls.filter((call) => call.method === "daemon/releaseBrokerSession"),
    ).toHaveLength(1);
  });

  test("releaseAll forgets the session even when the daemon is unreachable", async () => {
    const { brokerSessions, events, state2 } = rig();
    await brokerSessions.acquire(config);
    state2.client = null;

    await brokerSessions.releaseAll();

    expect(events).toContain("forget:session-1");
    expect(brokerSessions.sessions.size).toBe(0);
  });

  for (const [remainingMs, replyBudgetMs] of [
    [50, 25],
    [101, 50],
    [200, 100],
    [749, 250],
    [750, 250],
  ] as const) {
    test(`release retry leaves transport headroom with ${remainingMs}ms remaining`, async () => {
      let attempts = 0;
      const retryAfterMs = BROKER_EXECUTION_RELEASE_TIMEOUT_MS - remainingMs;
      // The proxy's per-call timeout is whatever remains of the release budget at call time.
      const releases: Array<{ replyBudgetMs: number; timeoutMs: number }> = [];
      const { brokerSessions, timer } = rig(({ method, params }) => {
        if (method !== "daemon/releaseBrokerSession") {
          return ready;
        }
        releases.push({
          replyBudgetMs: Number(params.replyBudgetMs),
          timeoutMs: BROKER_EXECUTION_RELEASE_TIMEOUT_MS - timer.now(),
        });
        if (++attempts === 1) {
          return { ...handoffPending, retryAfterMs };
        }
        return new Promise((resolve) => {
          timer.setTimeout(
            () => resolve({ sessionUuid: "session-1", outcome: "cleanup_pending" }),
            Number(params.replyBudgetMs),
          );
        });
      });
      await brokerSessions.hold("request-1", "session-1");
      expect(timer.now()).toBe(0);

      await brokerSessions.releaseAll();

      expect(releases).toHaveLength(2);
      const [first, final] = releases;
      expect(first!.timeoutMs).toBe(BROKER_EXECUTION_RELEASE_TIMEOUT_MS);
      expect(first!.replyBudgetMs).toBe(first!.timeoutMs - 500);
      expect(final!.timeoutMs).toBe(remainingMs);
      expect(final!.replyBudgetMs).toBeGreaterThan(0);
      expect(final!.replyBudgetMs).toBeLessThan(final!.timeoutMs);
      expect(final!.replyBudgetMs).toBe(replyBudgetMs);
      expect(timer.getSleepHistory()).toEqual([retryAfterMs]);
      expect(timer.now()).toBe(retryAfterMs + replyBudgetMs);
      expect(timer.getPendingTimeoutCount()).toBe(0);
      expect(brokerSessions.sessions.size).toBe(0);
    });
  }

  test("releaseAll retries handoff with its reason inside the existing shutdown budget", async () => {
    let attempts = 0;
    const { brokerSessions, calls, events, timer } = rig(({ method }) => {
      if (method === "daemon/releaseBrokerSession") {
        return ++attempts === 1 ? handoffPending : new Promise<never>(() => {});
      }
      return ready;
    });
    await brokerSessions.acquire(config);
    const started = timer.now();

    await brokerSessions.releaseAll("session_owner_exited");

    const releases = calls.filter(({ method }) => method === "daemon/releaseBrokerSession");
    expect(releases).toHaveLength(2);
    expect(releases.map(({ params }) => params.replyBudgetMs)).toEqual([1_000, 880]);
    expect(releases.every(({ params }) => params.reason === "session_owner_exited")).toBe(true);
    expect(timer.now() - started).toBe(BROKER_EXECUTION_RELEASE_TIMEOUT_MS);
    expect(events.filter((event) => event === "forget:session-1")).toHaveLength(1);
    expect(brokerSessions.sessions.size).toBe(0);
  });

  for (const retryAfterMs of [900, 875]) {
    test(`releaseAll skips a ${retryAfterMs}ms delay without time for a useful retry`, async () => {
      const { brokerSessions, calls, timer } = rig(({ method }) => {
        if (method === "daemon/releaseBrokerSession") {
          timer.advanceTime(600);
          return { ...handoffPending, retryAfterMs };
        }
        return ready;
      });
      await brokerSessions.acquire(config);
      const started = timer.now();

      await brokerSessions.releaseAll();

      expect(timer.now() - started).toBe(600);
      expect(timer.getSleepHistory()).toEqual([]);
      expect(calls.filter(({ method }) => method === "daemon/releaseBrokerSession")).toHaveLength(
        1,
      );
      expect(brokerSessions.sessions.size).toBe(0);
      expect(timer.getPendingTimeoutCount()).toBe(0);
    });
  }

  for (const prepared of [false, true]) {
    test(`${prepared ? "prepared" : "shutdown"} release bounds repeated 5s recovery hints`, async () => {
      const { brokerSessions, calls, timer } = rig(({ method }) =>
        method === "daemon/releaseBrokerSession"
          ? { ...handoffPending, retryAfterMs: 5_000 }
          : ready,
      );
      await brokerSessions.acquire(config);
      const started = timer.now();

      if (prepared) {
        await brokerSessions["releasePrepared"]("session-1");
      } else {
        await brokerSessions.releaseAll();
      }

      expect(timer.now() - started).toBe(prepared ? 5_000 : 0);
      expect(timer.getSleepHistory()).toEqual(prepared ? [5_000] : []);
      expect(calls.filter(({ method }) => method === "daemon/releaseBrokerSession")).toHaveLength(
        prepared ? 2 : 1,
      );
      expect(brokerSessions.sessions.size).toBe(0);
      expect(timer.getPendingTimeoutCount()).toBe(0);
    });
  }

  test("late-hold cleanup prevents reconnect from rebinding during its retry wait", async () => {
    let attempts = 0;
    const { brokerSessions, calls, client, timer } = rig(({ method }) => {
      if (method !== "daemon/releaseBrokerSession") {
        return ready;
      }
      if (++attempts === 1) {
        timer.setTimeout(() => {
          expect(brokerSessions.heldBinding()).toBeUndefined();
          expect(brokerSessions.sessions.get("session-1")).toBe("request-1");
          void brokerSessions.rebindConnection(client);
        }, 60);
        return handoffPending;
      }
      return { sessionUuid: "session-1", outcome: "released" };
    });
    await brokerSessions.acquire(config);

    await brokerSessions["releasePrepared"]("session-1");

    expect(attempts).toBe(2);
    expect(timer.getSleepHistory()).toEqual([120]);
    expect(calls.some(({ method }) => method === "daemon/registerSession")).toBe(false);
    expect(brokerSessions.sessions.size).toBe(0);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("clear drops every hold without calling the daemon", async () => {
    const { brokerSessions, calls } = rig();
    await brokerSessions.acquire(config);
    const before = calls.length;

    brokerSessions.clear();

    expect(brokerSessions.sessions.size).toBe(0);
    expect(brokerSessions.heldBinding()).toBeUndefined();
    expect(calls.length).toBe(before);
  });
});
