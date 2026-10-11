import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { SlotKey } from "../../../src/daemon/managedSlots/slotRegistry";
import { ManagedRestartScenario, SCOPE, type ManagedExecution } from "./managedRestartScenario";

// A managed slot execution across a daemon restart, end to end (#11642 item 1). See
// managedRestartScenario.ts for what is real (the Daemon, its managed-slot wiring, the SQLite slot
// registry, the session repository, the control socket, the stdio proxy and the proxy MCP server)
// and what is the device boundary.
//
// Controls: {execution idle, settling, acquisition in flight} x {clean shutdown, crash} x {owner
// back at 1 s / 9 s / never} x {device still running, device gone}, and two restarts in a row.
// The last block is the restart while the runner's next incarnation waits for the old scope: the
// scope is `invalidating`, and the successor must still record itself as the live execution's
// slot owner so that no other daemon on the host retires the scope under it.

const DEVICE = "emulator-5554";
const AVD = `Pixel_${DEVICE}`;
const BOOT_2 = { ...SCOPE, runnerIncarnation: "boot-2" };

let s: ManagedRestartScenario;
let key: SlotKey;

async function started(): Promise<ManagedExecution> {
  s = await ManagedRestartScenario.start();
  key = await s.assignSlot(DEVICE);
  const execution = await s.launchExecution();
  expect(execution.result.slots[0]).toMatchObject({ disposition: "reused" });
  expect(await s.controlCall(execution)).toBe("ok");
  return execution;
}

function failureCode(execution: ManagedExecution): string | undefined {
  return execution.result.failure?.code ?? execution.result.slots[0]?.failure?.code;
}

/** The execution's tool call, left in flight at the device boundary until the daemon stops it. */
function callInFlight(execution: ManagedExecution, wedged = false): AbortController {
  const abort = new AbortController();
  const gates = Reflect.get(s.scenario, "gates") as Map<string, unknown>;
  gates.set(execution.sessionUuid!, { opened: new Promise<void>(() => {}), wedged });
  void execution
    .callTool(
      {
        method: "tools/call",
        params: { name: "tapOn", arguments: { sessionUuid: execution.sessionUuid } },
      },
      {
        signal: abort.signal,
        requestId: 2,
        sendNotification: async () => {},
        sendRequest: async () => ({}),
      },
    )
    .catch(() => undefined);
  return abort;
}

// One execution across one restart before any test: beforeAll is outside the per-test budget, and
// the first row would otherwise pay the one-time module work (daemon, socket, proxy, registry).
beforeAll(async () => {
  const execution = await started();
  s.restart.ownerAway(execution.connection);
  await s.endDaemon("crash");
  await s.startSuccessor();
  s.restart.ownerReturns(execution.connection);
  await s.controlCall(execution);
  await s.stop();
});

afterEach(async () => {
  await s?.stop();
});

describe("controls: a live managed execution across a daemon restart", () => {
  test.each([
    ["clean", 1_000],
    ["clean", 9_000],
    ["crash", 1_000],
    ["crash", 9_000],
  ] as const)(
    "%s restart, owner back after %i ms: same session, slot re-owned by the successor",
    async (kind, backAfterMs) => {
      const execution = await started();
      const session = execution.sessionUuid!;
      s.restart.ownerAway(execution.connection);
      await s.endDaemon(kind);
      await s.startSuccessor();

      // Rehydrated and re-owned before any client can arrive: the dead daemon's PID is gone.
      expect(await s.slot(key)).toMatchObject({
        state: "ready",
        device: AVD,
        owner: { pid: s.daemonPid, sessionUuid: session },
      });
      // A duplicate proxy for the slot is refused while the execution awaits its owner.
      await s.restart.idleUntilSinceRestart(backAfterMs / 2);
      expect(failureCode(await s.launchExecution())).toBe("slot_in_use");

      await s.restart.idleUntilSinceRestart(backAfterMs);
      s.restart.ownerReturns(execution.connection);
      expect(await s.controlCall(execution)).toBe("ok");
      await s.idle(15_000);
      expect(await s.controlCall(execution)).toBe("ok");
      const snapshot = await s.restart.snapshot(session, DEVICE);
      expect(snapshot).toMatchObject({
        held: true,
        pool: { status: "busy", sessionId: session },
        stats: { idle: 0, assigned: 1 },
        row: { released: false },
      });
      expect(await s.restart.availableDevices()).toBe(0);
      expect(s.scenario.releases.filter((r) => r.reason !== "daemon-shutdown")).toEqual([]);
    },
  );

  test.each(["clean", "crash"] as const)(
    "%s restart, owner never back: released once, the next execution reuses the device, the old proxy is told to relaunch",
    async (kind) => {
      const execution = await started();
      const session = execution.sessionUuid!;
      s.restart.ownerAway(execution.connection);
      await s.endDaemon(kind);
      await s.startSuccessor();
      await s.restart.idleUntilSinceRestart(12_000);
      await s.idle(0);

      expect(await s.slot(key)).toMatchObject({ state: "ready", device: AVD, owner: null });
      expect(await s.restart.snapshot(session, DEVICE)).toMatchObject({
        held: false,
        pool: { status: "idle", sessionId: null },
        row: { released: true, reason: "rehydration-owner-timeout" },
      });
      // Idle, but assigned to its slot: never generic capacity.
      expect(await s.restart.availableDevices()).toBe(0);
      expect(
        s.scenario.releases.filter((r) => r.reason === "rehydration-owner-timeout"),
      ).toHaveLength(1);

      const next = await s.launchExecution();
      expect(next.result.slots[0]).toMatchObject({ disposition: "reused" });
      expect(next.sessionUuid).not.toBe(session);
      s.restart.ownerReturns(execution.connection);
      expect(await s.call(execution)).toMatchObject({
        ok: false,
        code: "managed_execution_ended",
        nextAction: "relaunch_execution",
      });
      expect(await s.controlCall(next)).toBe("ok");
      expect(await s.slot(key)).toMatchObject({
        owner: { pid: s.daemonPid, sessionUuid: next.sessionUuid },
      });
    },
  );

  test.each(["clean", "crash"] as const)(
    "%s restart with the slot's device gone: the execution ends typed and the slot keeps its device",
    async (kind) => {
      const execution = await started();
      s.restart.ownerAway(execution.connection);
      await s.endDaemon(kind);
      s.setRunning(DEVICE, false);
      await s.startSuccessor();
      await s.restart.idleUntilSinceRestart(1_000);
      s.restart.ownerReturns(execution.connection);

      expect(await s.call(execution)).toMatchObject({
        ok: false,
        code: "managed_execution_ended",
        nextAction: "relaunch_execution",
      });
      expect(await s.slot(key)).toMatchObject({ state: "ready", device: AVD });
      s.setRunning(DEVICE, true);
      const next = await s.launchExecution();
      expect(next.result.slots[0]).toMatchObject({ disposition: "reused" });
      expect(await s.controlCall(next)).toBe("ok");
    },
  );

  test.each(["clean", "crash"] as const)(
    "%s restart while the slot is settling: the successor returns it to ready and the next execution reuses it",
    async (kind) => {
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
      expect(released.result).toMatchObject({ outcome: "cleanup_pending" });
      expect(await s.slot(key)).toMatchObject({
        state: "settling",
        owner: null,
        openJournal: ["release:intent"],
      });
      expect(failureCode(await s.launchExecution())).toBe("slot_settling");

      await s.endDaemon(kind);
      await s.startSuccessor();
      const next = await s.launchExecution();

      expect(next.result.slots[0]).toMatchObject({ disposition: "reused" });
      expect(await s.slot(key)).toMatchObject({
        state: "ready",
        settlerPid: null,
        openJournal: [],
        owner: { pid: s.daemonPid, sessionUuid: next.sessionUuid },
      });
      expect(await s.controlCall(next)).toBe("ok");
    },
  );

  test.each(["before-bind", "after-bind"] as const)(
    "crash with an acquisition in flight (%s): the retry takes the slot over the leftover reservation",
    async (where) => {
      s = await ManagedRestartScenario.start();
      key = await s.assignSlot(DEVICE);
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
      expect(reached).toBe(true);
      const leftover = s.provisioned[0]?.sessionUuid;
      await s.endDaemon("crash");
      await s.startSuccessor();
      s.beforeProvision = undefined;
      s.afterProvisionBind = undefined;
      await s.idle(200);

      expect(pending.state.result?.failure).toMatchObject({
        code: "daemon_unavailable",
        retryable: true,
      });
      const retry = await s.launchExecution();
      expect(retry.result.slots[0]).toMatchObject({ disposition: "reused" });
      expect(await s.controlCall(retry)).toBe("ok");
      expect(await s.slot(key)).toMatchObject({
        owner: { pid: s.daemonPid, sessionUuid: retry.sessionUuid },
      });
      if (leftover) {
        // The session the dead acquisition had minted is gone: the slot won over its reservation.
        expect(s.scenario.daemon.manager.getSession(leftover)).toBeNull();
      }
    },
  );

  test("two restarts in a row, then the execution ends and the next one reuses the device", async () => {
    const execution = await started();
    s.restart.ownerAway(execution.connection);
    await s.endDaemon("crash");
    await s.startSuccessor();
    await s.restart.idleUntilSinceRestart(5_000);
    await s.endDaemon("clean");
    await s.startSuccessor();
    await s.restart.idleUntilSinceRestart(8_000);
    s.restart.ownerReturns(execution.connection);

    expect(await s.controlCall(execution)).toBe("ok");
    expect(await s.slot(key)).toMatchObject({
      owner: { pid: s.daemonPid, sessionUuid: execution.sessionUuid },
    });
    await s.during(execution.proxy.close());
    for (let step = 0; step < 8; step++) {
      await s.idle(250);
    }
    expect(await s.slot(key)).toMatchObject({ state: "ready", owner: null });
    const next = await s.launchExecution();
    expect(next.result.slots[0]).toMatchObject({ disposition: "reused" });
  });
});

describe("a restart while a new incarnation waits for the old scope", () => {
  test("the restarted daemon records itself as the live execution's slot owner", async () => {
    const execution = await started();
    const session = execution.sessionUuid!;
    // The runner's next boot arrives while the old execution is live: the old scope starts
    // retiring and the new incarnation is told to wait.
    expect(failureCode(await s.launchExecution(BOOT_2))).toBe("scope_transition_pending");
    const registry = await s.registry();
    expect(await registry.getScope(key.scopeKey)).toMatchObject({ state: "invalidating" });
    const dead = s.daemonPid;

    await s.endDaemon("crash");
    await s.startSuccessor();
    // The execution goes on: its proxy re-binds and its calls are served.
    expect(await s.controlCall(execution)).toBe("ok");
    expect(s.scenario.daemon.manager.isLiveManagedExecutionSession(session)).toBe(true);
    expect(s.livePids.has(dead)).toBe(false);

    // docs/using/managed-slots.md, "Hold": "the restarted daemon records itself as the slot's
    // owner". A record still naming the dead daemon would read as ownerless to every other
    // process on the host (the registry is host-wide).
    expect((await s.slot(key))?.owner).toEqual({ pid: s.daemonPid, sessionUuid: session });
    // Re-owning does not revive the scope: the new incarnation still waits, and a duplicate of
    // the old one is not let into the retiring scope either.
    expect(await registry.getScope(key.scopeKey)).toMatchObject({ state: "invalidating" });
    expect(failureCode(await s.launchExecution(BOOT_2))).toBe("scope_transition_pending");
    expect(failureCode(await s.launchExecution())).toBe("scope_invalidated");
    expect((await s.slot(key))?.owner).toEqual({ pid: s.daemonPid, sessionUuid: session });
  });

  test("once the live execution ends the old scope retires and the waiting incarnation proceeds", async () => {
    const execution = await started();
    expect(failureCode(await s.launchExecution(BOOT_2))).toBe("scope_transition_pending");
    await s.endDaemon("crash");
    await s.startSuccessor();
    expect(await s.controlCall(execution)).toBe("ok");

    await s.during(execution.proxy.close());
    for (let step = 0; step < 8; step++) {
      await s.idle(250);
    }
    const next = await s.launchExecution(BOOT_2);

    const registry = await s.registry();
    expect(await registry.getScope(key.scopeKey)).toMatchObject({ state: "invalidated" });
    // The old scope's device went to the free pool, and the new incarnation's slot adopts it.
    expect(next.result.slots[0]).toMatchObject({
      disposition: "adopted",
      device: { stableId: AVD },
    });
    expect(await s.controlCall(next)).toBe("ok");
  });

  test("another daemon on the host cannot retire the scope under the live execution", async () => {
    const execution = await started();
    expect(failureCode(await s.launchExecution(BOOT_2))).toBe("scope_transition_pending");
    await s.endDaemon("crash");
    await s.startSuccessor();
    expect(await s.controlCall(execution)).toBe("ok");

    // A peer daemon's handle on the same registry file: it holds none of this daemon's sessions,
    // so it judges an owner record by the recorded process alone.
    const completed = await s.asPeerDaemon((registry) =>
      registry.completeScopeInvalidation(key.scopeKey),
    );

    expect(completed.kind).toBe("pending");
    expect(await s.controlCall(execution)).toBe("ok");
  });
});
