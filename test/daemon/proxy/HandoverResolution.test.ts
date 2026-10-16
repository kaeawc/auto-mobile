import { describe, expect, test } from "bun:test";
import {
  DAEMON_STALLED_CODE,
  PROXY_STALLED_CODE,
  type LivenessHandover,
} from "../../../src/daemon/proxyLivenessRecovery";
import type { PendingHeldSessionLoss } from "../../../src/daemon/proxy/HeldSessionLosses";
import { SESSION_NOT_FOUND_REASON } from "../../../src/daemon/releaseReasons";
import { DaemonSessionStalledError } from "../../../src/daemon/proxy/daemonErrors";
import {
  HandoverResolution,
  type HandoverResolutionPort,
} from "../../../src/daemon/proxy/HandoverResolution";
import {
  ProxySessionState,
  type StallHandoverRecord,
} from "../../../src/daemon/proxy/ProxySessionState";
import {
  DAEMON_LIVENESS_OWNER_CONFLICT_CODE,
  DAEMON_LIVENESS_OWNER_UNOWNED_CODE,
  DAEMON_SESSION_NOT_FOUND_CODE,
} from "../../../src/daemon/types";
import { FakeTimer } from "../../fakes/FakeTimer";

function handover(
  code: LivenessHandover["code"],
  sessionUuids: string[] = ["a"],
): LivenessHandover {
  return {
    code,
    sessions: sessionUuids.map((sessionUuid) => ({
      sessionUuid,
      deviceId: "emulator-5554",
      lastAcknowledgedHeartbeatAt: 100,
    })),
    attempts: 3,
    lastAcknowledgedHeartbeatAt: 100,
    action:
      code === DAEMON_STALLED_CODE
        ? "restart_daemon_then_resume_by_session_uuid"
        : "reacquire_lost_sessions",
  } as LivenessHandover;
}

function record(overrides: Partial<StallHandoverRecord> = {}): StallHandoverRecord {
  return {
    handover: handover(DAEMON_STALLED_CODE),
    delivered: false,
    restore: { bound: false, lastUsedAt: 42, initialBinding: false },
    ...overrides,
  };
}

function harness() {
  const timer = new FakeTimer();
  const state = new ProxySessionState();
  const ownedDeviceSessions = new Set<string>();
  const log: string[] = [];
  const losses = {
    pending: new Map<string, PendingHeldSessionLoss>(),
    recorded: [] as Array<[string, string | undefined]>,
  };
  const probe = { probeable: false, awaitReclaim: false };
  const sends: { ack?: unknown; error?: unknown } = {};
  const handoverListeners: LivenessHandover[] = [];
  const port: HandoverResolutionPort = {
    bumpDiscoveryEpoch: () => log.push("epoch"),
    invalidateCache: () => log.push("invalidate"),
    notifyListChanged: (kind) => log.push(`notify:${kind}`),
    syncHeartbeatKeeper: () => log.push("sync"),
    stopStallProbeInterval: () => log.push("stopProbe"),
    sendResumeHeartbeat: async (id) => {
      log.push(`resume:${id}`);
      if (sends.error) {
        throw sends.error;
      }
      return sends.ack;
    },
    sessionUuidFromArgs: (args) =>
      typeof args.sessionUuid === "string" ? args.sessionUuid : undefined,
    noteDaemonIdleEvidence: (id) => log.push(`idle:${id}`),
    currentHandover: (_id, r) => r.handover,
    reportPendingSessionLoss: () => log.push("reportPending"),
    notifyLivenessHandoverListeners: (h) => {
      handoverListeners.push(h);
    },
    fenceBoundSessionUuid: (id, reason) => log.push(`fence:${id}:${reason}`),
    forgetSessionLivenessState: (id) => log.push(`forget:${id}`),
  };
  const resolution = new HandoverResolution({
    timer,
    state,
    ownedDeviceSessions,
    heldSessionLosses: {
      pending: losses.pending,
      recordTerminalLoss: (id, reason) => {
        losses.recorded.push([id, reason]);
      },
    },
    stallProbe: {
      hasProbeableStall: () => probe.probeable,
      awaitManagedReclaimNotFound: () => probe.awaitReclaim,
    },
    port,
  });
  return {
    resolution,
    state,
    timer,
    ownedDeviceSessions,
    log,
    losses,
    probe,
    sends,
    handoverListeners,
  };
}

describe("HandoverResolution.restoreResumedSession", () => {
  test("does nothing without a handover record", () => {
    const h = harness();
    h.resolution.restoreResumedSession("a");
    expect(h.log).toEqual([]);
  });

  test("lifts the handover, queues the resume notice, and holds a claimable session again", () => {
    const h = harness();
    const r = record();
    h.state.stallHandovers.set("a", r);
    h.state.claimableSessions.add("a");
    h.state.plainRestartSessionLosses.set("a", "x");
    h.losses.pending.set("a", { platform: "android", reason: "x" });
    h.timer.advanceTime(9);
    h.resolution.restoreResumedSession("a", { previousDaemonInstance: "o", daemonInstance: "n" });
    expect(h.state.stallHandovers.has("a")).toBe(false);
    expect(h.state.plainRestartSessionLosses.has("a")).toBe(false);
    expect(h.losses.pending.has("a")).toBe(false);
    expect(h.state.resumedStallNotices.get("a")).toEqual({
      handover: r.handover,
      restart: { previousDaemonInstance: "o", daemonInstance: "n" },
    });
    expect(h.state.livenessAcks.get("a")).toBe(h.timer.now());
    expect(h.state.otherHeldSessions.get("a")).toEqual({ claimSent: true, lastUsedAt: 42 });
    expect(h.log).toEqual(["sync", "stopProbe"]);
  });

  test("a session that was not claimable is not held again, and a remaining stall keeps the probe running", () => {
    const h = harness();
    h.state.stallHandovers.set("a", record());
    h.probe.probeable = true;
    h.resolution.restoreResumedSession("a");
    expect(h.state.otherHeldSessions.size).toBe(0);
    expect(h.state.resumedStallNotices.get("a")).toEqual({ handover: expect.anything() });
    expect(h.log).toEqual(["sync"]);
  });

  test("a terminal latest binding is rebound exactly as it was before the handover", () => {
    const h = harness();
    h.state.stallHandovers.set(
      "a",
      record({ restore: { bound: true, lastUsedAt: 77, initialBinding: true } }),
    );
    h.state.terminalBoundSession = { sessionUuid: "a", reason: "x", fromResultMint: true };
    h.state.releaseSurfacedFor = "a";
    h.state.claimableSessions.add("a");
    h.resolution.restoreResumedSession("a");
    expect(h.state.terminalBoundSession).toBeUndefined();
    expect(h.state.releaseSurfacedFor).toBeUndefined();
    expect(h.state.boundSessionUuid).toBe("a");
    expect(h.state.boundSessionUuidAt).toBe(77);
    expect(h.state.initialSessionBindingConfigured).toBe(true);
    expect(h.state.boundSessionFromResultMint).toBe(true);
    expect(h.state.livenessOwnershipClaimSent).toBe(true);
    expect(h.ownedDeviceSessions.has("a")).toBe(true);
    expect(h.state.otherHeldSessions.size).toBe(0);
    expect(h.log).toEqual(["epoch", "invalidate", "notify:tools", "sync", "stopProbe"]);
  });

  test("a terminal binding that was not the latest binding is cleared but not rebound", () => {
    const h = harness();
    h.state.stallHandovers.set("a", record());
    h.state.terminalBoundSession = { sessionUuid: "a", reason: "x", fromResultMint: false };
    h.resolution.restoreResumedSession("a");
    expect(h.state.terminalBoundSession).toBeUndefined();
    expect(h.state.boundSessionUuid).toBeUndefined();
    expect(h.log).not.toContain("epoch");
  });

  test("a terminal binding is not rebound over a different binding made meanwhile", () => {
    const h = harness();
    h.state.stallHandovers.set(
      "a",
      record({ restore: { bound: true, lastUsedAt: 1, initialBinding: false } }),
    );
    h.state.terminalBoundSession = { sessionUuid: "a", reason: "x", fromResultMint: false };
    h.state.boundSessionUuid = "other";
    h.resolution.restoreResumedSession("a");
    expect(h.state.boundSessionUuid).toBe("other");
    expect(h.state.terminalBoundSession).toBeUndefined();
    expect(h.log).not.toContain("epoch");
  });

  test("a rebind of a client-declared binding does not announce a tool list change", () => {
    const h = harness();
    h.state.stallHandovers.set(
      "a",
      record({ restore: { bound: true, lastUsedAt: 1, initialBinding: false } }),
    );
    h.state.terminalBoundSession = { sessionUuid: "a", reason: "x", fromResultMint: false };
    h.resolution.restoreResumedSession("a");
    expect(h.log).toEqual(["epoch", "invalidate", "sync", "stopProbe"]);
  });
});

describe("HandoverResolution.isDefinitiveSessionLoss", () => {
  test.each([
    ["session not found", { code: DAEMON_SESSION_NOT_FOUND_CODE }, true],
    ["ownership lost", { code: DAEMON_LIVENESS_OWNER_UNOWNED_CODE }, true],
    ["owner conflict", { code: DAEMON_LIVENESS_OWNER_CONFLICT_CODE }, true],
    ["a timeout", new Error("timeout"), false],
    ["a null failure", null, false],
  ])("%s", (_name, error, expected) => {
    expect(harness().resolution.isDefinitiveSessionLoss(error)).toBe(expected);
  });
});

describe("HandoverResolution.endLostSessionHandover", () => {
  test("does nothing without a handover record", () => {
    const h = harness();
    h.resolution.endLostSessionHandover("a");
    expect(h.log).toEqual([]);
  });

  test("a daemon stall that ends in a lost session queues one proxy_stalled loss and pushes it", () => {
    const h = harness();
    h.state.stallHandovers.set("a", record());
    h.state.claimableSessions.add("a");
    h.ownedDeviceSessions.add("a");
    h.state.terminalBoundSession = { sessionUuid: "a", reason: "old", fromResultMint: false };
    h.resolution.endLostSessionHandover("a", "idle");
    const loss = h.state.pendingSessionLosses.get("a");
    expect(loss).toMatchObject({
      code: PROXY_STALLED_CODE,
      stalledBy: "daemon",
      releaseReasons: { a: "idle" },
      action: "reacquire_lost_sessions",
    });
    expect(h.losses.recorded).toEqual([["a", "idle"]]);
    expect(h.handoverListeners).toEqual([loss as LivenessHandover]);
    expect(h.log).toEqual(["forget:a", "stopProbe"]);
    expect(h.ownedDeviceSessions.has("a")).toBe(false);
    expect(h.state.claimableSessions.has("a")).toBe(false);
    expect(h.state.terminalBoundSession).toMatchObject({ reason: "idle" });
  });

  test("the queued loss lists only the lost session, with its own acknowledgement time", () => {
    const h = harness();
    const two = handover(DAEMON_STALLED_CODE, ["a", "b"]);
    two.sessions[0].lastAcknowledgedHeartbeatAt = 11;
    two.sessions[1].lastAcknowledgedHeartbeatAt = 22;
    two.lastAcknowledgedHeartbeatAt = 99;
    h.state.stallHandovers.set("b", record({ handover: two }));
    h.resolution.endLostSessionHandover("b", "idle");
    const loss = h.state.pendingSessionLosses.get("b");
    expect(loss?.sessions.map((session) => session.sessionUuid)).toEqual(["b"]);
    expect(loss?.lastAcknowledgedHeartbeatAt).toBe(22);
  });

  test("a proxy stall's loss is not attributed to the daemon", () => {
    const h = harness();
    h.state.stallHandovers.set("a", record({ handover: handover(PROXY_STALLED_CODE) }));
    h.resolution.endLostSessionHandover("a", "idle");
    expect(h.state.pendingSessionLosses.get("a")?.stalledBy).toBeUndefined();
  });

  test("a terminal binding that is not a managed execution records the reason but not a reported stall loss", () => {
    const h = harness();
    h.state.stallHandovers.set("a", record());
    h.state.terminalBoundSession = { sessionUuid: "a", reason: "old", fromResultMint: false };
    h.resolution.endLostSessionHandover("a", "idle");
    expect(h.state.terminalBoundSession?.reason).toBe("idle");
    expect(h.state.terminalBoundSession?.reportedStallLossReason).toBeUndefined();
  });

  test("the default release reason is session-not-found", () => {
    const h = harness();
    h.state.stallHandovers.set("a", record());
    h.resolution.endLostSessionHandover("a");
    expect(h.state.pendingSessionLosses.get("a")?.releaseReasons).toEqual({
      a: SESSION_NOT_FOUND_REASON,
    });
  });

  test("a delivered proxy_stalled already reported the loss and queues nothing", () => {
    const h = harness();
    h.state.stallHandovers.set(
      "a",
      record({ handover: handover(PROXY_STALLED_CODE), delivered: true }),
    );
    h.resolution.endLostSessionHandover("a", "idle");
    expect(h.state.pendingSessionLosses.size).toBe(0);
    expect(h.handoverListeners).toEqual([]);
    expect(h.log).toEqual(["forget:a", "stopProbe"]);
  });

  test("an undelivered proxy_stalled queues the loss without a second push", () => {
    const h = harness();
    h.state.stallHandovers.set("a", record({ handover: handover(PROXY_STALLED_CODE) }));
    h.resolution.endLostSessionHandover("a", "idle");
    expect(h.state.pendingSessionLosses.has("a")).toBe(true);
    expect(h.handoverListeners).toEqual([]);
  });

  test("a remaining probeable stall keeps the probe interval running", () => {
    const h = harness();
    h.state.stallHandovers.set("a", record());
    h.probe.probeable = true;
    h.resolution.endLostSessionHandover("a", "idle");
    expect(h.log).toEqual(["forget:a"]);
  });

  test("a plain session answered by a restarted daemon is a terminal ownership loss with no stall push", () => {
    const h = harness();
    h.state.stallHandovers.set("a", record({ stalledDaemonInstance: "old" }));
    h.state.terminalBoundSession = { sessionUuid: "a", reason: "x", fromResultMint: false };
    h.ownedDeviceSessions.add("a");
    h.resolution.endLostSessionHandover("a", "idle", {
      code: DAEMON_SESSION_NOT_FOUND_CODE,
      daemonInstance: "new",
    });
    expect(h.state.plainRestartSessionLosses.get("a")).toBe("idle");
    expect(h.state.pendingSessionLosses.size).toBe(0);
    expect(h.handoverListeners).toEqual([]);
    expect(h.losses.recorded).toEqual([["a", "idle"]]);
    expect(h.log).toEqual(["fence:a:idle", "forget:a", "stopProbe"]);
    expect(h.ownedDeviceSessions.has("a")).toBe(false);
  });

  test("a plain session answered by the same daemon instance stays a stall loss", () => {
    const h = harness();
    h.state.stallHandovers.set("a", record({ stalledDaemonInstance: "old" }));
    h.resolution.endLostSessionHandover("a", "idle", {
      code: DAEMON_SESSION_NOT_FOUND_CODE,
      daemonInstance: "old",
    });
    expect(h.state.plainRestartSessionLosses.size).toBe(0);
    expect(h.state.pendingSessionLosses.has("a")).toBe(true);
  });

  test("a plain session whose reclaim was in progress is a restart loss whatever answered", () => {
    const h = harness();
    h.state.stallHandovers.set("a", record({ managedReclaimSince: 1 }));
    h.resolution.endLostSessionHandover("a", "idle");
    expect(h.state.plainRestartSessionLosses.get("a")).toBe("idle");
    expect(h.state.pendingSessionLosses.size).toBe(0);
  });
});

describe("HandoverResolution.resumeStalledSessionNamedBy", () => {
  test("a call that names no handed-over session does nothing", async () => {
    const h = harness();
    await h.resolution.resumeStalledSessionNamedBy({});
    await h.resolution.resumeStalledSessionNamedBy({ sessionUuid: "unknown" });
    expect(h.log).toEqual([]);
  });

  test("an acknowledged resume restores the session and notes the daemon's idle evidence", async () => {
    const h = harness();
    h.state.stallHandovers.set("a", record({ stalledDaemonInstance: "old" }));
    h.sends.ack = { daemonInstance: "new" };
    await h.resolution.resumeStalledSessionNamedBy({ sessionUuid: "a" });
    expect(h.state.stallHandovers.has("a")).toBe(false);
    expect(h.state.resumedStallNotices.get("a")?.restart).toEqual({
      previousDaemonInstance: "old",
      daemonInstance: "new",
    });
    expect(h.log).toEqual(["resume:a", "sync", "stopProbe", "idle:a"]);
  });

  test("an answer that arrives after the record was replaced only notes idle evidence", async () => {
    const h = harness();
    h.state.stallHandovers.set("a", record());
    const pending = h.resolution.resumeStalledSessionNamedBy({ sessionUuid: "a" });
    h.state.stallHandovers.set("a", record());
    await pending;
    expect(h.state.stallHandovers.has("a")).toBe(true);
    expect(h.log).toEqual(["resume:a", "idle:a"]);
  });

  test("a definitive loss ends the handover and reports the pending loss", async () => {
    const h = harness();
    h.state.stallHandovers.set("a", record());
    h.sends.error = { code: DAEMON_SESSION_NOT_FOUND_CODE, releaseReason: "idle" };
    await h.resolution.resumeStalledSessionNamedBy({ sessionUuid: "a" });
    expect(h.state.pendingSessionLosses.get("a")?.releaseReasons).toEqual({ a: "idle" });
    expect(h.log).toEqual(["resume:a", "forget:a", "stopProbe", "reportPending"]);
  });

  test("a definitive loss that managed reclaim is still awaiting returns the handover", async () => {
    const h = harness();
    const r = record();
    h.state.stallHandovers.set("a", r);
    h.probe.awaitReclaim = true;
    h.sends.error = { code: DAEMON_SESSION_NOT_FOUND_CODE };
    await expect(
      h.resolution.resumeStalledSessionNamedBy({ sessionUuid: "a" }),
    ).rejects.toBeInstanceOf(DaemonSessionStalledError);
    expect(r.delivered).toBe(true);
    expect(h.state.stallHandovers.has("a")).toBe(true);
  });

  test("an unanswered resume returns the structured handover and keeps the fence", async () => {
    const h = harness();
    const r = record();
    h.state.stallHandovers.set("a", r);
    h.sends.error = new Error("timeout");
    const error = await h.resolution
      .resumeStalledSessionNamedBy({ sessionUuid: "a" })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DaemonSessionStalledError);
    expect((error as DaemonSessionStalledError).handover).toBe(r.handover);
    expect(r.delivered).toBe(true);
    expect(h.state.stallHandovers.has("a")).toBe(true);
  });
});
