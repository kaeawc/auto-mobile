import { describe, expect } from "bun:test";
import { DaemonShuttingDownError } from "../../src/daemon/client";
import { RestartScenario, type ShutdownKind } from "../helpers/daemonRestartScenario";
import { warmedTests } from "../helpers/warmedTests";

// One daemon restarting with work in flight, end to end:
// shutdown release and persistence -> restart -> rehydration -> the awaiting-owner
// window -> the stdio proxy's reconnect and re-claim -> the first control call. Each scenario is a
// real Daemon over the real SQLite repository, the real control socket and the real stdio proxy
// (see test/helpers/daemonRestartScenario.ts). The contracts asserted at each step:
// - an ordinary proxy reconnecting inside recovery reclaims its session; after handover a new
//   daemon requires an explicit call naming the session, so a passive return still times out;
// - the device stays held (not lendable, not counted idle) through the window on every inventory
//   surface, and is free right after the window lapses;
// - a control call in flight at shutdown is answered, and what the proxy tells its caller agrees
//   with what the daemon answered.

const A = "emulator-5554";
const B = "emulator-5556";
const KINDS: ShutdownKind[] = ["clean", "crash"];

/** Lease 4 s + suspect grace 4 s + one 2 s scan: the latest an unclaimed session is released. */
const RELEASED_BY_MS = 10_000;

interface Outcome {
  result?: unknown;
  error?: unknown;
}

function settled(promise: Promise<unknown>): Promise<Outcome> {
  return promise.then(
    (result) => ({ result }),
    (error: unknown) => ({ error }),
  );
}

/** What the proxy told the caller of a tool call, in words a failed assertion can show. */
function told(outcome: Outcome): string {
  if (outcome.error === undefined) {
    return `result ${JSON.stringify(outcome.result)}`;
  }
  const error = outcome.error;
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

// Every scenario runs once in beforeAll, outside the per-test budget, and again as the measured
// test: the first run of each pays for one-time module work (database template, the Daemon module
// graph) and for the shutdown, rehydration and reconnect paths while they are still cold.
const test = warmedTests(() => {});

describe("restart matrix: owner reconnect x shutdown kind x sessions (no call in flight)", () => {
  for (const kind of KINDS) {
    for (const devices of [[A], [A, B]]) {
      for (const returnsAtMs of [1_000, 7_000, 9_000, undefined]) {
        const name = `${devices.length} session(s), ${kind}, owner ${
          returnsAtMs === undefined ? "never returns" : `returns at ${returnsAtMs / 1_000} s`
        }`;
        test(name, async () => {
          const run = await RestartScenario.start({ devices });
          try {
            const sessions: string[] = [];
            for (const device of devices) {
              sessions.push(await run.scenario.acquire(device));
            }
            await run.idle(3_000);
            run.ownerAway();
            await run.end(kind);
            await run.startSuccessor();
            const other = run.scenario.addProxy({ token: "another-client" });

            let lapsedAt: number | undefined;
            for (let second = 0; second <= 14; second++) {
              await run.idleUntilSinceRestart(second * 1_000);
              if (returnsAtMs === second * 1_000) {
                run.ownerReturns();
              }
              const snapshots = await Promise.all(
                sessions.map((session, index) => run.snapshot(session, devices[index]!)),
              );
              const held = snapshots.filter((snapshot) => snapshot.held).length;
              // Every surface agrees on every device at this instant.
              for (const [index, snapshot] of snapshots.entries()) {
                expect(snapshot.pool).toEqual(
                  snapshot.held
                    ? { status: "busy", sessionId: sessions[index]! }
                    : { status: "idle", sessionId: null },
                );
                expect(snapshot.row?.released).toBe(!snapshot.held);
              }
              expect(snapshots[0]!.stats).toEqual({
                idle: devices.length - held,
                assigned: held,
              });
              expect(await run.availableDevices()).toBe(devices.length - held);
              if (second < 8) {
                // Inside lease + grace the session is the owner's, returned or not.
                expect(held).toBe(sessions.length);
              }
              if (second === 3) {
                // No other client takes the device in the window.
                const taken = await settled(other.callTool("getAndroid", { deviceId: A }));
                expect(Reflect.get(Object(taken.error), "code")).toBe(
                  "device_owned_by_other_session",
                );
              }
              if (held === 0 && lapsedAt === undefined) {
                lapsedAt = second * 1_000;
              }
            }

            // At 7 s recovery has handed over. An ordinary proxy's pinned probe sees the new
            // process and stops: reconnecting alone cannot reclaim before the owner timeout.
            const returnedInsideRecovery = returnsAtMs === 1_000;
            if (returnedInsideRecovery) {
              expect(lapsedAt).toBeUndefined();
              for (const session of sessions) {
                expect(await run.ownerControlCall(session)).toBe("ok");
              }
              expect(run.scenario.driven.map((ran) => ran.sessionUuid)).toEqual(sessions);
              return;
            }
            if (returnsAtMs === undefined || returnsAtMs === 7_000) {
              expect(lapsedAt).toBe(RELEASED_BY_MS);
            }
            run.ownerReturns();
            if (lapsedAt === undefined) {
              // A return between grace and the scan revived it: then the owner's call must work.
              for (const session of sessions) {
                expect(await run.ownerControlCall(session)).toBe("ok");
              }
              return;
            }
            expect(lapsedAt).toBeLessThanOrEqual(RELEASED_BY_MS);
            for (const [index, session] of sessions.entries()) {
              const row = await run.scenario.repository.getSession(session);
              expect(row?.release_reason).toBe("rehydration-owner-timeout");
              // The proxy agrees with the daemon: terminal for this session, nothing driven.
              expect(await run.ownerControlCall(session)).toMatch(/^threw: Daemon(Session|Bound)/);
              // The device is free right after the window lapses.
              const taken = await settled(
                other.callTool("getAndroid", { deviceId: devices[index]! }),
              );
              expect(told(taken)).toMatch(/^result /);
            }
            expect(run.scenario.driven).toEqual([]);
          } finally {
            await run.stop();
          }
        });
      }
    }
  }
});

describe("restart matrix: a plan's derived label session, an observer and a viewer", () => {
  for (const kind of KINDS) {
    test(`plan label, ${kind}: the label does not come back, its device is free at once, the base does, the next run mints the label`, async () => {
      const run = await RestartScenario.start({ devices: [A, B] });
      try {
        const base = await run.scenario.acquire(A);
        const label = `${base}:B`;
        const mint = async (): Promise<void> => {
          const { manager, pool } = run.scenario.daemon;
          const close = manager.openPlanLabelMints(base, { A: base, B: label });
          try {
            await pool.bindOrReuseDeviceSession(
              label,
              B,
              "android",
              undefined,
              undefined,
              undefined,
              false,
              undefined,
              undefined,
              undefined,
              run.scenario.proxyConnection,
            );
          } finally {
            close();
          }
        };
        await mint();
        await run.idle(3_000);
        await run.end(kind);
        await run.startSuccessor();

        for (const second of [0, 1, 5]) {
          await run.idleUntilSinceRestart(second * 1_000);
          const labelSide = await run.snapshot(label, B);
          expect(labelSide.held).toBe(false);
          expect(labelSide.pool).toEqual({ status: "idle", sessionId: null });
          expect(labelSide.row?.released).toBe(true);
          expect((await run.snapshot(base, A)).held).toBe(true);
          expect(labelSide.stats).toEqual({ idle: 1, assigned: 1 });
          expect(await run.availableDevices()).toBe(1);
        }
        expect(await run.ownerControlCall(label)).toContain("session_ownership_lost");
        expect(await run.ownerControlCall(base)).toBe("ok");
        await mint();
        expect((await run.snapshot(label, B)).held).toBe(true);
      } finally {
        await run.stop();
      }
    });

    for (const desktop of ["keeps heartbeating", "is gone"] as const) {
      test(`observer session, ${kind}: desktop ${desktop}; a viewer's reads never hold it`, async () => {
        const run = await RestartScenario.start({ devices: [A] });
        try {
          const session = await run.scenario.acquireTokenless(A);
          const before = run.scenario.startTokenlessHeartbeats(session);
          await run.idle(3_000);
          before.stop();
          await run.end(kind);
          await run.startSuccessor();
          const after =
            desktop === "keeps heartbeating"
              ? run.scenario.startTokenlessHeartbeats(session)
              : undefined;
          for (let second = 1; second <= 13; second++) {
            await run.idleUntilSinceRestart(second * 1_000);
            // The viewer watches the device through the window and past its end: a read, never a
            // hold. Every third second, because each read is a full daemon tool call (~1 ms) and
            // one a second put this test over its time budget.
            if (second % 3 === 1) {
              await settled(run.scenario.daemonToolCallWith({ deviceId: A }, "observe", "viewer"));
            }
            const snapshot = await run.snapshot(session, A);
            expect(snapshot.pool.status).toBe(snapshot.held ? "busy" : "idle");
            if (second < 8 || after) {
              expect(snapshot.held).toBe(true);
            }
            if (second > 10 && !after) {
              expect(snapshot.row?.reason).toBe("rehydration-owner-timeout");
            }
          }
          after?.stop();
        } finally {
          await run.stop();
        }
      });
    }
  }
});

describe("restart matrix: a control call in flight when the daemon stops", () => {
  // `Daemon.stop()` first waits up to 1 s for in-flight socket requests to finish (quiesce), then
  // releases the sessions, then waits up to 1 s more before it answers what is still in flight
  // with `daemon_shutting_down` and `requestMayHaveDispatched`. A call that finishes inside those
  // waits is answered with its own result.

  /** The stdio proxy's keeper ticks every 2 s from the first acquisition at t=0. */
  const callThatFinishesInTheDrain = async (
    shutdownAtMs: number,
  ): Promise<{ outcome: Outcome; ranOnDevice: number; sessionLive: boolean }> => {
    const run = await RestartScenario.start();
    try {
      const session = await run.scenario.acquire(A);
      await run.idle(shutdownAtMs - 100);
      const call = run.scenario.startLongCall(session);
      await run.idle(100);
      // The device work ends 700 ms into the shutdown, inside the 1 s quiesce drain.
      run.timer.setTimeout(() => void call.settle(), 700);
      await run.cleanShutdown();
      const outcome = await settled(call.done);
      await run.startSuccessor();
      await run.idle(3_000);
      return {
        outcome,
        ranOnDevice: run.scenario.driven.length,
        sessionLive: run.scenario.isHeld(session),
      };
    } finally {
      await run.stop();
    }
  };

  test("control: no keeper tick falls in the drain, and the call is answered with its result", async () => {
    // Shutdown at 2.1 s: the drain runs 2.1-3.1 s, between the keeper ticks at 2 s and 4 s.
    const { outcome, ranOnDevice, sessionLive } = await callThatFinishesInTheDrain(2_100);

    expect(told(outcome)).toMatch(/^result /);
    expect(ranOnDevice).toBe(1);
    expect(sessionLive).toBe(true);
  });

  test("a keeper heartbeat refused as shutting down must not cut the proxy's own in-flight call", async () => {
    // Shutdown at 3.5 s: the keeper tick at 4 s lands in the drain, after the `daemon-shutdown`
    // release, and would be answered `daemon_shutting_down`. Either way the proxy must leave its
    // one daemon connection open for the control call still in flight on it, which the daemon
    // answers with its result 200 ms later (daemonMcpProxy.ts drainingToolCalls).
    const { outcome, ranOnDevice, sessionLive } = await callThatFinishesInTheDrain(3_500);

    expect(ranOnDevice).toBe(1);
    expect(sessionLive).toBe(true);
    // Not "DaemonToolOutcomeUnknownError ... (Socket connection closed)" for a step that ran and
    // that the daemon was about to answer.
    expect(told(outcome)).toMatch(/^result /);
  });

  test("a call still running when the socket closes is told daemon_shutting_down, as the daemon answered it", async () => {
    const run = await RestartScenario.start();
    try {
      const session = await run.scenario.acquire(A);
      await run.idle(3_850);
      // The device command ignores the shutdown's cancel: it is still in flight at the close.
      const call = run.scenario.startLongCall(session, "homeScreen", { wedged: true });
      // The keeper's frames are lost on the way, so only the daemon's own answer reaches the proxy.
      run.scenario.dropHeartbeats = true;
      await run.idle(100);
      const frames: string[] = [];
      const clients = Reflect.get(run.scenario, "proxyClients") as Map<
        string,
        { liveSocket?: { on(event: "data", listener: (data: Buffer) => void): unknown } }
      >;
      clients
        .get(run.scenario.proxyConnection)
        ?.liveSocket?.on("data", (data) => frames.push(data.toString("utf8")));

      await run.cleanShutdown();
      const outcome = await settled(call.done);
      await call.settle();

      // The daemon answered the call itself, typed and retryable.
      const answer = frames.find((frame) => frame.includes('"daemon_shutting_down"'));
      expect(answer).toContain('"retryable":true');
      expect(answer).toContain('"requestMayHaveDispatched":true');
      // The proxy hands that answer on as it is, never as the untyped DaemonToolOutcomeUnknownError,
      // so the stdio server produces its typed `daemon_shutting_down` result (proxyServer.ts
      // daemonShuttingDownResult) for a control call too. The call is not sent again.
      expect(told(outcome)).toMatch(/^DaemonShuttingDownError/);
      expect(outcome.error).toBeInstanceOf(DaemonShuttingDownError);
      expect(Reflect.get(Object(outcome.error), "requestMayHaveDispatched")).toBe(true);
      expect(run.scenario.driven.map((ran) => ran.name)).toEqual(["homeScreen"]);
    } finally {
      await run.stop();
    }
  });

  test("crash: the call's outcome is unknown, the session comes back, and the owner's retry runs the step again", async () => {
    const run = await RestartScenario.start();
    try {
      const session = await run.scenario.acquire(A);
      await run.idle(3_000);
      const call = run.scenario.startLongCall(session);
      await run.idle(1_500);
      expect(run.scenario.driven.map((ran) => ran.name)).toEqual(["homeScreen"]);
      run.crash();
      const outcome = await settled(call.done);
      await call.settle();
      await run.startSuccessor();
      await run.idle(1_000);

      expect(told(outcome)).toMatch(/^DaemonToolOutcomeUnknownError/);
      expect(run.scenario.isHeld(session)).toBe(true);
      // Nothing dedupes the retry: what happens is a second execution of the same step.
      expect(await run.ownerControlCall(session)).toBe("ok");
      expect(run.scenario.driven.map((ran) => ran.name)).toEqual(["homeScreen", "homeScreen"]);
    } finally {
      await run.stop();
    }
  });
});
