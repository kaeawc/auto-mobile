import { describe, expect, test } from "bun:test";
import { ProxySessionState } from "../../../src/daemon/proxy/ProxySessionState";

describe("ProxySessionState", () => {
  test("starts with empty collections and undefined bindings", () => {
    const state = new ProxySessionState();

    expect(state.notFoundWindows.size).toBe(0);
    expect(state.notFoundStopped.size).toBe(0);
    expect(state.otherHeldSessions.size).toBe(0);
    expect(state.stallHandovers.size).toBe(0);
    expect(state.claimableSessions.size).toBe(0);
    expect(state.boundSessionUuid).toBeUndefined();
    expect(state.boundSessionUuidAt).toBeUndefined();
    expect(state.terminalBoundSession).toBeUndefined();
    expect(state.livenessOwnershipClaimSent).toBe(false);
    expect(state.boundSessionFromResultMint).toBe(false);
    expect(state.initialSessionBindingConfigured).toBe(false);
  });

  test("owns collections independently for each instance", () => {
    const first = new ProxySessionState();
    const second = new ProxySessionState();

    expect(first.notFoundWindows).not.toBe(second.notFoundWindows);
    expect(first.notFoundStopped).not.toBe(second.notFoundStopped);
    expect(first.otherHeldSessions).not.toBe(second.otherHeldSessions);
    expect(first.stallHandovers).not.toBe(second.stallHandovers);
    expect(first.claimableSessions).not.toBe(second.claimableSessions);
  });

  test("shares scalar writes through references to the same state", () => {
    const state = new ProxySessionState();
    const reference = state;

    reference.boundSessionUuid = "session";
    reference.boundSessionUuidAt = 123;
    reference.livenessOwnershipClaimSent = true;
    reference.boundSessionFromResultMint = true;
    reference.initialSessionBindingConfigured = true;
    reference.terminalBoundSession = {
      sessionUuid: "session",
      reason: "released",
      fromResultMint: false,
    };

    expect(state.boundSessionUuid).toBe("session");
    expect(state.boundSessionUuidAt).toBe(123);
    expect(state.livenessOwnershipClaimSent).toBe(true);
    expect(state.boundSessionFromResultMint).toBe(true);
    expect(state.initialSessionBindingConfigured).toBe(true);
    expect(state.terminalBoundSession).toBe(reference.terminalBoundSession);
    expect(state.terminalBoundSession?.reason).toBe("released");
  });

  describe("per-session liveness records shared with binding", () => {
    const recordNames = [
      "recoveryNotFoundOutcomes",
      "resumedStallNotices",
      "daemonIdleReports",
      "sessionDaemonInstances",
      "livenessAcks",
      "livenessConflictLogged",
      "pendingSessionLosses",
      "plainRestartSessionLosses",
    ] as const;

    test.each([...recordNames])("%s starts empty and is not shared between instances", (name) => {
      const first = new ProxySessionState();
      const second = new ProxySessionState();
      expect(first[name].size).toBe(0);
      expect(first[name]).not.toBe(second[name]);
    });

    test("scalar liveness fields start unset", () => {
      const state = new ProxySessionState();
      expect(state.latestBindingConflict).toBeUndefined();
      expect(state.latestHeartbeatAsked).toBeUndefined();
      expect(state.livenessSupersessionLogged).toBe(false);
      expect(state.releaseSurfacedFor).toBeUndefined();
      expect(state.initialSessionAwaitingFirstCall).toBe(false);
      expect(state.ackedDaemonInstance).toBeUndefined();
    });

    test("scalar writes through one reference are visible through another", () => {
      const state = new ProxySessionState();
      const reference = state;
      reference.latestBindingConflict = { sessionUuid: "s", since: 5 };
      reference.latestHeartbeatAsked = { notFound: true, handoff: false };
      reference.livenessSupersessionLogged = true;
      reference.releaseSurfacedFor = "s";
      reference.initialSessionAwaitingFirstCall = true;
      reference.ackedDaemonInstance = "daemon-1";
      expect(state.latestBindingConflict).toEqual({ sessionUuid: "s", since: 5 });
      expect(state.latestHeartbeatAsked).toEqual({ notFound: true, handoff: false });
      expect(state.livenessSupersessionLogged).toBe(true);
      expect(state.releaseSurfacedFor).toBe("s");
      expect(state.initialSessionAwaitingFirstCall).toBe(true);
      expect(state.ackedDaemonInstance).toBe("daemon-1");
    });
  });
});
