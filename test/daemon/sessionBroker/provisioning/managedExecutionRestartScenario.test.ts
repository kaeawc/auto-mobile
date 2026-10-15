import { beforeAll, describe, expect, test } from "bun:test";
import type { BindingKey } from "../../../../src/daemon/sessionBroker/registry/bindingRegistry";
import { getDbWriteBarrier } from "../../../../src/db/dbWriteBarrier";
import { executionTracker } from "../../../../src/server/executionTracker";
import { ManagedRestartScenario, SCOPE, type ManagedExecution } from "./managedRestartScenario";

// A binding execution across a daemon restart, end to end (#11642 item 1). See
// managedRestartScenario.ts for what is real (the Daemon, its binding wiring, the SQLite binding
// registry, the session repository, the control socket, the stdio proxy and the proxy MCP server)
// and what is the device boundary.
//
// Controls: {execution idle, settling, acquisition in flight} x {clean shutdown, crash} x {owner
// back at 1 s / 9 s / never} x {device still running, device gone}, and two restarts in a row.
// The last block is the restart while the runner's next incarnation waits for the old scope: the
// scope is `invalidating`, and the successor must still record itself as the live execution's
// binding owner so that no other daemon on the host retires the scope under it.
//
// Each case drives its whole scenario (two real daemons, their socket and proxies) once in
// `beforeAll` and records what it saw at each step; the tests only compare those records. A
// scenario costs tens of milliseconds of real socket and SQLite I/O, which belongs to no single
// assertion and is outside the per-test budget there.

const DEVICE = "emulator-5554";
const AVD = `Pixel_${DEVICE}`;
const BOOT_2 = { ...SCOPE, runnerIncarnation: "boot-2" };
const activeExecutionsAtFileStart = executionTracker.getActiveExecutionCount();
// An earlier file can leave a write in flight: Windows runs the unit lane in one shared process.
void getDbWriteBarrier().trackExisting(new Promise<void>(() => undefined));

let s: ManagedRestartScenario;
let key: BindingKey;

async function started(): Promise<ManagedExecution> {
  s = await ManagedRestartScenario.start();
  key = await s.assignBinding(DEVICE);
  const execution = await s.launchExecution();
  const disposition = execution.result.bindings[0]?.disposition;
  const call = await s.controlCall(execution);
  if (disposition !== "reused" || call !== "ok") {
    throw new Error(`scenario setup: first execution was ${disposition}, its call ${call}`);
  }
  return execution;
}

function failureCode(execution: ManagedExecution): string | undefined {
  return execution.result.failure?.code ?? execution.result.bindings[0]?.failure?.code;
}

/** The execution's tool call, left in flight until cancellation or scenario teardown. */
function callInFlight(execution: ManagedExecution, wedged = false): void {
  s.holdCall(execution.sessionUuid!, wedged);
  void execution
    .callTool(
      {
        method: "tools/call",
        params: { name: "tapOn", arguments: { sessionUuid: execution.sessionUuid } },
      },
      {
        signal: new AbortController().signal,
        requestId: 2,
        sendNotification: async () => {},
        sendRequest: async () => ({}),
      },
    )
    .catch(() => undefined);
}

/** Run one scenario before the enclosing describe's tests and hand them what it recorded. */
function observed<T>(run: () => Promise<T>): () => T {
  let seen: T | undefined;
  let activeExecutionsAfterStop: number | undefined;
  let writeBarrierAfterStop: { draining: boolean; inFlight: number } | undefined;
  beforeAll(async () => {
    try {
      seen = await run();
    } finally {
      await s?.stop();
      activeExecutionsAfterStop = executionTracker.getActiveExecutionCount();
      const barrier = getDbWriteBarrier();
      writeBarrierAfterStop = {
        draining: barrier.isDraining(),
        inFlight: barrier.inFlightCount(),
      };
    }
  });
  test("teardown restores the process-wide execution count", () => {
    expect(activeExecutionsAfterStop).toBe(activeExecutionsAtFileStart);
  });
  test("teardown leaves the process-wide write barrier open", () => {
    expect(writeBarrierAfterStop).toEqual({ draining: false, inFlight: 0 });
  });
  return () => {
    if (seen === undefined) {
      throw new Error("the scenario did not run to its end");
    }
    return seen;
  };
}

describe("controls: a live managed execution across a daemon restart", () => {
  describe.each([
    ["clean", 1_000],
    ["clean", 9_000],
    ["crash", 1_000],
    ["crash", 9_000],
  ] as const)("%s restart, owner back after %i ms", (kind, backAfterMs) => {
    const seen = observed(async () => {
      const execution = await started();
      const session = execution.sessionUuid!;
      s.restart.ownerAway(execution.connection);
      await s.endDaemon(kind);
      await s.startSuccessor();
      const bindingAfterRestart = await s.binding(key);
      await s.restart.idleUntilSinceRestart(backAfterMs / 2);
      const duplicate = failureCode(await s.launchExecution());
      await s.restart.idleUntilSinceRestart(backAfterMs);
      s.restart.ownerReturns(execution.connection);
      const callOnReturn = await s.controlCall(execution);
      await s.idle(15_000);
      return {
        session,
        successorPid: s.daemonPid,
        bindingAfterRestart,
        duplicate,
        callOnReturn,
        callLater: await s.controlCall(execution),
        snapshot: await s.restart.snapshot(session, DEVICE),
        available: await s.restart.availableDevices(),
        releases: s.scenario.releases.filter((r) => r.reason !== "daemon-shutdown"),
      };
    });

    test("the binding is re-owned by the successor before any client can arrive", () => {
      // Rehydrated and re-owned: the dead daemon's PID is gone.
      expect(seen().bindingAfterRestart).toMatchObject({
        state: "ready",
        device: AVD,
        owner: { pid: seen().successorPid, sessionUuid: seen().session },
      });
    });

    test("a duplicate proxy for the binding is refused while the execution awaits its owner", () => {
      expect(seen().duplicate).toBe("binding_in_use");
    });

    test("the same session serves the returning owner and stays held", () => {
      const { session, callOnReturn, callLater, snapshot, available, releases } = seen();
      expect([callOnReturn, callLater]).toEqual(["ok", "ok"]);
      expect(snapshot).toMatchObject({
        held: true,
        pool: { status: "busy", sessionId: session },
        stats: { idle: 0, assigned: 1 },
        row: { released: false },
      });
      expect(available).toBe(0);
      expect(releases).toEqual([]);
    });
  });

  describe.each(["clean", "crash"] as const)("%s restart, owner never back", (kind) => {
    const seen = observed(async () => {
      const execution = await started();
      const session = execution.sessionUuid!;
      s.restart.ownerAway(execution.connection);
      await s.endDaemon(kind);
      await s.startSuccessor();
      await s.restart.idleUntilSinceRestart(12_000);
      await s.idle(0);
      const bindingAfterTimeout = await s.binding(key);
      const snapshot = await s.restart.snapshot(session, DEVICE);
      const available = await s.restart.availableDevices();
      const timeouts = s.scenario.releases.filter((r) => r.reason === "rehydration-owner-timeout");
      const next = await s.launchExecution();
      s.restart.ownerReturns(execution.connection);
      return {
        session,
        successorPid: s.daemonPid,
        bindingAfterTimeout,
        snapshot,
        available,
        timeouts: timeouts.length,
        next: next.result.bindings[0],
        nextSession: next.sessionUuid,
        oldProxyAnswer: await s.call(execution),
        nextCall: await s.controlCall(next),
        bindingAtEnd: await s.binding(key),
      };
    });

    test("the execution is released once and the binding keeps its device", () => {
      const { bindingAfterTimeout, snapshot, available, timeouts } = seen();
      expect(bindingAfterTimeout).toMatchObject({ state: "ready", device: AVD, owner: null });
      expect(snapshot).toMatchObject({
        held: false,
        pool: { status: "idle", sessionId: null },
        row: { released: true, reason: "rehydration-owner-timeout" },
      });
      // Idle, but assigned to its binding: never generic capacity.
      expect(available).toBe(0);
      expect(timeouts).toBe(1);
    });

    test("the next execution reuses the device and the old proxy is told to relaunch", () => {
      const { session, successorPid, next, nextSession, oldProxyAnswer, nextCall, bindingAtEnd } =
        seen();
      expect(next).toMatchObject({ disposition: "reused" });
      expect(nextSession).not.toBe(session);
      expect(oldProxyAnswer).toMatchObject({
        ok: false,
        code: "managed_execution_ended",
        nextAction: "relaunch_execution",
      });
      expect(nextCall).toBe("ok");
      expect(bindingAtEnd).toMatchObject({
        owner: { pid: successorPid, sessionUuid: nextSession },
      });
    });
  });

  describe.each(["clean", "crash"] as const)(
    "%s restart with the binding's device gone",
    (kind) => {
      const seen = observed(async () => {
        const execution = await started();
        s.restart.ownerAway(execution.connection);
        await s.endDaemon(kind);
        s.setRunning(DEVICE, false);
        await s.startSuccessor();
        await s.restart.idleUntilSinceRestart(1_000);
        s.restart.ownerReturns(execution.connection);
        const answer = await s.call(execution);
        const binding = await s.binding(key);
        s.setRunning(DEVICE, true);
        const next = await s.launchExecution();
        return {
          answer,
          binding,
          next: next.result.bindings[0],
          nextCall: await s.controlCall(next),
        };
      });

      test("the execution ends typed and the binding keeps its device", () => {
        expect(seen().answer).toMatchObject({
          ok: false,
          code: "managed_execution_ended",
          nextAction: "relaunch_execution",
        });
        expect(seen().binding).toMatchObject({ state: "ready", device: AVD });
      });

      test("the next execution reuses the device once it is back", () => {
        expect(seen().next).toMatchObject({ disposition: "reused" });
        expect(seen().nextCall).toBe("ok");
      });
    },
  );

  describe.each(["clean", "crash"] as const)("%s restart while the binding is settling", (kind) => {
    const seen = observed(async () => {
      const execution = await started();
      callInFlight(execution, true);
      await s.idle(300);
      // The runner's own connection ends the execution; its wedged call outlives the drain.
      const released = await s.during(
        s.scenario.daemonMethod(
          "daemon/releaseExecution",
          { sessionId: execution.sessionUuid, livenessOwnerToken: "managed-proxy-1" },
          "runner-side",
        ),
      );
      const settling = await s.binding(key);
      const duringSettling = failureCode(await s.launchExecution());
      await s.endDaemon(kind);
      await s.startSuccessor();
      const next = await s.launchExecution();
      return {
        released: released.result,
        settling,
        duringSettling,
        successorPid: s.daemonPid,
        next: next.result.bindings[0],
        nextSession: next.sessionUuid,
        bindingAtEnd: await s.binding(key),
        nextCall: await s.controlCall(next),
      };
    });

    test("before the restart the binding is settling and refuses the next execution", () => {
      expect(seen().released).toMatchObject({ outcome: "cleanup_pending" });
      expect(seen().settling).toMatchObject({
        state: "settling",
        owner: null,
        openJournal: ["release:intent"],
      });
      expect(seen().duringSettling).toBe("binding_settling");
    });

    test("the successor returns it to ready and the next execution reuses it", () => {
      const { successorPid, next, nextSession, bindingAtEnd, nextCall } = seen();
      expect(next).toMatchObject({ disposition: "reused" });
      expect(bindingAtEnd).toMatchObject({
        state: "ready",
        settlerPid: null,
        openJournal: [],
        owner: { pid: successorPid, sessionUuid: nextSession },
      });
      expect(nextCall).toBe("ok");
    });
  });

  describe.each(["before-bind", "after-bind"] as const)(
    "crash with an acquisition in flight (%s)",
    (where) => {
      const seen = observed(async () => {
        s = await ManagedRestartScenario.start();
        key = await s.assignBinding(DEVICE);
        let reached = false;
        const hang = (): Promise<void> => {
          reached = true;
          return new Promise<void>(() => {});
        };
        s.beforeProvision = where === "before-bind" ? hang : undefined;
        s.afterProvisionBind = where === "after-bind" ? hang : undefined;
        const pending = s.beginExecution();
        for (let step = 0; step < 40 && !reached; step++) {
          await s.idle(50);
        }
        const leftover = s.provisioned[0]?.sessionUuid;
        await s.endDaemon("crash");
        await s.startSuccessor();
        s.beforeProvision = undefined;
        s.afterProvisionBind = undefined;
        await s.idle(200);
        const interrupted = pending.state.result?.failure;
        const retry = await s.launchExecution();
        return {
          reached,
          interrupted,
          successorPid: s.daemonPid,
          retry: retry.result.bindings[0],
          retrySession: retry.sessionUuid,
          retryCall: await s.controlCall(retry),
          binding: await s.binding(key),
          // The session the dead acquisition had minted, if it got that far.
          leftoverSession: leftover ? s.scenario.daemon.manager.getSession(leftover) : null,
        };
      });

      test("the interrupted acquisition is answered retryable", () => {
        expect(seen().reached).toBe(true);
        expect(seen().interrupted).toMatchObject({ code: "daemon_unavailable", retryable: true });
      });

      test("the retry takes the binding over the leftover reservation", () => {
        const { successorPid, retry, retrySession, retryCall, binding, leftoverSession } = seen();
        expect(retry).toMatchObject({ disposition: "reused" });
        expect(retryCall).toBe("ok");
        expect(binding).toMatchObject({ owner: { pid: successorPid, sessionUuid: retrySession } });
        // The binding won over the dead acquisition's reservation: its session is gone.
        expect(leftoverSession).toBeNull();
      });
    },
  );

  describe("two restarts in a row", () => {
    const seen = observed(async () => {
      const execution = await started();
      s.restart.ownerAway(execution.connection);
      await s.endDaemon("crash");
      await s.startSuccessor();
      await s.restart.idleUntilSinceRestart(5_000);
      await s.endDaemon("clean");
      await s.startSuccessor();
      await s.restart.idleUntilSinceRestart(8_000);
      s.restart.ownerReturns(execution.connection);
      const call = await s.controlCall(execution);
      const held = await s.binding(key);
      await s.during(execution.proxy.close());
      for (let step = 0; step < 8; step++) {
        await s.idle(250);
      }
      const ended = await s.binding(key);
      const next = await s.launchExecution();
      return {
        session: execution.sessionUuid,
        secondSuccessorPid: s.daemonPid,
        call,
        held,
        ended,
        next: next.result.bindings[0],
      };
    });

    test("the execution is served and owned by the second successor", () => {
      const { session, secondSuccessorPid, call, held } = seen();
      expect(call).toBe("ok");
      expect(held).toMatchObject({ owner: { pid: secondSuccessorPid, sessionUuid: session } });
    });

    test("then the execution ends and the next one reuses the device", () => {
      expect(seen().ended).toMatchObject({ state: "ready", owner: null });
      expect(seen().next).toMatchObject({ disposition: "reused" });
    });
  });
});

describe("a restart while a new incarnation waits for the old scope", () => {
  describe("the live execution across the restart", () => {
    const seen = observed(async () => {
      const execution = await started();
      const session = execution.sessionUuid!;
      // The runner's next boot arrives while the old execution is live: the old scope starts
      // retiring and the new incarnation is told to wait.
      const waiting = failureCode(await s.launchExecution(BOOT_2));
      const registry = await s.registry();
      const scopeBefore = (await registry.getScope(key.scopeKey))?.state;
      const dead = s.daemonPid;
      await s.endDaemon("crash");
      await s.startSuccessor();
      // The execution goes on: its proxy re-binds and its calls are served.
      const call = await s.controlCall(execution);
      const live = s.scenario.daemon.manager.isLiveManagedExecutionSession(session);
      const owner = (await s.binding(key))?.owner;
      const scopeAfter = (await registry.getScope(key.scopeKey))?.state;
      const waitingAfter = failureCode(await s.launchExecution(BOOT_2));
      const oldIncarnation = failureCode(await s.launchExecution());
      return {
        session,
        successorPid: s.daemonPid,
        waiting,
        scopeBefore,
        call,
        live,
        deadPidLive: s.livePids.has(dead),
        owner,
        scopeAfter,
        waitingAfter,
        oldIncarnation,
        ownerAtEnd: (await s.binding(key))?.owner,
      };
    });

    test("the new incarnation waits, the scope is invalidating and the execution is served", () => {
      const { waiting, scopeBefore, call, live, deadPidLive } = seen();
      expect({ waiting, scopeBefore, call, live, deadPidLive }).toEqual({
        waiting: "scope_transition_pending",
        scopeBefore: "invalidating",
        call: "ok",
        live: true,
        deadPidLive: false,
      });
    });

    test("the restarted daemon records itself as the live execution's binding owner", () => {
      // docs/using/managed-slots.md, "Hold": "the restarted daemon records itself as the binding's
      // owner". A record still naming the dead daemon would read as ownerless to every other
      // process on the host (the registry is host-wide).
      expect(seen().owner).toEqual({ pid: seen().successorPid, sessionUuid: seen().session });
    });

    test("re-owning does not revive the scope or let anyone else into it", () => {
      // The new incarnation still waits, and a duplicate of the old one is refused.
      const { session, successorPid, scopeAfter, waitingAfter, oldIncarnation, ownerAtEnd } =
        seen();
      expect({ scopeAfter, waitingAfter, oldIncarnation }).toEqual({
        scopeAfter: "invalidating",
        waitingAfter: "scope_transition_pending",
        oldIncarnation: "scope_invalidated",
      });
      expect(ownerAtEnd).toEqual({ pid: successorPid, sessionUuid: session });
    });
  });

  describe("another daemon on the host", () => {
    const seen = observed(async () => {
      const execution = await started();
      const waiting = failureCode(await s.launchExecution(BOOT_2));
      await s.endDaemon("crash");
      await s.startSuccessor();
      const call = await s.controlCall(execution);
      // A peer daemon's handle on the same registry file: it holds none of this daemon's
      // sessions, so it judges an owner record by the recorded process alone.
      const completed = await s.asPeerDaemon((registry) =>
        registry.completeScopeInvalidation(key.scopeKey),
      );
      return {
        waiting,
        call,
        completed: completed.kind,
        callAfter: await s.controlCall(execution),
      };
    });

    test("cannot retire the scope under the live execution", () => {
      expect(seen()).toEqual({
        waiting: "scope_transition_pending",
        call: "ok",
        completed: "pending",
        callAfter: "ok",
      });
    });
  });

  describe("once the live execution ends", () => {
    const seen = observed(async () => {
      const execution = await started();
      const waiting = failureCode(await s.launchExecution(BOOT_2));
      await s.endDaemon("crash");
      await s.startSuccessor();
      const call = await s.controlCall(execution);
      await s.during(execution.proxy.close());
      for (let step = 0; step < 8; step++) {
        await s.idle(250);
      }
      const next = await s.launchExecution(BOOT_2);
      const registry = await s.registry();
      return {
        waiting,
        call,
        oldScope: (await registry.getScope(key.scopeKey))?.state,
        next: next.result.bindings[0],
        nextCall: await s.controlCall(next),
      };
    });

    test("the old scope retires and the waiting incarnation proceeds", () => {
      const { waiting, call, oldScope, next, nextCall } = seen();
      expect({ waiting, call, oldScope, nextCall }).toEqual({
        waiting: "scope_transition_pending",
        call: "ok",
        oldScope: "invalidated",
        nextCall: "ok",
      });
      // The old scope's device went to the free pool, and the new incarnation's binding adopts it.
      expect(next).toMatchObject({ disposition: "adopted", device: { stableId: AVD } });
    });
  });
});
