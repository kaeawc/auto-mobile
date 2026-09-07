import { describe, expect, test } from "bun:test";
import {
  IncumbentOwnerGuard,
  type IncumbentOwnerGuardDeps,
} from "../../src/daemon/incumbentOwnerGuard";
import type { PidFileData } from "../../src/daemon/types";

/**
 * {@link IncumbentOwnerGuard} preserves a live incumbent daemon's PID record
 * across a hand-launched contender's early-owner overwrite (issue #6232, the
 * #6140 socket-brick family). Every seam is injected so no test touches the real
 * `~/.auto-mobile` PID path.
 */
/**
 * A COMMITTED owner record: what a real incumbent daemon leaves after it has
 * bound the socket. Only such a record carries build identity
 * (`entryScript`/`buildId`), which is how the guard tells the true owner apart
 * from another hand-launched contender's pre-bind early record (issue #6232).
 */
function record(pid: number): PidFileData {
  return {
    pid,
    socketPath: "/tmp/daemon.sock",
    port: 8080,
    startedAt: 0,
    version: "test",
    entryScript: "/opt/auto-mobile/index.js",
    buildId: "deadbeefcafef00d",
  };
}

/**
 * A pre-bind EARLY owner record (issue #2871): no build identity. Written by a
 * contender still in startup that has NOT bound the socket — it is not proof of
 * who owns the socket.
 */
function earlyRecord(pid: number): PidFileData {
  return { pid, socketPath: "/tmp/daemon.sock", port: 8080, startedAt: 0, version: "test" };
}

const SELF_PID = 4242;
const INCUMBENT_PID = 9001;

function makeGuard(overrides: Partial<IncumbentOwnerGuardDeps> = {}): {
  guard: IncumbentOwnerGuard;
  file: { data: PidFileData | null };
  running: Set<number>;
  writes: PidFileData[];
} {
  // A mutable "PID file" and a "process table" the test drives directly.
  const file: { data: PidFileData | null } = { data: record(INCUMBENT_PID) };
  const running = new Set<number>([SELF_PID, INCUMBENT_PID]);
  const writes: PidFileData[] = [];
  const guard = new IncumbentOwnerGuard({
    readPidFile: () => file.data,
    persistPidFile: (data) => {
      writes.push(data);
      file.data = data;
    },
    isProcessRunning: (pid) => running.has(pid),
    selfPid: SELF_PID,
    ...overrides,
  });
  return { guard, file, running, writes };
}

describe("IncumbentOwnerGuard (issue #6232)", () => {
  test("P1: liveness reads the captured snapshot, not the self-overwritten file", () => {
    const { guard, file } = makeGuard();

    guard.captureIncumbentBeforeOverwrite();
    // The contender now overwrites the shared PID file with its OWN record — the
    // exact production ordering that made a plain re-read return `pid === self`.
    file.data = record(SELF_PID);

    // Snapshot-backed liveness still sees the live sibling, so the bind guard
    // fails closed on an inconclusive probe instead of unlinking the live socket.
    expect(guard.hasLiveForeignOwner()).toBe(true);
    expect(guard.asSocketOwnerLiveness().hasLiveForeignOwner()).toBe(true);
  });

  test("captures no incumbent when the file already names this process", () => {
    const { guard, file } = makeGuard();
    file.data = record(SELF_PID);

    guard.captureIncumbentBeforeOverwrite();

    expect(guard.hasLiveForeignOwner()).toBe(false);
  });

  test("captures no incumbent when the recorded foreign process is dead (stale socket stays reclaimable)", () => {
    const { guard, running } = makeGuard();
    running.delete(INCUMBENT_PID);

    guard.captureIncumbentBeforeOverwrite();

    expect(guard.hasLiveForeignOwner()).toBe(false);
  });

  test("captures no incumbent when no PID file exists", () => {
    const { guard, file } = makeGuard();
    file.data = null;

    guard.captureIncumbentBeforeOverwrite();

    expect(guard.hasLiveForeignOwner()).toBe(false);
  });

  test("re-checks liveness: a sibling that dies after capture is no longer a live owner", () => {
    const { guard, running } = makeGuard();

    guard.captureIncumbentBeforeOverwrite();
    running.delete(INCUMBENT_PID);

    expect(guard.hasLiveForeignOwner()).toBe(false);
  });

  test("P2: restores the captured incumbent record after a refused bind", () => {
    const { guard, file, writes } = makeGuard();

    guard.captureIncumbentBeforeOverwrite();
    // Contender overwrote the file with its own record before refusing the bind.
    file.data = record(SELF_PID);

    expect(guard.restoreIncumbentAfterRefusal()).toBe(true);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.pid).toBe(INCUMBENT_PID);
    // status()/`--daemon stop` now read back the live winner, not the dead contender.
    expect(file.data!.pid).toBe(INCUMBENT_PID);
  });

  test("P2: does NOT restore a record for a process that died between capture and refusal", () => {
    const { guard, running, writes } = makeGuard();

    guard.captureIncumbentBeforeOverwrite();
    running.delete(INCUMBENT_PID);

    expect(guard.restoreIncumbentAfterRefusal()).toBe(false);
    expect(writes).toHaveLength(0);
  });

  test("restore is a no-op when no live incumbent was captured", () => {
    const { guard, file, writes } = makeGuard();
    file.data = record(SELF_PID);

    guard.captureIncumbentBeforeOverwrite();

    expect(guard.restoreIncumbentAfterRefusal()).toBe(false);
    expect(writes).toHaveLength(0);
  });

  describe("overlapping hand-launched contenders (issue #6232)", () => {
    const CONTENDER_PID = 5150;

    test("P1: fails closed when the captured record is a live contender's EARLY record", () => {
      // The true incumbent's record was already clobbered by another contender's
      // early record before we read it, so the file names a live non-owner.
      const { guard, file, running } = makeGuard();
      running.add(CONTENDER_PID);
      file.data = earlyRecord(CONTENDER_PID);

      guard.captureIncumbentBeforeOverwrite();

      // No committed owner was proven, so the lock-less bind must refuse rather
      // than treat the contender's record as the socket owner.
      expect(guard.hasLiveForeignOwner()).toBe(true);
      expect(guard.asSocketOwnerLiveness().hasLiveForeignOwner()).toBe(true);
    });

    test("P1: stays closed even after the contender exits (its death proves nothing about the winner)", () => {
      const { guard, file, running } = makeGuard();
      running.add(CONTENDER_PID);
      file.data = earlyRecord(CONTENDER_PID);

      guard.captureIncumbentBeforeOverwrite();
      // The contender refuses its own bind and exits; a naive re-check would now
      // read "dead" and authorize unlinking the still-live winner's socket.
      running.delete(CONTENDER_PID);

      expect(guard.hasLiveForeignOwner()).toBe(true);
    });

    test("P2: never restores a contender's EARLY record over the real owner's", () => {
      const { guard, file, running, writes } = makeGuard();
      running.add(CONTENDER_PID);
      file.data = earlyRecord(CONTENDER_PID);

      guard.captureIncumbentBeforeOverwrite();

      // Restoring the contender's PID would clobber the true incumbent's record.
      expect(guard.restoreIncumbentAfterRefusal()).toBe(false);
      expect(writes).toHaveLength(0);
    });
  });
});
