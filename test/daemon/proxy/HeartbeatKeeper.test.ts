import { describe, expect, test } from "bun:test";
import { DaemonMcpProxy } from "../../../src/daemon/daemonMcpProxy";
import {
  HeartbeatKeeper,
  type HeartbeatKeeperDependencies,
  type HeartbeatKeeperPort,
} from "../../../src/daemon/proxy/HeartbeatKeeper";
import { ProxySessionState } from "../../../src/daemon/proxy/ProxySessionState";
import { LifecycleConnectionInFlightError } from "../../../src/daemon/proxy/LifecycleConnectionInFlightError";
import { heartbeatRequestTimeoutMs } from "../../../src/daemon/proxy/heartbeatCadence";
import {
  DAEMON_STALLED_CODE,
  PROXY_STALLED_CODE,
  TickLatenessClock,
  daemonLifecycleAllowed,
  type LivenessStallCode,
} from "../../../src/daemon/proxyLivenessRecovery";
import { FakeDaemonManager } from "../../fakes/FakeDaemonManager";
import { FakeTimer } from "../../fakes/FakeTimer";
import { drainMicrotasks, drainUntil } from "../../helpers/fakeTimerStepping";

type Recovery = HeartbeatKeeperDependencies["livenessRecovery"];

class FakeRecovery implements Recovery {
  readonly begins: [string, LivenessStallCode][] = [];
  readonly recovering = new Set<string>();
  readonly checks: string[] = [];

  begin(sessionUuid: string, code: LivenessStallCode): void {
    this.begins.push([sessionUuid, code]);
    this.recovering.add(sessionUuid);
  }

  isRecovering(sessionUuid: string): boolean {
    this.checks.push(sessionUuid);
    return this.recovering.has(sessionUuid);
  }
}

function harness() {
  const timer = new FakeTimer();
  const state = new ProxySessionState();
  const recovery = new FakeRecovery();
  const calls: unknown[][] = [];
  const inFlight = new Set<string>();
  const keptInUse = new Set<string>();
  const controls = {
    closing: false,
    missingAck: false,
    latest: () => Promise.resolve(),
    ask: (_uuid: string, _claim: boolean) => Promise.resolve(),
    reconnect: () => Promise.resolve(),
  };
  const port: HeartbeatKeeperPort = {
    runLatestBindingHeartbeatTick: () => {
      calls.push(["latest"]);
      return controls.latest();
    },
    hasSessionCallInFlight: (uuid) => {
      calls.push(["inFlight", uuid]);
      return inFlight.has(uuid);
    },
    daemonKeepsSessionInUse: (uuid) => {
      calls.push(["keptInUse", uuid]);
      return keptInUse.has(uuid);
    },
    recordHeldSessionTerminalLoss: (...args) => {
      calls.push(["loss", ...args]);
    },
    idleSessionReleaseReason: (uuid) => {
      calls.push(["idleReason", uuid]);
      return "idle";
    },
    dropHeldSession: (uuid) => {
      calls.push(["drop", uuid]);
      state.otherHeldSessions.delete(uuid);
    },
    withRecoverableReconnect: async (operation, uuid, allowReleased, fenceNotFound) => {
      calls.push(["reconnect", uuid, allowReleased, fenceNotFound, daemonLifecycleAllowed()]);
      await controls.reconnect();
      return operation();
    },
    askSessionHeartbeat: (uuid, claim) => {
      calls.push(["ask", uuid, claim]);
      return controls.ask(uuid, claim);
    },
    recordHeldSessionHeartbeatSuccess: (uuid, claim) => {
      calls.push(["success", uuid, claim]);
    },
    noteLateHeartbeatAck: (uuid) => {
      calls.push(["late", uuid]);
    },
    handleHeldSessionHeartbeatError: (uuid, claim, error) => {
      calls.push(["error", uuid, claim, error]);
    },
    isMissingHeartbeatAcknowledgement: (error) => {
      calls.push(["missingAck", error]);
      return controls.missingAck;
    },
    heldSessionUuids: () => {
      calls.push(["held"]);
      return ["latest", ...state.otherHeldSessions.keys()];
    },
    isClosing: () => {
      calls.push(["closing"]);
      return controls.closing;
    },
  };
  const deps: HeartbeatKeeperDependencies = {
    timer,
    state,
    tickLateness: new TickLatenessClock(10),
    livenessRecovery: recovery,
    heartbeatLeashMs: 100,
    heartbeatIntervalMs: 10,
    boundSessionReplayTtlMs: 1_000,
    port,
  };
  const keeper = new HeartbeatKeeper(deps);
  const hold = (uuid: string, claimSent = false) => {
    state.otherHeldSessions.set(uuid, { claimSent, lastUsedAt: timer.now() });
  };
  return {
    timer,
    state,
    recovery,
    calls,
    controls,
    inFlight,
    keptInUse,
    deps,
    keeper,
    hold,
  };
}

describe("HeartbeatKeeper", () => {
  test("an empty tick awaits only the latest binding", async () => {
    const h = harness();
    const latest = Promise.withResolvers<void>();
    h.controls.latest = () => latest.promise;
    let settled = false;
    const tick = h.keeper.tick().then(() => {
      settled = true;
    });
    await drainMicrotasks(5);
    expect(settled).toBe(false);
    expect(h.calls).toEqual([["latest"]]);
    latest.resolve();
    await tick;
    expect(settled).toBe(true);
  });

  test("an empty tick rethrows the latest binding's rejection", async () => {
    const h = harness();
    const error = new Error("latest failed");
    h.controls.latest = () => Promise.reject(error);
    await expect(h.keeper.tick()).rejects.toBe(error);
    expect(h.calls).toEqual([["latest"]]);
  });

  test("ticks start both branches concurrently and await every sibling before rethrowing", async () => {
    const h = harness();
    h.hold("failed");
    h.hold("pending");
    const latest = Promise.withResolvers<void>();
    const sibling = Promise.withResolvers<void>();
    const latestError = new Error("latest failed");
    const heldError = new Error("held failed");
    h.controls.latest = () => latest.promise;
    h.controls.ask = (uuid) => (uuid === "failed" ? Promise.reject(heldError) : sibling.promise);
    let settled = false;
    const tick = h.keeper.tick().then(
      () => {
        settled = true;
        return undefined;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    await drainUntil(() => h.calls.filter(([name]) => name === "ask").length === 2, {
      description: "both sibling heartbeats",
    });
    expect(h.calls[0]).toEqual(["latest"]);
    latest.reject(latestError);
    await drainUntil(() => h.calls.some(([name]) => name === "error"), {
      description: "held failure handled",
    });
    expect(h.calls).toContainEqual(["error", "failed", true, heldError]);
    expect(settled).toBe(false);
    sibling.resolve();
    expect(await tick).toBe(latestError);
    expect(h.calls).toContainEqual(["success", "pending", true]);
  });

  test("a held failure does not reject a successful latest-binding tick", async () => {
    const h = harness();
    h.hold("held");
    const error = new Error("held failed");
    h.controls.ask = () => Promise.reject(error);
    await h.keeper.tick();
    expect(h.calls).toContainEqual(["error", "held", true, error]);
  });

  test("a late tick recovers live holds, excluding stopped holds, from live state", async () => {
    const h = harness();
    await h.keeper.tick();
    h.hold("held");
    h.hold("stopped");
    h.state.notFoundStopped.add("stopped");
    h.timer.advanceTime(111);
    await h.keeper.tick();
    expect(h.recovery.begins).toEqual([
      ["latest", PROXY_STALLED_CODE],
      ["held", PROXY_STALLED_CODE],
    ]);
    expect(h.recovery.checks).toContain("held");
  });

  test("tick lateness equal to the leash does not start recovery", async () => {
    const h = harness();
    await h.keeper.tick();
    h.timer.advanceTime(110);
    await h.keeper.tick();
    expect(h.recovery.begins).toEqual([]);
  });

  test("abandoned holds record terminal loss before dropping; in-flight and daemon-kept holds survive", async () => {
    const h = harness();
    for (const uuid of ["idle", "busy", "kept"]) {
      h.hold(uuid);
    }
    h.inFlight.add("busy");
    h.keptInUse.add("kept");
    h.timer.advanceTime(h.deps.boundSessionReplayTtlMs + 1);
    await h.keeper.tick();
    expect(h.calls).toContainEqual(["loss", "idle", "idle", undefined, true]);
    const lossIndex = h.calls.findIndex(([name]) => name === "loss");
    expect(h.calls[lossIndex + 1]).toEqual(["drop", "idle"]);
    expect([...h.state.otherHeldSessions.keys()]).toEqual(["busy", "kept"]);
    expect(h.calls).not.toContainEqual(["ask", "idle", true]);
  });

  test("a held session inside its replay TTL survives eviction", async () => {
    const h = harness();
    h.hold("held");
    h.timer.advanceTime(h.deps.boundSessionReplayTtlMs - 1);
    await h.keeper.tick();
    expect(h.state.otherHeldSessions.has("held")).toBe(true);
    expect(h.calls.some(([name]) => name === "loss")).toBe(false);
  });

  test("missing holds do not call the port", async () => {
    const h = harness();
    await h.keeper.heartbeatHeldSession("missing");
    expect(h.calls).toEqual([]);
  });

  test("closing holds read the live closing flag and send nothing", async () => {
    const h = harness();
    h.hold("held");
    h.controls.closing = true;
    await h.keeper.heartbeatHeldSession("held");
    expect(h.calls).toEqual([["closing"]]);
  });

  test.each([false, true])(
    "current heartbeat success records the ownership claim when claimSent=%s",
    async (claimSent) => {
      const h = harness();
      h.hold("held", claimSent);
      await h.keeper.heartbeatHeldSession("held");
      expect(h.calls).toEqual([
        ["closing"],
        ["reconnect", "held", true, false, false],
        ["ask", "held", !claimSent],
        ["success", "held", !claimSent],
      ]);
    },
  );

  test("heartbeat errors are routed to the held-session handler", async () => {
    const h = harness();
    h.hold("held");
    const error = new Error("refused");
    h.controls.ask = () => Promise.reject(error);
    await h.keeper.heartbeatHeldSession("held");
    expect(h.calls).toContainEqual(["error", "held", true, error]);
    expect(h.recovery.begins).toEqual([]);
  });

  test("a hold replaced during reconnect is neither sent nor credited", async () => {
    const h = harness();
    h.hold("held");
    const gate = Promise.withResolvers<void>();
    h.controls.reconnect = () => gate.promise;
    const heartbeat = h.keeper.heartbeatHeldSession("held");
    h.hold("held", true);
    gate.resolve();
    await heartbeat;
    expect(h.calls.some(([name]) => name === "ask" || name === "success" || name === "late")).toBe(
      false,
    );
  });

  test("an acknowledgement after timeout is late evidence instead of current success", async () => {
    const h = harness();
    h.hold("held");
    h.controls.missingAck = true;
    const answer = Promise.withResolvers<void>();
    h.controls.ask = () => answer.promise;
    const heartbeat = h.keeper.heartbeatHeldSession("held");
    await drainUntil(() => h.calls.some(([name]) => name === "ask"), {
      description: "heartbeat sent",
    });
    h.timer.advanceTime(
      heartbeatRequestTimeoutMs(h.deps.heartbeatLeashMs, h.deps.heartbeatIntervalMs),
    );
    await heartbeat;
    answer.resolve();
    await drainUntil(() => h.calls.some(([name]) => name === "late"), {
      description: "late acknowledgement",
    });
    expect(h.calls).toContainEqual(["late", "held"]);
    expect(h.calls.some(([name]) => name === "success")).toBe(false);
  });

  test("stall detection returns without sending while recovery is active", async () => {
    const h = harness();
    h.recovery.recovering.add("held");
    let sent = false;
    await h.keeper.heartbeatWithStallDetection("held", () => {
      sent = true;
      return Promise.resolve();
    });
    expect(sent).toBe(false);
    expect(h.timer.getPendingTimeoutCount()).toBe(0);
    expect(h.recovery.begins).toEqual([]);
  });

  test("a missing acknowledgement starts daemon recovery exactly at the request timeout", async () => {
    const h = harness();
    h.controls.missingAck = true;
    const send = Promise.withResolvers<void>();
    let isCurrent!: () => boolean;
    const heartbeat = h.keeper.heartbeatWithStallDetection("held", (current) => {
      isCurrent = current;
      return send.promise;
    });
    const timeout = heartbeatRequestTimeoutMs(h.deps.heartbeatLeashMs, h.deps.heartbeatIntervalMs);
    h.timer.advanceTime(timeout - 1);
    expect(h.recovery.begins).toEqual([]);
    expect(isCurrent()).toBe(true);
    h.timer.advanceTime(1);
    await heartbeat;
    expect(isCurrent()).toBe(false);
    expect(h.recovery.begins).toEqual([["held", DAEMON_STALLED_CODE]]);
    expect(h.calls.find(([name]) => name === "missingAck")?.[1]).toBeInstanceOf(Error);
    expect(h.timer.getPendingTimeoutCount()).toBe(0);
    send.resolve();
  });

  test("a non-missing-ack error is rethrown and invalidates the send", async () => {
    const h = harness();
    const error = new Error("refused");
    let isCurrent!: () => boolean;
    const heartbeat = h.keeper.heartbeatWithStallDetection("held", (current) => {
      isCurrent = current;
      return Promise.reject(error);
    });
    await expect(heartbeat).rejects.toBe(error);
    expect(isCurrent()).toBe(false);
    expect(h.recovery.begins).toEqual([]);
  });

  test("closing after a send swallows its rejection without recovery", async () => {
    const h = harness();
    const send = Promise.withResolvers<void>();
    const heartbeat = h.keeper.heartbeatWithStallDetection("held", () => send.promise);
    h.controls.closing = true;
    send.reject(new Error("closing"));
    await heartbeat;
    expect(h.calls).toEqual([["closing"]]);
    expect(h.recovery.begins).toEqual([]);
  });

  test("a lifecycle connection already in flight defers without recovery", async () => {
    const h = harness();
    h.controls.missingAck = true;
    await h.keeper.heartbeatWithStallDetection("held", () =>
      Promise.reject(new LifecycleConnectionInFlightError()),
    );
    expect(h.calls).toEqual([["closing"]]);
    expect(h.recovery.begins).toEqual([]);
  });

  test("proxy delegates preserve promise identity and use live instance methods", async () => {
    const proxy = new DaemonMcpProxy({
      timer: new FakeTimer(),
      daemonManager: new FakeDaemonManager(),
    });
    const keeper = proxy.getInternalsForTesting().proxyHeartbeatKeeper;
    const result = Promise.resolve();
    keeper.tick = () => result;
    keeper.heartbeatHeldSession = () => result;
    keeper.heartbeatWithStallDetection = () => result;
    expect(proxy.getInternalsForTesting().runBoundSessionHeartbeatTick()).toBe(result);
    expect(proxy.getInternalsForTesting().heartbeatHeldSession("held")).toBe(result);
    expect(proxy.getInternalsForTesting().heartbeatWithStallDetection("held", () => result)).toBe(
      result,
    );
    // The port was constructed before this replacement and must still look it up at call time.
    let called = false;
    proxy.getInternalsForTesting().latestBindingKeeper.runLatestBindingHeartbeatTick = () => {
      called = true;
      return result;
    };
    await HeartbeatKeeper.prototype.tick.call(keeper);
    expect(called).toBe(true);
  });
});
