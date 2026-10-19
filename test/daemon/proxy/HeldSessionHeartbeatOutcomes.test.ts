import { describe, expect, spyOn, test } from "bun:test";
import { logger } from "../../../src/utils/logger";
import { DaemonBoundSessionExpiredError } from "../../../src/daemon/proxy/DaemonBoundSessionExpiredError";
import { HeldSessionNotFoundError } from "../../../src/daemon/proxy/HeldSessionNotFoundError";
import {
  HeldSessionHeartbeatOutcomes,
  type HeldSessionHeartbeatOutcomesPort,
} from "../../../src/daemon/proxy/HeldSessionHeartbeatOutcomes";
import type { OtherHeldSession } from "../../../src/daemon/proxy/ProxySessionState";
import type { NotFoundAnswerOutcome } from "../../../src/daemon/proxy/notFoundDecision";
import {
  DAEMON_LIVENESS_OWNER_CONFLICT_CODE,
  DAEMON_LIVENESS_OWNER_SUPERSEDED_CODE,
  DAEMON_LIVENESS_OWNER_UNOWNED_CODE,
} from "../../../src/daemon/types";
import { FakeTimer } from "../../fakes/FakeTimer";

const LEASH_MS = 10_000;

function harness() {
  const timer = new FakeTimer();
  const otherHeldSessions = new Map<string, OtherHeldSession>();
  const notFoundWindows = new Map<string, unknown>();
  const livenessAcks = new Map<string, number>();
  const livenessConflictLogged = new Set<string>();
  const recovering = new Set<string>();
  const log: string[] = [];
  const state = { closing: false, daemonNotFound: false };
  const port: HeldSessionHeartbeatOutcomesPort = {
    isClosing: () => state.closing,
    isDaemonSessionNotFoundError: () => state.daemonNotFound,
    applyNotFoundOutcome: (id, outcome) => {
      log.push(`notFound:${id}:${outcome.kind}`);
    },
    recordHeldSessionTerminalLoss: (id, reason) => {
      log.push(`loss:${id}:${reason}`);
    },
    dropHeldSession: (id) => {
      log.push(`drop:${id}`);
    },
  };
  const outcomes = new HeldSessionHeartbeatOutcomes({
    timer,
    otherHeldSessions,
    notFoundWindows,
    livenessAcks,
    livenessConflictLogged,
    livenessRecovery: { isRecovering: (id) => recovering.has(id) },
    ownershipConflictLeashMs: LEASH_MS,
    port,
  });
  const hold = (id: string): OtherHeldSession => {
    const held: OtherHeldSession = { claimSent: false, lastUsedAt: 0 };
    otherHeldSessions.set(id, held);
    return held;
  };
  return {
    outcomes,
    timer,
    otherHeldSessions,
    notFoundWindows,
    livenessAcks,
    livenessConflictLogged,
    recovering,
    log,
    state,
    hold,
  };
}

const conflict = (holdRemainingMs?: number) => ({
  code: DAEMON_LIVENESS_OWNER_CONFLICT_CODE,
  ...(holdRemainingMs === undefined ? {} : { livenessOwnerHold: { holdRemainingMs } }),
});

describe("HeldSessionHeartbeatOutcomes", () => {
  describe("isMissingHeartbeatAcknowledgement", () => {
    test.each([
      ["a plain failure", () => new Error("timeout"), false, true],
      [
        "a bound-session expiry",
        () => new DaemonBoundSessionExpiredError("s", "idle"),
        false,
        false,
      ],
      [
        "a held-session not-found",
        () => new HeldSessionNotFoundError("s", { kind: "ended" } as NotFoundAnswerOutcome),
        false,
        false,
      ],
      ["a daemon session-not-found", () => new Error("x"), true, false],
      ["an owner conflict", () => conflict(), false, false],
      [
        "an ownership superseded",
        () => ({ code: DAEMON_LIVENESS_OWNER_SUPERSEDED_CODE }),
        false,
        false,
      ],
      ["an ownership unowned", () => ({ code: DAEMON_LIVENESS_OWNER_UNOWNED_CODE }), false, false],
    ])("%s", (_name, makeError, daemonNotFound, missing) => {
      const h = harness();
      h.state.daemonNotFound = daemonNotFound;
      expect(h.outcomes.isMissingHeartbeatAcknowledgement(makeError())).toBe(missing);
    });
  });

  test("a late acknowledgement is liveness evidence only while the session is recovering", () => {
    const h = harness();
    h.outcomes.noteLateHeartbeatAck("a");
    expect(h.livenessAcks.size).toBe(0);
    h.recovering.add("a");
    h.timer.advanceTime(250);
    h.outcomes.noteLateHeartbeatAck("a");
    expect(h.livenessAcks.get("a")).toBe(h.timer.now());
  });

  test("a success marks the claim sent, clears the conflict and the not-found window, and stamps the ack", () => {
    const h = harness();
    const held = h.hold("a");
    held.conflict = { since: 1 };
    h.notFoundWindows.set("a", {});
    h.livenessConflictLogged.add("a");
    h.timer.advanceTime(5);
    h.outcomes.recordHeldSessionHeartbeatSuccess("a", true);
    expect(held).toMatchObject({ claimSent: true, conflict: undefined });
    expect(h.notFoundWindows.has("a")).toBe(false);
    expect(h.livenessConflictLogged.has("a")).toBe(false);
    expect(h.livenessAcks.get("a")).toBe(h.timer.now());
  });

  test("a success without a claim leaves claimSent alone, and an unheld session still gets an ack", () => {
    const h = harness();
    const held = h.hold("a");
    h.outcomes.recordHeldSessionHeartbeatSuccess("a", false);
    expect(held.claimSent).toBe(false);
    h.outcomes.recordHeldSessionHeartbeatSuccess("unheld", true);
    expect(h.livenessAcks.has("unheld")).toBe(true);
  });

  describe("handleHeldSessionHeartbeatError", () => {
    test("is ignored once the proxy is closing", () => {
      const h = harness();
      h.hold("a");
      h.state.closing = true;
      h.outcomes.handleHeldSessionHeartbeatError(
        "a",
        false,
        new DaemonBoundSessionExpiredError("a", "idle"),
      );
      expect(h.log).toEqual([]);
    });

    test("an ownership loss is informational and counts as an acknowledgement", () => {
      const h = harness();
      const held = h.hold("a");
      h.outcomes.handleHeldSessionHeartbeatError("a", true, {
        code: DAEMON_LIVENESS_OWNER_UNOWNED_CODE,
      });
      expect(held.claimSent).toBe(true);
      expect(h.livenessAcks.has("a")).toBe(true);
      expect(h.log).toEqual([]);
    });

    test("a held-session not-found applies the decided outcome", () => {
      const h = harness();
      h.outcomes.handleHeldSessionHeartbeatError(
        "a",
        false,
        new HeldSessionNotFoundError("a", { kind: "ended" } as NotFoundAnswerOutcome),
      );
      expect(h.log).toEqual(["notFound:a:ended"]);
    });

    test("an expired binding records a terminal loss and drops the session", () => {
      const h = harness();
      h.outcomes.handleHeldSessionHeartbeatError(
        "a",
        false,
        new DaemonBoundSessionExpiredError("a", "daemon-restart"),
      );
      expect(h.log).toEqual(["loss:a:daemon-restart", "drop:a"]);
    });

    test("any other failure changes nothing", () => {
      const h = harness();
      h.hold("a");
      h.outcomes.handleHeldSessionHeartbeatError("a", false, new Error("socket closed"));
      expect(h.log).toEqual([]);
      expect(h.livenessAcks.size).toBe(0);
    });
  });

  describe("owner conflicts", () => {
    test("a refusal keeps the claim unsent and retries, logging once per session", () => {
      const h = harness();
      const held = h.hold("a");
      h.outcomes.handleHeldSessionHeartbeatError("a", true, conflict());
      expect(held.conflict?.since).toBe(h.timer.now());
      expect(h.livenessConflictLogged.has("a")).toBe(true);
      expect(held.claimSent).toBe(false);
      expect(h.log).toEqual([]);
      h.outcomes.handleHeldSessionHeartbeatError("a", true, conflict());
      expect(h.livenessConflictLogged.size).toBe(1);
    });

    test("a refusal for a session that is not held is ignored", () => {
      const h = harness();
      h.outcomes.handleHeldSessionHeartbeatError("ghost", true, conflict());
      expect(h.livenessConflictLogged.size).toBe(0);
    });

    test("an unreported hold is given up on after the fallback leash", () => {
      const h = harness();
      h.hold("a");
      h.outcomes.handleHeldSessionHeartbeatError("a", true, conflict());
      h.timer.advanceTime(LEASH_MS);
      h.outcomes.handleHeldSessionHeartbeatError("a", true, conflict());
      expect(h.log).toEqual(["loss:a:liveness-owner-conflict", "drop:a"]);
      expect(h.livenessConflictLogged.has("a")).toBe(false);
    });

    test("noteLivenessOwnerConflict warns once per session until a success clears it", () => {
      const h = harness();
      h.hold("a");
      const warn = spyOn(logger, "warn").mockImplementation(() => {});
      try {
        h.outcomes.noteLivenessOwnerConflict("a");
        h.outcomes.noteLivenessOwnerConflict("a");
        expect(warn).toHaveBeenCalledTimes(1);
        h.outcomes.recordHeldSessionHeartbeatSuccess("a", false);
        h.outcomes.noteLivenessOwnerConflict("a");
        expect(warn).toHaveBeenCalledTimes(2);
      } finally {
        warn.mockRestore();
      }
    });

    test("a reported hold that is only running out never exhausts the leash", () => {
      const h = harness();
      const held = h.hold("a");
      h.outcomes.handleHeldSessionHeartbeatError("a", true, conflict(0));
      h.timer.advanceTime(LEASH_MS * 3);
      h.outcomes.handleHeldSessionHeartbeatError("a", true, conflict(0));
      expect(h.log).toEqual([]);
      expect(held.conflict?.holdEndsAt).toBeDefined();
    });
  });
});
