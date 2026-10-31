import { describe, expect, test } from "bun:test";
import type { DaemonManagerLike } from "../../src/daemon/manager";

/**
 * A {@link DaemonManagerLike} plus the scripting hooks a contract needs to put the
 * implementation into a known daemon state without a process, socket or lock of its own.
 */
export interface ScriptedDaemonManager {
  manager: DaemonManagerLike;
  /** Make `status()` report a live daemon with this pid (true) or no daemon (false). */
  setDaemonRecorded(recorded: boolean): void;
  /** Make a connect probe of the control socket succeed (true) or be refused (false). */
  setSocketReachable(reachable: boolean): void;
  /** Make the daemon startup lock held by a live process (true) or free (false). */
  setStartupLockHeld(held: boolean): void;
  dispose(): void;
}

/**
 * Shared contract for every {@link DaemonManagerLike}: the status, readiness and
 * startup-lock reads that DaemonMcpProxy branches on. Registered for the real
 * DaemonManager (over temp-dir paths and faked process/socket seams) and for
 * FakeDaemonManager, so the fake cannot drift from the real wait semantics (#11868).
 */
export const runDaemonManagerContract = (
  description: string,
  makeScripted: () => ScriptedDaemonManager,
): void => {
  describe(`DaemonManager contract: ${description}`, () => {
    function withScripted<T>(body: (scripted: ScriptedDaemonManager) => Promise<T> | T) {
      return async (): Promise<T> => {
        const scripted = makeScripted();
        try {
          return await body(scripted);
        } finally {
          scripted.dispose();
        }
      };
    }

    test(
      "status reports no running daemon when none is recorded",
      withScripted(async ({ manager, setDaemonRecorded }) => {
        setDaemonRecorded(false);

        expect((await manager.status()).running).toBe(false);
      }),
    );

    test(
      "status reports a running daemon with its pid once one is recorded",
      withScripted(async ({ manager, setDaemonRecorded }) => {
        setDaemonRecorded(true);

        const status = await manager.status();

        expect(status.running).toBe(true);
        expect(typeof status.pid).toBe("number");
      }),
    );

    test(
      "waitForReady resolves true when the socket is connectable",
      withScripted(async ({ manager, setSocketReachable }) => {
        setSocketReachable(true);

        expect(await manager.waitForReady(1000)).toBe(true);
      }),
    );

    test(
      "waitForReady resolves false once the budget is spent with no daemon",
      withScripted(async ({ manager, setSocketReachable }) => {
        setSocketReachable(false);

        expect(await manager.waitForReady(300)).toBe(false);
      }),
    );

    test(
      "waitForReady with no budget is never ready",
      withScripted(async ({ manager, setSocketReachable }) => {
        setSocketReachable(true);

        expect(await manager.waitForReady(0)).toBe(false);
      }),
    );

    test(
      "waitForReady honours an already-aborted signal",
      withScripted(async ({ manager, setSocketReachable }) => {
        setSocketReachable(true);
        const controller = new AbortController();
        controller.abort();

        expect(await manager.waitForReady(1000, { signal: controller.signal })).toBe(false);
      }),
    );

    test(
      "waitForReady gives up when the awaited process is gone",
      withScripted(async ({ manager, setSocketReachable }) => {
        setSocketReachable(false);

        expect(await manager.waitForReady(60_000, { shouldContinueWaiting: () => false })).toBe(
          false,
        );
      }),
    );

    test(
      "isStartupLockHeldByLiveProcess is false when nobody holds the lock",
      withScripted(({ manager, setStartupLockHeld }) => {
        setStartupLockHeld(false);

        expect(manager.isStartupLockHeldByLiveProcess()).toBe(false);
      }),
    );

    test(
      "isStartupLockHeldByLiveProcess is true while a live process holds the lock",
      withScripted(({ manager, setStartupLockHeld }) => {
        setStartupLockHeld(true);

        expect(manager.isStartupLockHeldByLiveProcess()).toBe(true);
      }),
    );

    test(
      "waitForLockHolderReadiness resolves true once the holder published a socket",
      withScripted(async ({ manager, setSocketReachable, setStartupLockHeld }) => {
        setStartupLockHeld(true);
        setSocketReachable(true);

        expect(await manager.waitForLockHolderReadiness(1000)).toBe(true);
      }),
    );

    test(
      "waitForLockHolderReadiness resolves false when no live holder and no socket remain",
      withScripted(async ({ manager, setSocketReachable, setStartupLockHeld }) => {
        setStartupLockHeld(false);
        setSocketReachable(false);

        expect(await manager.waitForLockHolderReadiness(60_000)).toBe(false);
      }),
    );
  });
};
