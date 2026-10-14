import { beforeAll, describe, expect, test } from "bun:test";
import { forbidHostCommands } from "../helpers/hostCommandGuard";
import {
  RestartScenario,
  warmUpRestartScenario,
  type ShutdownKind,
} from "../helpers/restartScenarioHarness";

// One daemon restarting with work in flight, end to end: shutdown release and persistence ->
// restart -> rehydration -> the awaiting-owner window -> the stdio proxy's reconnect and re-claim
// -> the first control call. Each scenario is a real Daemon over the real SQLite repository, the
// real control socket and the real stdio proxy (see restartScenarioHarness.ts). The contracts
// asserted at each step:
// - an ordinary proxy reconnecting inside recovery reclaims its session; after handover a new
//   daemon requires an explicit call naming the session, so a passive return still times out;
// - the device stays held (not lendable, not counted idle) through the window on every inventory
//   surface, and is free right after the window lapses;
// - a control call in flight at shutdown is answered, and what the proxy tells its caller agrees
//   with what the daemon answered.

// Fake-only: nothing here may launch a host or adb command.
forbidHostCommands();

beforeAll(warmUpRestartScenario);

const A = "emulator-5554";
const B = "emulator-5556";
const KINDS: ShutdownKind[] = ["clean", "crash"];

/** Lease 4 s + suspect grace 4 s + one 2 s scan: the latest an unclaimed session is released. */
const RELEASED_BY_MS = 10_000;
/**
 * The instants (seconds after the restart) every surface is read at: the restart itself, each
 * owner-return time, inside the window, the last second before the release and the release.
 */
const MATRIX_SECONDS = [0, 1, 3, 7, 9, 10, 14];
/** The instants an observer session and its viewer are read at, on both sides of the window. */
const OBSERVER_SECONDS = [1, 7, 9, 11, 13];

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
            // What the first daemon left behind: a clean stop releases every session as
            // `daemon-shutdown` (recoverable), a crash writes nothing.
            const leftBehind = await Promise.all(
              sessions.map((session) => run.scenario.repository.getSession(session)),
            );
            expect(
              leftBehind.map((row) => [row?.status, row?.release_reason, row?.released_at_ms]),
            ).toEqual(
              sessions.map(() =>
                kind === "clean" ? ["released", "daemon-shutdown", 3_000] : ["active", null, null],
              ),
            );
            expect(run.scenario.releases.map((release) => release.reason)).toEqual(
              kind === "clean" ? sessions.map(() => "daemon-shutdown") : [],
            );
            await run.startSuccessor();
            const other = run.scenario.addProxy({ token: "another-client" });

            let lapsedAt: number | undefined;
            for (const second of MATRIX_SECONDS) {
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

            // At 7 s recovery has handed over, but the plain proxy's probe reclaims from the
            // successor inside its lease + grace owner window, keeping every session (#12282).
            const returnedInsideRecovery = returnsAtMs === 1_000;
            if (returnedInsideRecovery) {
              expect(lapsedAt).toBeUndefined();
              for (const session of sessions) {
                expect(await run.ownerControlCall(session)).toBe("ok");
              }
              expect(run.scenario.driven.map((ran) => ran.sessionUuid)).toEqual(sessions);
              return;
            }
            if (returnsAtMs === 7_000) {
              expect(lapsedAt).toBeUndefined();
            }
            if (returnsAtMs === undefined) {
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
          for (const second of OBSERVER_SECONDS) {
            await run.idleUntilSinceRestart(second * 1_000);
            // The viewer keeps watching the device: a read, never a hold.
            await settled(run.scenario.daemonToolCallWith({ deviceId: A }, "observe", "viewer"));
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
