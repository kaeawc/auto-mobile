import { describe, expect, test } from "bun:test";
import { DAEMON_STALLED_CODE, PROXY_STALLED_CODE } from "../../../src/daemon/proxyLivenessRecovery";
import {
  DAEMON_INSTANCE_CHANGED_CODE,
  DAEMON_SESSION_NOT_FOUND_CODE,
} from "../../../src/daemon/types";
import {
  StallProbe,
  daemonRestartEvidence,
  type StallProbePort,
} from "../../../src/daemon/proxy/StallProbe";
import type { StallHandoverRecord } from "../../../src/daemon/proxy/ProxySessionState";
import { RECOVERABLE_NOT_FOUND_HEARTBEAT_WINDOW_MS } from "../../../src/daemon/proxy/notFoundDecision";
import { FakeTimer } from "../../fakes/FakeTimer";

function record(overrides: Partial<StallHandoverRecord> = {}): StallHandoverRecord {
  return {
    handover: { code: DAEMON_STALLED_CODE } as StallHandoverRecord["handover"],
    delivered: false,
    restore: { bound: false, lastUsedAt: 0, initialBinding: false },
    ...overrides,
  };
}

function harness() {
  const timer = new FakeTimer();
  const stallHandovers = new Map<string, StallHandoverRecord>();
  const managedExecutionSessions = new Set<string>();
  const calls: string[] = [];
  const state = {
    closing: false,
    resumeAck: { daemonInstance: "new" } as unknown,
    probeAck: { daemonInstance: "same" } as unknown,
    resumeError: undefined as unknown,
    probeError: undefined as unknown,
    definitive: false,
    notFound: false,
  };
  const restores: Array<{ sessionUuid: string; restart: unknown }> = [];
  const lost: Array<{ sessionUuid: string; reason: unknown; error: unknown }> = [];
  const port: StallProbePort = {
    isClosing: () => state.closing,
    sendResumeHeartbeat: async (id) => {
      calls.push(`resume:${id}`);
      if (state.resumeError) {
        throw state.resumeError;
      }
      return state.resumeAck;
    },
    sendProbeHeartbeat: async (id, expected) => {
      calls.push(`probe:${id}:${expected}`);
      if (state.probeError) {
        throw state.probeError;
      }
      return state.probeAck;
    },
    restoreResumedSession: (sessionUuid, restart) => {
      restores.push({ sessionUuid, restart });
    },
    noteDaemonIdleEvidence: (id) => {
      calls.push(`idle:${id}`);
    },
    endLostSessionHandover: (sessionUuid, reason, error) => {
      lost.push({ sessionUuid, reason, error });
    },
    isDefinitiveSessionLoss: () => state.definitive,
    isDaemonSessionNotFoundError: () => state.notFound,
    startProbeInterval: () => calls.push("start"),
    stopProbeInterval: () => calls.push("stop"),
  };
  const probe = new StallProbe({ timer, stallHandovers, managedExecutionSessions, port });
  return { probe, timer, stallHandovers, managedExecutionSessions, calls, state, restores, lost };
}

describe("StallProbe", () => {
  test("hasProbeableStall needs a pinned daemon or a reclaim in progress", () => {
    const h = harness();
    expect(h.probe.hasProbeableStall()).toBe(false);
    h.stallHandovers.set("a", record());
    expect(h.probe.hasProbeableStall()).toBe(false);
    h.stallHandovers.set("b", record({ probeDaemonInstance: "d1" }));
    expect(h.probe.hasProbeableStall()).toBe(true);
    h.stallHandovers.delete("b");
    h.stallHandovers.set("c", record({ managedReclaimSince: 1 }));
    expect(h.probe.hasProbeableStall()).toBe(true);
  });

  test("a round with nothing to probe, or while closing, stops the interval", async () => {
    const h = harness();
    await h.probe.probeStalledSessions();
    h.stallHandovers.set("a", record({ probeDaemonInstance: "d1" }));
    h.state.closing = true;
    await h.probe.probeStalledSessions();
    expect(h.calls).toEqual(["stop", "stop"]);
  });

  test("a pinned probe is answered: the session is restored without restart evidence", async () => {
    const h = harness();
    h.stallHandovers.set("a", record({ probeDaemonInstance: "d1" }));
    await h.probe.probeStalledSessions();
    expect(h.calls).toEqual(["probe:a:d1", "idle:a"]);
    expect(h.restores).toEqual([{ sessionUuid: "a", restart: undefined }]);
  });

  test("a reclaiming session resumes through the resume heartbeat and reports a restarted daemon", async () => {
    const h = harness();
    h.stallHandovers.set("a", record({ managedReclaimSince: 5, stalledDaemonInstance: "old" }));
    await h.probe.probeStalledSessions();
    expect(h.calls).toEqual(["resume:a", "idle:a"]);
    expect(h.restores).toEqual([
      { sessionUuid: "a", restart: { previousDaemonInstance: "old", daemonInstance: "new" } },
    ]);
  });

  test("an answer that arrives after the proxy closed restores nothing", async () => {
    const h = harness();
    h.stallHandovers.set("a", record({ probeDaemonInstance: "d1" }));
    const pending = h.probe.probeStalledSessions();
    h.state.closing = true;
    await pending;
    expect(h.restores).toEqual([]);
    expect(h.calls).toEqual(["probe:a:d1"]);
  });

  test("an answer that arrives after the record was replaced restores nothing", async () => {
    const h = harness();
    const original = record({ probeDaemonInstance: "d1" });
    h.stallHandovers.set("a", original);
    const pending = h.probe.probeStalledSessions();
    h.stallHandovers.set("a", record({ probeDaemonInstance: "d1" }));
    await pending;
    expect(h.restores).toEqual([]);
  });

  test("a pinned probe that finds the daemon replaced reclaims through the resume heartbeat", async () => {
    const h = harness();
    const r = record({ probeDaemonInstance: "d1" });
    h.stallHandovers.set("a", r);
    h.state.probeError = { code: DAEMON_INSTANCE_CHANGED_CODE };
    h.timer.advanceTime(1_000);
    await h.probe.probeStalledSessions();
    expect(r.probeDaemonInstance).toBeUndefined();
    expect(r.managedReclaimSince).toBe(h.timer.now());
    expect(h.calls).toEqual(["probe:a:d1", "resume:a", "idle:a"]);
  });

  test("an unpinned session that sees a replaced daemon stops being probed", async () => {
    const h = harness();
    const r = record({ managedReclaimSince: 1 });
    h.stallHandovers.set("a", r);
    h.state.resumeError = { code: DAEMON_INSTANCE_CHANGED_CODE };
    await h.probe.probeStalledSessions();
    expect(h.calls).toEqual(["resume:a"]);
    expect(h.restores).toEqual([]);
    expect(h.lost).toEqual([]);
  });

  test("a definitive loss ends the handover with the daemon's release reason", async () => {
    const h = harness();
    h.stallHandovers.set("a", record({ probeDaemonInstance: "d1" }));
    const error = { code: "daemon_session_gone", releaseReason: "idle-window" };
    h.state.probeError = error;
    h.state.definitive = true;
    await h.probe.probeStalledSessions();
    expect(h.lost).toEqual([{ sessionUuid: "a", reason: "idle-window", error }]);
  });

  test("an unanswered probe is retried on the next round without changing anything", async () => {
    const h = harness();
    h.stallHandovers.set("a", record({ probeDaemonInstance: "d1" }));
    h.state.probeError = new Error("timeout");
    await h.probe.probeStalledSessions();
    expect(h.lost).toEqual([]);
    expect(h.restores).toEqual([]);
    expect(h.stallHandovers.get("a")?.probeDaemonInstance).toBe("d1");
  });

  describe("awaitManagedReclaimNotFound", () => {
    const notFound = (daemonInstance?: string, releaseReason?: string) => ({
      code: DAEMON_SESSION_NOT_FOUND_CODE,
      daemonInstance,
      releaseReason,
    });

    test("keeps waiting for a not-found inside one window per answering process", () => {
      const h = harness();
      h.state.notFound = true;
      const r = record({ managedReclaimSince: 1, probeDaemonInstance: "d1" });
      expect(h.probe.awaitManagedReclaimNotFound("a", r, notFound("p1"))).toBe(true);
      expect(r.probeDaemonInstance).toBeUndefined();
      expect(r.managedNotFoundWindow).toEqual({ since: h.timer.now(), daemonInstance: "p1" });
      expect(h.calls).toEqual(["start"]);

      h.timer.advanceTime(RECOVERABLE_NOT_FOUND_HEARTBEAT_WINDOW_MS);
      expect(h.probe.awaitManagedReclaimNotFound("a", r, notFound("p1"))).toBe(false);
    });

    test("an answer from a different process opens a fresh window", () => {
      const h = harness();
      h.state.notFound = true;
      const r = record({ managedReclaimSince: 1 });
      h.probe.awaitManagedReclaimNotFound("a", r, notFound("p1"));
      h.timer.advanceTime(RECOVERABLE_NOT_FOUND_HEARTBEAT_WINDOW_MS);
      expect(h.probe.awaitManagedReclaimNotFound("a", r, notFound("p2"))).toBe(true);
      expect(r.managedNotFoundWindow?.daemonInstance).toBe("p2");
    });

    test.each([
      [
        "a proxy stall",
        record({ handover: { code: PROXY_STALLED_CODE } as never, managedReclaimSince: 1 }),
        true,
        undefined,
      ],
      ["not a not-found answer", record({ managedReclaimSince: 1 }), false, undefined],
      ["a plain session that is not reclaiming", record(), true, undefined],
    ])("does not wait for %s", (_name, r, isNotFound, reason) => {
      const h = harness();
      h.state.notFound = isNotFound;
      expect(h.probe.awaitManagedReclaimNotFound("a", r, notFound("p1", reason))).toBe(false);
      expect(h.calls).toEqual([]);
    });

    test("a release reason only keeps the wait going when it is a recoverable handoff", () => {
      const h = harness();
      h.state.notFound = true;
      h.managedExecutionSessions.add("a");
      expect(
        h.probe.awaitManagedReclaimNotFound("a", record(), notFound("p1", "daemon-restart")),
      ).toBe(true);
      expect(
        h.probe.awaitManagedReclaimNotFound("a", record(), notFound("p1", "device-restart:x")),
      ).toBe(false);
      expect(
        h.probe.awaitManagedReclaimNotFound("a", record(), notFound("p1", "not-a-reason")),
      ).toBe(false);
    });

    test("a managed execution session waits even before reclaim starts", () => {
      const h = harness();
      h.state.notFound = true;
      h.managedExecutionSessions.add("a");
      const r = record();
      expect(h.probe.awaitManagedReclaimNotFound("a", r, notFound("p1"))).toBe(true);
      expect(r.managedReclaimSince).toBe(h.timer.now());
    });
  });
});

describe("daemonRestartEvidence", () => {
  test("is reported only when both instances are known and differ", () => {
    expect(
      daemonRestartEvidence(record({ stalledDaemonInstance: "a" }), { daemonInstance: "b" }),
    ).toEqual({ previousDaemonInstance: "a", daemonInstance: "b" });
    expect(
      daemonRestartEvidence(record({ stalledDaemonInstance: "a" }), { daemonInstance: "a" }),
    ).toBeUndefined();
    expect(daemonRestartEvidence(record(), { daemonInstance: "b" })).toBeUndefined();
    expect(daemonRestartEvidence(record({ stalledDaemonInstance: "a" }), {})).toBeUndefined();
  });
});
