import { describe, expect, spyOn, test } from "bun:test";
import { logger } from "../../../src/utils/logger";
import {
  BoundSessionHeartbeat,
  type BoundSessionHeartbeatPort,
} from "../../../src/daemon/proxy/BoundSessionHeartbeat";
import { DaemonBoundSessionExpiredError } from "../../../src/daemon/proxy/daemonErrors";
import { ProxySessionState } from "../../../src/daemon/proxy/ProxySessionState";
import {
  RECOVERABLE_NOT_FOUND_HEARTBEAT_WINDOW_MS,
  UNREHYDRATED_HANDOFF,
  type NotFoundAnswerOutcome,
} from "../../../src/daemon/proxy/notFoundDecision";
import {
  DAEMON_LIVENESS_OWNER_CONFLICT_CODE,
  DAEMON_LIVENESS_OWNER_SUPERSEDED_CODE,
  DAEMON_SESSION_NOT_FOUND_CODE,
} from "../../../src/daemon/types";
import { FakeTimer } from "../../fakes/FakeTimer";

const LEASH_MS = 10_000;

function harness() {
  const timer = new FakeTimer();
  const state = new ProxySessionState();
  const log: string[] = [];
  const ownedDeviceSessions = new Set<string>();
  const flags = { closing: false, claimable: true, firstOnConnection: false, otherDaemon: false };
  const heldSessions = new Set<string>();
  const calls: Array<{ method: string; params: unknown }> = [];
  const answers: { ack?: unknown; error?: unknown } = {};
  const client = {
    callDaemonMethod: async (method: string, params: unknown) => {
      calls.push({ method, params });
      if (answers.error) {
        throw answers.error;
      }
      return answers.ack ?? { ok: true };
    },
  };
  const port: BoundSessionHeartbeatPort = {
    requireClient: () => client as never,
    boundSessionHeartbeatParams: (sessionUuid, claim) => ({ sessionUuid, claim }),
    answersOwnershipReestablishment: () => flags.firstOnConnection,
    noteHeartbeatDaemonInstance: () => flags.otherDaemon,
    noteDaemonIdleEvidence: (id) => {
      log.push(`idle:${id}`);
    },
    isDaemonSessionNotFoundError: (error) =>
      (error as { code?: string } | null)?.code === DAEMON_SESSION_NOT_FOUND_CODE,
    isHeldSession: (id) => heldSessions.has(id),
    latestBindingClaimable: () => flags.claimable,
    withRecoverableReconnect: ((operation: () => Promise<unknown>) => operation()) as never,
    fenceBoundSessionUuid: (id, reason) => {
      log.push(`fence:${id}:${reason}`);
    },
    dropHeldSession: (id, keepHandover, keepHistory) => {
      log.push(`drop:${id}:${keepHandover}:${keepHistory}`);
    },
    syncHeartbeatKeeper: () => {
      log.push("sync");
    },
    isClosing: () => flags.closing,
  };
  const lateAcks: string[] = [];
  const conflicts: string[] = [];
  const lossRecords: string[] = [];
  const bound = new BoundSessionHeartbeat({
    timer,
    state,
    ownedDeviceSessions,
    ownershipConflictLeashMs: LEASH_MS,
    heartbeatOutcomes: {
      noteLateHeartbeatAck: (id) => {
        lateAcks.push(id);
      },
      noteLivenessOwnerConflict: (id) => {
        conflicts.push(id);
      },
    },
    heldSessionLosses: {
      recordNotFoundLoss: (id, outcome) => {
        lossRecords.push(`${id}:${outcome.kind}`);
      },
    },
    port,
  });
  const bind = (id: string) => {
    state.boundSessionUuid = id;
  };
  const hold = (id: string) => {
    state.otherHeldSessions.set(id, { claimSent: true, lastUsedAt: 0 });
    heldSessions.add(id);
  };
  return {
    bound,
    state,
    timer,
    log,
    flags,
    answers,
    calls,
    lateAcks,
    conflicts,
    lossRecords,
    ownedDeviceSessions,
    bind,
    hold,
  };
}

const notFound = (releaseReason?: string, daemonInstance?: string) => ({
  code: DAEMON_SESSION_NOT_FOUND_CODE,
  releaseReason,
  daemonInstance,
});

describe("BoundSessionHeartbeat.recordBoundSessionHeartbeatSuccess", () => {
  test("only the current, non-terminal binding records an acknowledgement", () => {
    const h = harness();
    h.bound.recordBoundSessionHeartbeatSuccess("a", true, () => true);
    expect(h.state.livenessAcks.size).toBe(0);
    h.bind("a");
    h.state.terminalBoundSession = { sessionUuid: "a", reason: "x", fromResultMint: false };
    h.bound.recordBoundSessionHeartbeatSuccess("a", true, () => true);
    expect(h.state.livenessAcks.size).toBe(0);
  });

  test("a heartbeat that was given up on is only late evidence", () => {
    const h = harness();
    h.bind("a");
    h.bound.recordBoundSessionHeartbeatSuccess("a", true, () => false);
    expect(h.lateAcks).toEqual(["a"]);
    expect(h.state.livenessOwnershipClaimSent).toBe(false);
    expect(h.state.livenessAcks.size).toBe(0);
  });

  test("a current success marks the claim, clears the leash, window and logged conflict, and stamps the ack", () => {
    const h = harness();
    h.bind("a");
    h.state.latestBindingConflict = { sessionUuid: "a", since: 1 };
    h.state.notFoundWindows.set("a", { since: 1, handoffs: new Set() });
    h.state.livenessConflictLogged.add("a");
    h.timer.advanceTime(7);
    h.bound.recordBoundSessionHeartbeatSuccess("a", true, () => true);
    expect(h.state.livenessOwnershipClaimSent).toBe(true);
    expect(h.state.latestBindingConflict).toBeUndefined();
    expect(h.state.notFoundWindows.has("a")).toBe(false);
    expect(h.state.livenessConflictLogged.has("a")).toBe(false);
    expect(h.state.livenessAcks.get("a")).toBe(h.timer.now());
  });

  test("a success without a claim leaves the claim flag alone", () => {
    const h = harness();
    h.bind("a");
    h.bound.recordBoundSessionHeartbeatSuccess("a", false, () => true);
    expect(h.state.livenessOwnershipClaimSent).toBe(false);
  });
});

describe("BoundSessionHeartbeat.noteNotFoundAnswer", () => {
  test("a non-recoverable release reason ends the session", () => {
    const h = harness();
    expect(h.bound.noteNotFoundAnswer("a", null, "idle", undefined)).toEqual({
      kind: "ended",
      reason: "idle",
    });
  });

  test("a recoverable handoff of an owned held session opens one window and records it", () => {
    const h = harness();
    h.hold("a");
    h.ownedDeviceSessions.add("a");
    h.timer.advanceTime(50);
    const outcome = h.bound.noteNotFoundAnswer("a", null, "daemon-restart", undefined);
    expect(outcome).toEqual({
      kind: "awaited",
      windowSince: h.timer.now(),
      handoff: "release:daemon-restart",
    });
    expect(h.state.notFoundWindows.get("a")).toEqual({
      since: h.timer.now(),
      handoffs: new Set(["release:daemon-restart"]),
    });
  });

  test("the same handoff does not open a second window and is stopped once the first lapsed", () => {
    const h = harness();
    h.hold("a");
    h.ownedDeviceSessions.add("a");
    h.bound.noteNotFoundAnswer("a", null, "daemon-restart", undefined);
    h.timer.advanceTime(RECOVERABLE_NOT_FOUND_HEARTBEAT_WINDOW_MS + 1);
    expect(h.bound.noteNotFoundAnswer("a", null, "daemon-restart", undefined)).toEqual({
      kind: "stopped",
    });
  });

  test("an unreasoned answer from a just-established connection awaits for an owned session", () => {
    const h = harness();
    h.hold("a");
    h.ownedDeviceSessions.add("a");
    h.flags.firstOnConnection = true;
    const outcome = h.bound.noteNotFoundAnswer("a", null, undefined, undefined);
    expect(outcome).toMatchObject({ kind: "awaited", handoff: UNREHYDRATED_HANDOFF });
  });

  test("the latest binding is asked again once when it has had no window", () => {
    const h = harness();
    expect(
      h.bound.noteNotFoundAnswer("a", null, undefined, undefined, { mayAskAgain: true }),
    ).toEqual({ kind: "ask-again", handoff: false });
  });

  test("an answer for a session that is not held records no window", () => {
    const h = harness();
    h.ownedDeviceSessions.add("a");
    h.bound.noteNotFoundAnswer("a", null, "daemon-restart", undefined);
    expect(h.state.notFoundWindows.size).toBe(0);
  });
});

describe("BoundSessionHeartbeat.applyNotFoundOutcome", () => {
  const ended: NotFoundAnswerOutcome = { kind: "ended", reason: "idle" };
  const stopped: NotFoundAnswerOutcome = { kind: "stopped" };
  const awaited: NotFoundAnswerOutcome = { kind: "awaited", windowSince: 1 };

  test("always forgets the daemon's idle report, even for an unknown session", () => {
    const h = harness();
    h.state.daemonIdleReports.set("x", { releaseAt: 1, reportedAt: 1 });
    h.bound.applyNotFoundOutcome("x", ended);
    expect(h.state.daemonIdleReports.size).toBe(0);
    expect(h.log).toEqual([]);
  });

  test("an awaited latest binding re-arms its claim; an awaited held session re-arms its own", () => {
    const h = harness();
    h.bind("a");
    h.state.livenessOwnershipClaimSent = true;
    h.bound.applyNotFoundOutcome("a", awaited);
    expect(h.state.livenessOwnershipClaimSent).toBe(false);
    h.hold("b");
    h.bound.applyNotFoundOutcome("b", awaited);
    expect(h.state.otherHeldSessions.get("b")?.claimSent).toBe(false);
    expect(h.log).toEqual(["sync", "sync"]);
  });

  test("an ended latest binding is fenced under the daemon's reason", () => {
    const h = harness();
    h.bind("a");
    h.bound.applyNotFoundOutcome("a", ended);
    expect(h.log).toEqual(["fence:a:idle"]);
  });

  test("an ended held session is dropped and its loss recorded", () => {
    const h = harness();
    h.hold("b");
    h.bound.applyNotFoundOutcome("b", ended);
    expect(h.lossRecords).toEqual(["b:ended"]);
    expect(h.log).toEqual(["drop:b:false:false", "sync"]);
    expect(h.state.notFoundStopped.has("b")).toBe(false);
  });

  test("a stopped held session is dropped keeping its history and marked stopped", () => {
    const h = harness();
    h.hold("b");
    h.bound.applyNotFoundOutcome("b", stopped);
    expect(h.log).toEqual(["drop:b:false:true", "sync"]);
    expect(h.state.notFoundStopped.has("b")).toBe(true);
  });

  test("a stopped latest binding stays bound and is marked stopped", () => {
    const h = harness();
    h.bind("a");
    h.bound.applyNotFoundOutcome("a", stopped);
    expect(h.state.notFoundStopped.has("a")).toBe(true);
    expect(h.state.boundSessionUuid).toBe("a");
    expect(h.log).toEqual(["sync"]);
  });
});

describe("BoundSessionHeartbeat.sendBoundSessionHeartbeat", () => {
  test("does nothing without a claimable binding or while closing", async () => {
    const h = harness();
    await h.bound.sendBoundSessionHeartbeat();
    h.bind("a");
    h.flags.claimable = false;
    await h.bound.sendBoundSessionHeartbeat();
    h.flags.claimable = true;
    h.flags.closing = true;
    await h.bound.sendBoundSessionHeartbeat();
    expect(h.calls).toEqual([]);
  });

  test("an acknowledged heartbeat claims once, records evidence and clears the in-flight ask", async () => {
    const h = harness();
    h.bind("a");
    await h.bound.sendBoundSessionHeartbeat();
    expect(h.calls).toEqual([
      { method: "daemon/heartbeat", params: { sessionUuid: "a", claim: true } },
    ]);
    expect(h.state.livenessOwnershipClaimSent).toBe(true);
    expect(h.log).toEqual(["idle:a"]);
    expect(h.state.latestHeartbeatAsked).toBeUndefined();
    await h.bound.sendBoundSessionHeartbeat();
    expect(h.calls[1].params).toEqual({ sessionUuid: "a", claim: false });
  });

  test("an ownership-superseded refusal is absorbed without fencing and warns once", async () => {
    const h = harness();
    h.bind("a");
    h.answers.error = { code: DAEMON_LIVENESS_OWNER_SUPERSEDED_CODE };
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      await h.bound.sendBoundSessionHeartbeat();
      await h.bound.sendBoundSessionHeartbeat();
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
    expect(h.state.livenessSupersessionLogged).toBe(true);
    expect(h.state.livenessAcks.has("a")).toBe(true);
    expect(h.log).toEqual([]);
  });

  test("a live-owner conflict keeps the claim unsent and leashes the binding", async () => {
    const h = harness();
    h.bind("a");
    h.answers.error = { code: DAEMON_LIVENESS_OWNER_CONFLICT_CODE };
    await h.bound.sendBoundSessionHeartbeat();
    expect(h.conflicts).toEqual(["a"]);
    expect(h.state.livenessOwnershipClaimSent).toBe(false);
    expect(h.state.latestBindingConflict?.sessionUuid).toBe("a");
    h.timer.advanceTime(LEASH_MS);
    await h.bound.sendBoundSessionHeartbeat();
    expect(h.log).toEqual(["fence:a:liveness-owner-conflict"]);
  });

  test("a conflict on an initial session awaiting its first call never starts the leash", async () => {
    const h = harness();
    h.bind("a");
    h.state.initialSessionAwaitingFirstCall = true;
    h.answers.error = { code: DAEMON_LIVENESS_OWNER_CONFLICT_CODE };
    await h.bound.sendBoundSessionHeartbeat();
    h.timer.advanceTime(LEASH_MS * 5);
    await h.bound.sendBoundSessionHeartbeat();
    expect(h.state.latestBindingConflict).toBeUndefined();
    expect(h.log).toEqual([]);
  });

  test("a conflict answered after the heartbeat was given up on changes nothing", async () => {
    const h = harness();
    h.bind("a");
    h.answers.error = { code: DAEMON_LIVENESS_OWNER_CONFLICT_CODE };
    await h.bound.sendBoundSessionHeartbeat(() => false);
    expect(h.state.latestBindingConflict).toBeUndefined();
  });

  test("a first not-found that the reconnect machinery does not ask again is decided as it stands", async () => {
    const h = harness();
    h.bind("a");
    h.answers.error = notFound();
    await h.bound.sendBoundSessionHeartbeat();
    // ask-again rethrows the daemon's answer; here no retry happens, so it is decided without a client.
    expect(h.state.notFoundStopped.has("a")).toBe(true);
  });

  test("a not-found raised as a held-session answer is applied only while current", async () => {
    const h = harness();
    h.bind("a");
    h.ownedDeviceSessions.add("a");
    h.answers.error = notFound("idle");
    await h.bound.sendBoundSessionHeartbeat(() => false);
    expect(h.log).toEqual([]);
    await h.bound.sendBoundSessionHeartbeat();
    expect(h.log).toEqual(["fence:a:idle"]);
  });

  test("an expired binding ends the tick quietly; any other failure propagates", async () => {
    const h = harness();
    h.bind("a");
    h.answers.error = new DaemonBoundSessionExpiredError("a", "idle");
    await expect(h.bound.sendBoundSessionHeartbeat()).resolves.toBeUndefined();
    h.answers.error = new Error("socket closed");
    await expect(h.bound.sendBoundSessionHeartbeat()).rejects.toThrow("socket closed");
    expect(h.state.latestHeartbeatAsked).toBeUndefined();
  });
});
