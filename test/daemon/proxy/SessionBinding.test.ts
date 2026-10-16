import { describe, expect, test } from "bun:test";
import { DaemonMcpProxy } from "../../../src/daemon/daemonMcpProxy";
import {
  SessionBinding,
  type SessionBindingDependencies,
  type SessionBindingPort,
  rememberSessionDeviceId,
  sessionUuidFromArgs,
} from "../../../src/daemon/proxy/SessionBinding";
import { ProxySessionState } from "../../../src/daemon/proxy/ProxySessionState";
import { DaemonBoundSessionExpiredError } from "../../../src/daemon/proxy/daemonErrors";
import type { ListChangedKind } from "../../../src/server/listChangedBroadcast";
import { withRoutedSessionMeta } from "../../../src/server/routedSessionMeta";
import { FakeDaemonManager } from "../../fakes/FakeDaemonManager";
import { FakeTimer } from "../../fakes/FakeTimer";

class FakeBindingPort implements SessionBindingPort {
  readonly calls: unknown[][] = [];
  keeperStarted = false;
  releaseReason: string | undefined;
  neverReached = false;
  acceptsSession = true;
  stop = () => Promise.resolve(true);
  establish = () => Promise.resolve();

  constructor(private readonly state: ProxySessionState) {}

  startBoundSessionHeartbeat(): void {
    this.calls.push(["start", this.state.boundSessionUuid]);
  }
  forwardedSessionReleaseReasonSince(args: Record<string, unknown>, epoch: number) {
    this.calls.push(["forwardedRelease", args, epoch]);
    return this.releaseReason;
  }
  fenceReleasedForwardedSession(args: Record<string, unknown>, reason: string): void {
    this.calls.push(["fence", args, reason]);
  }
  throwIfSessionReleasedSince(uuid: string, epoch: number): void {
    this.calls.push(["checkRelease", uuid, epoch]);
    if (this.releaseReason) {
      throw new DaemonBoundSessionExpiredError(uuid, this.releaseReason);
    }
  }
  sessionReleaseReasonSince(uuid: string, epoch: number) {
    this.calls.push(["release", uuid, epoch]);
    return this.releaseReason;
  }
  invalidateListCache(kind: ListChangedKind): void {
    this.calls.push(["invalidate", kind, this.state.boundSessionUuid]);
  }
  notifyListChanged(kind: ListChangedKind): void {
    this.calls.push(["notify", kind]);
  }
  holdPreviousBinding(uuid: string): void {
    this.calls.push(["hold", uuid, this.state.boundSessionUuid]);
  }
  clearHeldSessionLossesForSelection(uuid: string, platform?: unknown): void {
    this.calls.push(["clearLosses", uuid, platform]);
  }
  syncHeartbeatKeeper(): void {
    this.calls.push(["sync"]);
  }
  stopBoundSessionHeartbeat(): Promise<boolean> {
    this.calls.push(["stop"]);
    return this.stop();
  }
  establishBoundSessionHeartbeat(): Promise<void> {
    this.calls.push(["establish", this.state.boundSessionUuid]);
    return this.establish();
  }
  isHeartbeatKeeperStarted(): boolean {
    this.calls.push(["keeperStarted"]);
    return this.keeperStarted;
  }
  failureNeverReachedLiveSession(error: unknown): boolean {
    this.calls.push(["neverReached", error]);
    return this.neverReached;
  }
  toolAcceptsSessionUuid(name: string): boolean {
    this.calls.push(["accepts", name]);
    return this.acceptsSession;
  }
}

function harness() {
  const timer = new FakeTimer();
  timer.advanceTime(123);
  const state = new ProxySessionState();
  const port = new FakeBindingPort(state);
  const controls = { initialSessionUuid: undefined as string | undefined };
  const deps: SessionBindingDependencies = {
    timer,
    state,
    port,
    ownedDeviceSessions: new Set(),
    sessionPlatforms: new Map(),
    sessionDeviceIds: new Map(),
    managedExecutionSessions: new Set(),
    sessionBrokerSessions: new Map(),
    plainRestartSessionLosses: new Map(),
    pendingHeldSessionPlatformLosses: new Map(),
    initialSessionUuid: () => controls.initialSessionUuid,
  };
  return { timer, state, port, deps, controls, binding: new SessionBinding(deps) };
}

function acquisition(uuid = "minted") {
  return {
    content: [],
    structuredContent: {
      platform: "android",
      runtime: { deviceId: "device", session: { sessionUuid: uuid } },
    },
  };
}

describe("SessionBinding", () => {
  test("acquisition publishes ownership and invalidates both lists before awaiting heartbeat and notifying", async () => {
    const h = harness();
    h.state.boundSessionUuid = "previous";
    h.state.initialSessionBindingConfigured = true;
    h.state.livenessOwnershipClaimSent = true;
    const heartbeat = Promise.withResolvers<void>();
    h.port.establish = () => heartbeat.promise;
    const bind = h.binding.bindResultMintedDeviceSession("getAndroid", acquisition(), 7);
    expect(h.state.boundSessionUuid).toBe("minted");
    expect(h.state.boundSessionUuidAt).toBe(h.timer.now());
    expect([...h.deps.ownedDeviceSessions]).toEqual(["minted"]);
    expect([...h.state.claimableSessions]).toEqual(["minted"]);
    expect(h.state.boundSessionFromResultMint).toBe(true);
    expect(h.state.initialSessionBindingConfigured).toBe(false);
    expect(h.state.livenessOwnershipClaimSent).toBe(false);
    expect(h.deps.sessionDeviceIds.get("minted")).toBe("device");
    expect(h.deps.sessionPlatforms.get("minted")).toBe("android");
    expect(h.port.calls).toEqual([
      ["checkRelease", "minted", 7],
      ["keeperStarted"],
      ["release", "minted", 7],
      ["clearLosses", "minted", undefined],
      ["hold", "minted", "previous"],
      ["invalidate", "tools", "minted"],
      ["invalidate", "resources", "minted"],
      ["establish", "minted"],
    ]);
    heartbeat.resolve();
    await bind;
    expect(h.port.calls.slice(-2)).toEqual([
      ["notify", "tools"],
      ["checkRelease", "minted", 7],
    ]);
  });

  test("an acquisition naming the existing binding only records platform and clears losses", async () => {
    const h = harness();
    h.state.boundSessionUuid = "minted";
    h.state.boundSessionUuidAt = 11;
    await h.binding.bindResultMintedDeviceSession("getAndroid", acquisition(), 0);
    expect(h.port.calls).toEqual([["clearLosses", "minted", undefined]]);
    expect(h.deps.sessionPlatforms.get("minted")).toBe("android");
    expect(h.deps.sessionDeviceIds.size).toBe(0);
    expect(h.deps.ownedDeviceSessions.size).toBe(0);
    expect(h.state.boundSessionUuidAt).toBe(11);
  });

  test.each([false, true])(
    "a named other session moves the binding only when selectsDefault=%s",
    (selectsDefault) => {
      const h = harness();
      h.state.boundSessionUuid = "previous";
      h.state.boundSessionUuidAt = 10;
      h.state.claimableSessions.add("other");
      h.deps.plainRestartSessionLosses.set("other", "restart");
      h.deps.pendingHeldSessionPlatformLosses.set("other", { platform: "ios", reason: "released" });
      h.binding.rememberSessionUuid(
        "tap",
        { sessionUuid: " other ", deviceId: "other-device" },
        2,
        selectsDefault,
      );
      expect(h.state.boundSessionUuid).toBe(selectsDefault ? "other" : "previous");
      expect(h.state.boundSessionUuidAt).toBe(selectsDefault ? h.timer.now() : 10);
      expect(h.deps.sessionDeviceIds.get("other")).toBe("other-device");
      expect(h.port.calls.filter(([name]) => name === "hold" || name === "start")).toEqual(
        selectsDefault
          ? [
              ["hold", "other", "previous"],
              ["start", "other"],
            ]
          : [],
      );
      expect(h.state.boundSessionFromResultMint).toBe(selectsDefault);
      expect(h.deps.plainRestartSessionLosses.has("other")).toBe(!selectsDefault);
      expect(h.deps.pendingHeldSessionPlatformLosses.has("other")).toBe(!selectsDefault);
    },
  );

  test.each([undefined, "other", "named"])(
    "an error establishes a first binding only with matching routed echo %s",
    (echo) => {
      const h = harness();
      h.binding.bindForwardedSessionOnErrorResult(
        "tap",
        { sessionUuid: "named" },
        withRoutedSessionMeta({ isError: true }, echo),
        3,
      );
      expect(h.state.boundSessionUuid).toBe(echo === "named" ? "named" : undefined);
      expect(h.port.calls.some(([name]) => name === "start")).toBe(echo === "named");
    },
  );

  test.each(["bound", "terminal"])(
    "an error with matching echo never replaces a %s binding",
    (fence) => {
      const h = harness();
      if (fence === "bound") {
        h.state.boundSessionUuid = "previous";
      } else {
        h.state.terminalBoundSession = {
          sessionUuid: "previous",
          reason: "released",
          fromResultMint: true,
        };
      }
      const terminal = h.state.terminalBoundSession;
      h.binding.bindForwardedSessionOnErrorResult(
        "tap",
        { sessionUuid: "named" },
        withRoutedSessionMeta({ isError: true }, "named"),
        0,
      );
      expect(h.state.boundSessionUuid).toBe(fence === "bound" ? "previous" : undefined);
      expect(h.state.terminalBoundSession).toBe(terminal);
      expect(h.port.calls.some(([name]) => name === "start")).toBe(false);
    },
  );

  test("admitted failures skip plan, selection and unproven admission and refresh only the bound session", () => {
    const h = harness();
    const error = new Error("handler failed");
    h.state.boundSessionUuid = "bound";
    h.state.boundSessionUuidAt = 10;
    for (const name of ["executePlan", "setActiveDevice"]) {
      h.binding.refreshReplayLeaseAfterAdmittedFailure(name, { sessionUuid: "bound" }, error, 0);
    }
    expect(h.port.calls).toEqual([]);
    h.port.neverReached = true;
    h.binding.refreshReplayLeaseAfterAdmittedFailure("tap", { sessionUuid: "bound" }, error, 0);
    expect(h.port.calls).toEqual([["neverReached", error]]);
    h.port.neverReached = false;
    h.binding.refreshReplayLeaseAfterAdmittedFailure("tap", { sessionUuid: "other" }, error, 0);
    expect(h.state.boundSessionUuid).toBe("bound");
    expect(h.port.calls.some(([name]) => name === "start")).toBe(false);
    h.binding.refreshReplayLeaseAfterAdmittedFailure("tap", { sessionUuid: "bound" }, error, 0);
    expect(h.port.calls.at(-1)).toEqual(["start", "bound"]);
    // Re-binding preserves the existing activity clock, including on the failure path.
    expect(h.state.boundSessionUuidAt).toBe(10);
    h.state.boundSessionUuid = undefined;
    h.binding.refreshReplayLeaseAfterAdmittedFailure("tap", { sessionUuid: "named" }, error, 0);
    expect(h.state.boundSessionUuid).toBeUndefined();
  });

  test("a release during keeper stop synchronizes the keeper and rejects before publishing", async () => {
    const h = harness();
    h.state.boundSessionUuid = "previous";
    h.port.keeperStarted = true;
    const stopped = Promise.withResolvers<boolean>();
    h.port.stop = () => stopped.promise;
    const bind = h.binding.bindResultMintedDeviceSession("getAndroid", acquisition(), 4);
    expect(h.port.calls.at(-1)).toEqual(["stop"]);
    h.port.releaseReason = "released-during-stop";
    stopped.resolve(true);
    await expect(bind).rejects.toBeInstanceOf(DaemonBoundSessionExpiredError);
    expect(h.port.calls.slice(-2)).toEqual([["release", "minted", 4], ["sync"]]);
    expect(h.state.boundSessionUuid).toBe("previous");
    expect(h.deps.ownedDeviceSessions.size).toBe(0);
    expect(h.state.claimableSessions.size).toBe(0);
    expect(h.deps.sessionPlatforms.size).toBe(0);
  });

  test("provenance reads startup configuration live and held bindings preserve their clock", () => {
    const h = harness();
    h.controls.initialSessionUuid = " startup ";
    h.state.claimableSessions.add("startup");
    h.state.otherHeldSessions.set("startup", { claimSent: true, lastUsedAt: 5 });
    h.binding.rememberSessionUuid("tap", { sessionUuid: "startup" }, 0, true);
    expect(h.state.boundSessionFromResultMint).toBe(false);
    expect(h.state.boundSessionUuidAt).toBe(5);
    h.controls.initialSessionUuid = undefined;
    h.state.boundSessionUuid = undefined;
    h.binding.rememberSessionUuid("tap", { sessionUuid: "startup" }, 0, true);
    expect(h.state.boundSessionFromResultMint).toBe(true);
  });

  test("pure argument and device helpers preserve trimming and invalid-value handling", () => {
    expect(sessionUuidFromArgs({ sessionUuid: " named " })).toBe("named");
    for (const sessionUuid of [undefined, 1, "  "]) {
      expect(sessionUuidFromArgs({ sessionUuid })).toBeUndefined();
    }
    const ids = new Map<string, string>();
    for (const deviceId of [undefined, 1, "  "]) {
      rememberSessionDeviceId(ids, "named", deviceId);
    }
    expect(ids.size).toBe(0);
    rememberSessionDeviceId(ids, "named", " device ");
    expect(ids.get("named")).toBe(" device ");
  });

  test("the constructed port looks up patched proxy methods and keeper state live", () => {
    const proxy = new DaemonMcpProxy({
      timer: new FakeTimer(),
      daemonManager: new FakeDaemonManager(),
    });
    const port = proxy["createSessionBindingPort"]();
    const calls: unknown[][] = [];
    proxy["holdPreviousBinding"] = (...args) => {
      calls.push(args);
    };
    port.holdPreviousBinding("named");
    expect(calls).toEqual([["named"]]);
    expect(port.isHeartbeatKeeperStarted()).toBe(false);
    proxy["heartbeatKeeperStarted"] = true;
    expect(port.isHeartbeatKeeperStarted()).toBe(true);
  });
});
