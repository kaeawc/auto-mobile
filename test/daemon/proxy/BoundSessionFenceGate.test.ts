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
import { fakeBindLock, unreachableMcpDispatcher } from "../../helpers/createTestUnixSocketServer";
import { UnixSocketServerHarness } from "../helpers/UnixSocketServerHarness";
import { createFakeDaemonState, createFakeSession } from "../helpers/inputSocketHarness";
import { DAEMON_BOUND_SESSION_PARAM } from "../../../src/daemon/wire/constants";
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
  return { gate: new BoundSessionFenceGate(port), state, owned, ledger, surfaced, port };
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

describe("bound proxy inventory routing", () => {
  test.each(["listDeviceImages", "listDevices"])(
    "%s bypasses a busy autolocked device",
    async (name) => {
      const { gate, port, state } = harness();
      state.boundSessionUuid = "held";
      state.boundSessionUuidAt = 0;
      port.isDeviceInventoryTool = (tool) => tool === "listDevices" || tool === "listDeviceImages";
      port.toolTargetsDevice = () => false;
      const sessions = new Map([["held", createFakeSession("held", "SIM-1", "ios")]]);
      const s = new UnixSocketServerHarness(
        "unused",
        createFakeDaemonState(sessions, new Map([["sock", "held"]])),
        new FakeTimer(),
        undefined,
        { mcpDispatcher: unreachableMcpDispatcher },
        undefined,
        { bindLock: fakeBindLock },
      );
      s.bindClient("sock", {
        clientKey: "bound",
        executionKey: "device:SIM-1",
        sessionUuid: "held",
        requiresLiveDaemonSession: true,
      });
      const held = Promise.withResolvers<void>();
      const busy = s.runKeyedForward("device:SIM-1", () => held.promise);
      try {
        const args = gate.prepareToolRoutingArgs(name, { platform: "ios" }, false).forwardedArgs;
        expect(args).not.toHaveProperty("sessionUuid");
        expect(args).not.toHaveProperty(DAEMON_BOUND_SESSION_PARAM);
        const route = await s.forwardRouteFor(
          {
            id: "listing",
            type: "mcp_request",
            method: "tools/call",
            params: { name, arguments: args },
          },
          "sock",
        );
        expect(s.hasForwardTail("device:SIM-1")).toBe(true);
        expect(route.executionKey).toBe("host:inventory");
        const observe = gate.prepareToolRoutingArgs("observe", {}, false).forwardedArgs;
        expect(observe.sessionUuid).toBe("held");
        expect(observe[DAEMON_BOUND_SESSION_PARAM]).toBe("held");
      } finally {
        held.resolve();
        await busy;
      }
    },
  );
});
