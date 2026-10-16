import { describe, expect, spyOn, test } from "bun:test";
import {
  LatestBindingKeeper,
  type LatestBindingKeeperPort,
} from "../../../src/daemon/proxy/LatestBindingKeeper";
import { ProxySessionState } from "../../../src/daemon/proxy/ProxySessionState";
import { logger } from "../../../src/utils/logger";
import { FakeTimer } from "../../fakes/FakeTimer";

const INTERVAL_MS = 1_000;
const LEASH_MS = 5_000;

function harness() {
  const timer = new FakeTimer();
  const state = new ProxySessionState();
  const log: string[] = [];
  const flags = { closing: false, transport: true, replayExpired: false };
  const keeperState = { stopSettles: true };
  const port: LatestBindingKeeperPort = {
    isClosing: () => flags.closing,
    isTransportLive: () => flags.transport,
    heartbeatWithStallDetection: (id, send) => {
      log.push(`stallDetect:${id}`);
      return send(() => true);
    },
    isBoundSessionReplayExpired: () => flags.replayExpired,
    retireIdleBinding: (id) => {
      log.push(`retire:${id}`);
    },
  };
  const keeper = new LatestBindingKeeper({
    timer,
    state,
    keeper: {
      start: () => {
        log.push("start");
      },
      stop: async () => {
        log.push("stop");
        return keeperState.stopSettles;
      },
      run: async () => {
        log.push("run");
      },
    },
    tickLateness: {
      note: (now) => {
        log.push(`note:${now}`);
      },
      reset: () => {
        log.push("reset");
      },
    },
    boundHeartbeat: {
      sendBoundSessionHeartbeat: async (isCurrent) => {
        log.push(`send:${isCurrent === undefined ? "default" : "given"}`);
      },
    },
    heartbeatIntervalMs: INTERVAL_MS,
    heartbeatLeashMs: LEASH_MS,
    port,
  });
  const bindClaimable = (id: string) => {
    state.boundSessionUuid = id;
    state.claimableSessions.add(id);
  };
  return { keeper, state, timer, log, flags, keeperState, bindClaimable };
}

describe("LatestBindingKeeper targets", () => {
  test("a bound session the proxy did not mint is not claimable, held or a heartbeat target", () => {
    const h = harness();
    h.state.boundSessionUuid = "named";
    expect(h.keeper.latestBindingClaimable()).toBe(false);
    expect(h.keeper.isHeldSession("named")).toBe(false);
    expect(h.keeper.hasHeartbeatTargets()).toBe(false);
    expect(h.keeper.heldSessionUuids()).toEqual([]);
  });

  test("a claimable binding is held and listed ahead of the sessions held beside it", () => {
    const h = harness();
    h.bindClaimable("a");
    h.state.otherHeldSessions.set("b", { claimSent: false, lastUsedAt: 0 });
    expect(h.keeper.latestBindingClaimable()).toBe(true);
    expect(h.keeper.isHeldSession("a")).toBe(true);
    expect(h.keeper.isHeldSession("b")).toBe(true);
    expect(h.keeper.isHeldSession("c")).toBe(false);
    expect(h.keeper.heldSessionUuids()).toEqual(["a", "b"]);
  });

  test("a terminal binding is no longer claimable", () => {
    const h = harness();
    h.bindClaimable("a");
    h.state.terminalBoundSession = { sessionUuid: "a", reason: "x", fromResultMint: false };
    expect(h.keeper.latestBindingClaimable()).toBe(false);
  });

  test("a latest binding the daemon answered not-found for is not heartbeatable but held sessions still are", () => {
    const h = harness();
    h.bindClaimable("a");
    h.state.notFoundStopped.add("a");
    expect(h.keeper.latestBindingHeartbeatable()).toBe(false);
    expect(h.keeper.hasHeartbeatTargets()).toBe(false);
    h.state.otherHeldSessions.set("b", { claimSent: false, lastUsedAt: 0 });
    expect(h.keeper.hasHeartbeatTargets()).toBe(true);
  });
});

describe("LatestBindingKeeper.syncHeartbeatKeeper", () => {
  test("starts once with a fresh seeded cadence while there is something to heartbeat", () => {
    const h = harness();
    h.bindClaimable("a");
    h.timer.advanceTime(12);
    h.keeper.syncHeartbeatKeeper();
    h.keeper.syncHeartbeatKeeper();
    expect(h.log).toEqual([`note:${h.timer.now()}`, "start"]);
    expect(h.keeper.started).toBe(true);
  });

  test.each([
    ["closing", (h: ReturnType<typeof harness>) => (h.flags.closing = true)],
    ["without a live transport", (h: ReturnType<typeof harness>) => (h.flags.transport = false)],
  ])("does not start %s", (_name, arrange) => {
    const h = harness();
    h.bindClaimable("a");
    arrange(h);
    h.keeper.syncHeartbeatKeeper();
    expect(h.log).toEqual([]);
    expect(h.keeper.started).toBe(false);
  });

  test("stops, clearing the flag at once, when nothing is left to heartbeat", () => {
    const h = harness();
    h.bindClaimable("a");
    h.keeper.syncHeartbeatKeeper();
    h.log.length = 0;
    h.state.boundSessionUuid = undefined;
    h.keeper.syncHeartbeatKeeper();
    expect(h.keeper.started).toBe(false);
    expect(h.log).toEqual(["reset", "stop"]);
    h.keeper.syncHeartbeatKeeper();
    expect(h.log).toEqual(["reset", "stop"]);
  });

  test("a keeper that lost its transport keeps running", () => {
    const h = harness();
    h.bindClaimable("a");
    h.keeper.syncHeartbeatKeeper();
    h.flags.transport = false;
    h.log.length = 0;
    h.keeper.syncHeartbeatKeeper();
    expect(h.log).toEqual([]);
    expect(h.keeper.started).toBe(true);
  });
});

describe("LatestBindingKeeper.startBoundSessionHeartbeat", () => {
  test("runs the first tick and syncs when a claimable binding has a live transport", () => {
    const h = harness();
    h.bindClaimable("a");
    h.keeper.startBoundSessionHeartbeat();
    expect(h.log).toEqual(["run", expect.stringMatching(/^note:/), "start"]);
  });

  test("runs for held sessions alone, but not for a merely named binding", () => {
    const h = harness();
    h.state.boundSessionUuid = "named";
    h.keeper.startBoundSessionHeartbeat();
    expect(h.log).toEqual([]);
    h.state.otherHeldSessions.set("b", { claimSent: false, lastUsedAt: 0 });
    h.keeper.startBoundSessionHeartbeat();
    expect(h.log[0]).toBe("run");
  });

  test.each([
    [
      "terminal binding",
      (h: ReturnType<typeof harness>) => {
        h.state.terminalBoundSession = { sessionUuid: "a", reason: "x", fromResultMint: false };
        // Another held session would otherwise make the keeper run.
        h.state.otherHeldSessions.set("b", { claimSent: false, lastUsedAt: 0 });
      },
    ],
    ["no transport", (h: ReturnType<typeof harness>) => (h.flags.transport = false)],
    ["closing", (h: ReturnType<typeof harness>) => (h.flags.closing = true)],
  ])("does nothing with %s", (_name, arrange) => {
    const h = harness();
    h.bindClaimable("a");
    arrange(h);
    h.keeper.startBoundSessionHeartbeat();
    expect(h.log).toEqual([]);
  });
});

describe("LatestBindingKeeper.stopBoundSessionHeartbeat", () => {
  test("stops, clears the started flag and the cadence, and reports whether it settled", async () => {
    const h = harness();
    h.bindClaimable("a");
    h.keeper.syncHeartbeatKeeper();
    h.log.length = 0;
    await expect(h.keeper.stopBoundSessionHeartbeat()).resolves.toBe(true);
    expect(h.keeper.started).toBe(false);
    expect(h.log).toEqual(["stop", "reset"]);
  });

  test("warns when the keeper did not settle before shutdown", async () => {
    const h = harness();
    h.keeperState.stopSettles = false;
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      await expect(h.keeper.stopBoundSessionHeartbeat()).resolves.toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("LatestBindingKeeper.runLatestBindingHeartbeatTick", () => {
  test.each([
    ["no binding", (_h: ReturnType<typeof harness>) => {}],
    [
      "closing",
      (h: ReturnType<typeof harness>) => {
        h.bindClaimable("a");
        h.flags.closing = true;
      },
    ],
    [
      "a binding that is not claimable",
      (h: ReturnType<typeof harness>) => {
        h.state.boundSessionUuid = "named";
      },
    ],
  ])("does nothing with %s", async (_name, arrange) => {
    const h = harness();
    arrange(h);
    await h.keeper.runLatestBindingHeartbeatTick();
    expect(h.log).toEqual([]);
  });

  test("a binding the daemon answered not-found for is only checked for idleness", async () => {
    const h = harness();
    h.bindClaimable("a");
    h.state.notFoundStopped.add("a");
    h.flags.replayExpired = true;
    await h.keeper.runLatestBindingHeartbeatTick();
    expect(h.log).toEqual(["retire:a"]);
  });

  test("heartbeats under stall detection, then judges idleness after the heartbeat", async () => {
    const h = harness();
    h.bindClaimable("a");
    h.flags.replayExpired = true;
    await h.keeper.runLatestBindingHeartbeatTick();
    expect(h.log).toEqual(["stallDetect:a", "send:given", "retire:a"]);
  });

  test("a cadence at or beyond the lease heartbeats once, without stall detection", async () => {
    const h = harness();
    const slow = new LatestBindingKeeper({
      timer: h.timer,
      state: h.state,
      keeper: { start() {}, stop: async () => true, run: async () => {} },
      tickLateness: { note() {}, reset() {} },
      boundHeartbeat: {
        sendBoundSessionHeartbeat: async (isCurrent) => {
          h.log.push(`send:${isCurrent === undefined ? "default" : "given"}`);
        },
      },
      heartbeatIntervalMs: LEASH_MS,
      heartbeatLeashMs: LEASH_MS,
      port: {
        isClosing: () => false,
        isTransportLive: () => true,
        heartbeatWithStallDetection: () => {
          throw new Error("must not use stall detection");
        },
        isBoundSessionReplayExpired: () => false,
        retireIdleBinding: () => {},
      },
    });
    h.bindClaimable("a");
    await slow.runLatestBindingHeartbeatTick();
    expect(h.log).toEqual(["send:default"]);
  });

  function keeperWithSend(
    h: ReturnType<typeof harness>,
    send: () => Promise<void>,
  ): LatestBindingKeeper {
    return new LatestBindingKeeper({
      timer: h.timer,
      state: h.state,
      keeper: { start() {}, stop: async () => true, run: async () => {} },
      tickLateness: { note() {}, reset() {} },
      boundHeartbeat: { sendBoundSessionHeartbeat: send },
      heartbeatIntervalMs: INTERVAL_MS,
      heartbeatLeashMs: LEASH_MS,
      port: {
        isClosing: () => false,
        isTransportLive: () => true,
        heartbeatWithStallDetection: (_id, send) => send(() => true),
        isBoundSessionReplayExpired: () => true,
        retireIdleBinding: (id) => {
          h.log.push(`retire:${id}`);
        },
      },
    });
  }

  test("idleness is judged even when the heartbeat fails", async () => {
    const h = harness();
    h.bindClaimable("a");
    const failing = keeperWithSend(h, async () => {
      throw new Error("socket closed");
    });
    await expect(failing.runLatestBindingHeartbeatTick()).rejects.toThrow("socket closed");
    expect(h.log).toEqual(["retire:a"]);
  });

  test("a binding that changed while the heartbeat was in flight is not retired", async () => {
    const h = harness();
    h.bindClaimable("a");
    const rebinding = keeperWithSend(h, async () => {
      h.state.boundSessionUuid = "other";
    });
    await rebinding.runLatestBindingHeartbeatTick();
    expect(h.log).toEqual([]);
  });

  test("a binding fenced while the heartbeat was in flight is not retired", async () => {
    const h = harness();
    h.bindClaimable("a");
    const fencing = keeperWithSend(h, async () => {
      h.state.terminalBoundSession = { sessionUuid: "a", reason: "x", fromResultMint: false };
    });
    await fencing.runLatestBindingHeartbeatTick();
    expect(h.log).toEqual([]);
  });

  test("an idle binding is not retired while its replay lease is live", async () => {
    const h = harness();
    h.bindClaimable("a");
    await h.keeper.runLatestBindingHeartbeatTick();
    expect(h.log).toEqual(["stallDetect:a", "send:given"]);
  });
});
