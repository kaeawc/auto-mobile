import { describe, expect, test } from "bun:test";
import {
  BoundSessionFenceGate,
  type BoundSessionFenceGatePort,
} from "../../../src/daemon/proxy/BoundSessionFenceGate";
import {
  DaemonBoundSessionExpiredError,
  DaemonConnectionSessionReleasedError,
} from "../../../src/daemon/proxy/daemonErrors";
import { ProxySessionState } from "../../../src/daemon/proxy/ProxySessionState";
import { ReleaseEpochLedger } from "../../../src/daemon/proxy/ReleaseEpochLedger";
import { FakeTimer } from "../../fakes/FakeTimer";

function harness() {
  const state = new ProxySessionState();
  const owned = new Set<string>();
  const ledger = new ReleaseEpochLedger();
  const surfaced: unknown[] = [];
  const port: BoundSessionFenceGatePort = {
    state,
    ownedDeviceSessions: owned,
    pendingHeldSessionPlatformLosses: new Map(),
    sessionDeviceIds: new Map(),
    sessionPlatforms: new Map(),
    releaseLedger: ledger,
    timer: new FakeTimer(),
    livenessRecovery: { isRecovering: () => false },
    keeper: { syncHeartbeatKeeper: () => {} },
    initialSessionUuid: () => undefined,
    boundSessionReplayTtlMs: () => 1000,
    transportLive: () => true,
    toolSelectionProfileUuid: () => undefined,
    bumpDiscoveryEpoch: () => {},
    isDeviceSessionAcquisitionTool: () => false,
    isDeviceInventoryTool: () => false,
    isDeviceBindingTool: () => false,
    isSessionlessControlDeviceTool: () => true,
    toolTargetsDevice: () => true,
    isDeviceReadOnlyTool: () => false,
    hasSessionCallInFlight: () => false,
    noteReleaseSurfacedBy: (answer) => {
      surfaced.push(answer);
    },
    currentHandover: (_id, record) => record.handover,
    outsideBoundSessionError: () => new Error("outside binding"),
    dropHeldSession: () => {},
    forgetSessionLivenessState: () => {},
    invalidateCache: () => {},
    clearBoundSessionUuid: () => {
      state.boundSessionUuid = undefined;
    },
    notifyListChanged: () => {},
    withToolSelectionProfile: (args) => args,
    withOwnedSessionCapabilities: (args) => args,
    namesOwnedSession: () => false,
    sessionUuidFromArgs: (args) =>
      typeof args.sessionUuid === "string" ? args.sessionUuid.trim() || undefined : undefined,
  };
  return { gate: new BoundSessionFenceGate(port), state, owned, ledger, surfaced };
}

describe("BoundSessionFenceGate", () => {
  test("distinguishes an implicit result-minted fence from an explicitly named loss", () => {
    const h = harness();
    h.state.terminalBoundSession = {
      sessionUuid: "released",
      reason: "idle_timeout",
      fromResultMint: true,
    };
    expect(() => h.gate.withBoundSessionUuid({})).toThrow(DaemonConnectionSessionReleasedError);
    expect(h.state.releaseSurfacedFor).toBe("released");
    expect(() => h.gate.withBoundSessionUuid({ sessionUuid: "released" })).toThrow(
      DaemonBoundSessionExpiredError,
    );
    expect(h.surfaced).toHaveLength(1);
  });

  test("reads live plain-restart losses even without a terminal default binding", () => {
    const h = harness();
    h.gate.throwIfBoundSessionFenced(false, "lost");
    h.state.plainRestartSessionLosses.set("lost", "daemon_restart");
    expect(() => h.gate.throwIfBoundSessionFenced(false, "lost")).toThrow(
      DaemonBoundSessionExpiredError,
    );
    expect(h.surfaced).toHaveLength(1);
    expect(() => h.gate.throwIfBoundSessionFenced(true, "lost")).not.toThrow();
  });

  test("a fence permits a different surviving owned session", () => {
    const h = harness();
    h.state.terminalBoundSession = {
      sessionUuid: "lost",
      reason: "released",
      fromResultMint: true,
    };
    h.owned.add("survivor");
    expect(() => h.gate.throwIfBoundSessionFenced(false, "survivor")).not.toThrow();
    expect(() => h.gate.throwIfBoundSessionFenced(false, "foreign")).toThrow(
      DaemonBoundSessionExpiredError,
    );
  });

  test("mid-flight release refuses only the UUID released since forwarding", () => {
    const h = harness();
    h.ledger.retainReleaseEpochReference("lost");
    const epoch = h.ledger.epoch;
    h.ledger.recordSessionReleased("lost", "idle_timeout");
    expect(() => h.gate.throwIfSessionReleasedSince("survivor", epoch)).not.toThrow();
    expect(() =>
      h.gate.throwIfForwardedSessionReleasedSince({ sessionUuid: "lost" }, epoch),
    ).toThrow(DaemonBoundSessionExpiredError);
    expect(h.state.terminalBoundSession).toMatchObject({
      sessionUuid: "lost",
      reason: "idle_timeout",
    });
  });
});
