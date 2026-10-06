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

function writeContenderEarlyRecord(
  guard: IncumbentOwnerGuard,
  file: { data: PidFileData | null },
): void {
  const contender = earlyRecord(SELF_PID);
  file.data = contender;
  guard.recordContenderEarlyOwner(contender);
}

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
    readProcessGenerationToken: () => undefined,
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
    expect(guard.asSocketOwnerLiveness().getOwnerStatus()).toBe("live");
  });

  test("captures no incumbent when the file already names this process", () => {
    const { guard, file } = makeGuard();
    file.data = record(SELF_PID);

    guard.captureIncumbentBeforeOverwrite();

    expect(guard.hasLiveForeignOwner()).toBe(false);
  });

  test("records a dead committed owner as permission to reclaim its stale socket", () => {
    const { guard, running } = makeGuard();
    running.delete(INCUMBENT_PID);

    guard.captureIncumbentBeforeOverwrite();

    expect(guard.hasLiveForeignOwner()).toBe(false);
    expect(guard.asSocketOwnerLiveness().getOwnerStatus()).toBe("dead");
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

  test("exposes the daemon session ID only for a captured live committed incumbent", () => {
    const { guard, file, running } = makeGuard();
    file.data = { ...record(INCUMBENT_PID), daemonSessionId: "incumbent-daemon-session" };

    guard.captureIncumbentBeforeOverwrite();

    expect(guard.capturedLiveIncumbentDaemonSessionId()).toBe("incumbent-daemon-session");
    running.delete(INCUMBENT_PID);
    expect(guard.capturedLiveIncumbentDaemonSessionId()).toBeUndefined();
  });

  test("P2: restores the captured incumbent record after a refused bind", () => {
    const { guard, file, writes } = makeGuard();

    guard.captureIncumbentBeforeOverwrite();
    // Contender overwrote the file with its own record before refusing the bind.
    writeContenderEarlyRecord(guard, file);

    expect(guard.restoreIncumbentAfterRefusal()).toBe(true);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.pid).toBe(INCUMBENT_PID);
    // status()/`--daemon stop` now read back the live winner, not the dead contender.
    expect(file.data!.pid).toBe(INCUMBENT_PID);
  });

  test("P2: does NOT restore a record for a process that died between capture and refusal", () => {
    const { guard, file, running, writes } = makeGuard();

    guard.captureIncumbentBeforeOverwrite();
    writeContenderEarlyRecord(guard, file);
    running.delete(INCUMBENT_PID);

    expect(guard.restoreIncumbentAfterRefusal()).toBe(false);
    expect(writes).toHaveLength(0);
  });

  test("P2: does not overwrite a replacement that claimed the PID record before restore", () => {
    const { guard, file, writes } = makeGuard();
    const replacement = record(7171);

    guard.captureIncumbentBeforeOverwrite();
    writeContenderEarlyRecord(guard, file);
    // Another daemon completed startup while the refused contender was
    // unwinding. Its committed record is authoritative and must survive.
    file.data = replacement;

    expect(guard.restoreIncumbentAfterRefusal()).toBe(false);
    expect(writes).toHaveLength(0);
    expect(file.data).toBe(replacement);
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
      expect(guard.asSocketOwnerLiveness().getOwnerStatus()).toBe("unknown");
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

    test("does not expose a live contender's uncommitted daemon session ID", () => {
      const { guard, file, running } = makeGuard();
      running.add(CONTENDER_PID);
      file.data = {
        ...earlyRecord(CONTENDER_PID),
        daemonSessionId: "uncommitted-contender-session",
      };

      guard.captureIncumbentBeforeOverwrite();

      expect(guard.capturedLiveIncumbentDaemonSessionId()).toBeUndefined();
    });
  });

  describe("a recycled PID is proof the recorded daemon exited (issue #10108)", () => {
    function tokenRecord(token: string): PidFileData {
      return { ...record(INCUMBENT_PID), processGenerationToken: token };
    }

    test("a record whose generation token differs from the live PID's token reads as dead", () => {
      const { guard, file } = makeGuard({ readProcessGenerationToken: () => "generation-2" });
      file.data = tokenRecord("generation-1");

      guard.captureIncumbentBeforeOverwrite();

      // The PID is alive (an unrelated process holds it) but it is not the daemon.
      expect(guard.hasLiveForeignOwner()).toBe(false);
      expect(guard.asSocketOwnerLiveness().getOwnerStatus()).toBe("dead");
    });

    test("a zone-free Darwin token that differs from the live PID's reads as dead", () => {
      const { guard, file } = makeGuard({
        readProcessGenerationToken: () => "darwin-utc:Tue Oct 6 09:30:00 2026",
      });
      file.data = {
        ...record(INCUMBENT_PID),
        processGenerationTokenUtc: "darwin-utc:Tue Oct 6 07:35:51 2026",
      };

      guard.captureIncumbentBeforeOverwrite();

      expect(guard.asSocketOwnerLiveness().getOwnerStatus()).toBe("dead");
    });

    test("a legacy darwin: token from an older build is incomparable with the live token and reads as live", () => {
      const { guard, file } = makeGuard({
        readProcessGenerationToken: () => "darwin-utc:Tue Oct 6 07:35:51 2026",
      });
      file.data = {
        ...record(INCUMBENT_PID),
        processGenerationToken: "darwin:Tue Oct 6 02:35:51 2026",
      };

      guard.captureIncumbentBeforeOverwrite();

      expect(guard.asSocketOwnerLiveness().getOwnerStatus()).toBe("live");
    });

    test("an identical token still reads as live", () => {
      const { guard, file } = makeGuard({ readProcessGenerationToken: () => "generation-1" });
      file.data = tokenRecord("generation-1");

      guard.captureIncumbentBeforeOverwrite();

      expect(guard.asSocketOwnerLiveness().getOwnerStatus()).toBe("live");
    });

    test("an unreadable live token never downgrades a live PID to dead", () => {
      const { guard, file } = makeGuard({ readProcessGenerationToken: () => undefined });
      file.data = tokenRecord("generation-1");

      guard.captureIncumbentBeforeOverwrite();

      expect(guard.asSocketOwnerLiveness().getOwnerStatus()).toBe("live");
    });

    test("a throwing token reader never downgrades a live PID to dead", () => {
      const { guard, file } = makeGuard({
        readProcessGenerationToken: () => {
          throw new Error("ps unavailable");
        },
      });
      file.data = tokenRecord("generation-1");

      guard.captureIncumbentBeforeOverwrite();

      expect(guard.asSocketOwnerLiveness().getOwnerStatus()).toBe("live");
    });

    test("a record without a recorded token is never compared", () => {
      let reads = 0;
      const { guard } = makeGuard({
        readProcessGenerationToken: () => {
          reads += 1;
          return "generation-2";
        },
      });

      guard.captureIncumbentBeforeOverwrite();

      expect(reads).toBe(0);
      expect(guard.asSocketOwnerLiveness().getOwnerStatus()).toBe("live");
    });

    test("a recycled PID is not restored over a refused contender's record", () => {
      const { guard, file, writes } = makeGuard({
        readProcessGenerationToken: () => "generation-2",
      });
      file.data = tokenRecord("generation-1");

      guard.captureIncumbentBeforeOverwrite();
      writeContenderEarlyRecord(guard, file);

      expect(guard.restoreIncumbentAfterRefusal()).toBe(false);
      expect(writes).toHaveLength(0);
    });
  });

  describe("a dead committed owner's proof survives a failed start (issue #10107)", () => {
    function failedStartLeaves(guard: IncumbentOwnerGuard): PidFileData {
      // What the daemon's early-owner write puts on disk before the bind: this
      // contender's uncommitted record plus whatever proof the guard says to carry.
      const carried = guard.supersededOwnerForEarlyRecord();
      return {
        ...earlyRecord(SELF_PID),
        ...(carried === undefined ? {} : { supersededOwner: carried }),
      };
    }

    function nextStartGuard(
      file: { data: PidFileData | null },
      running: Set<number>,
      readProcessGenerationToken: (pid: number) => string | undefined = () => undefined,
    ): IncumbentOwnerGuard {
      return new IncumbentOwnerGuard({
        readPidFile: () => file.data,
        isProcessRunning: (pid) => running.has(pid),
        readProcessGenerationToken,
        selfPid: 7777,
      });
    }

    test("the next start still reads the socket as reclaimable after a start died pre-bind", () => {
      const { guard, file, running } = makeGuard();
      running.delete(INCUMBENT_PID);
      guard.captureIncumbentBeforeOverwrite();
      // The first start overwrote the dead committed record, then died before binding.
      file.data = failedStartLeaves(guard);
      running.delete(SELF_PID);

      const next = nextStartGuard(file, running);
      next.captureIncumbentBeforeOverwrite();

      expect(next.asSocketOwnerLiveness().getOwnerStatus()).toBe("dead");
    });

    test("without carried proof a dead uncommitted record stays unknown (fails closed)", () => {
      const { guard, file, running } = makeGuard();
      file.data = earlyRecord(5150);

      guard.captureIncumbentBeforeOverwrite();

      expect(running.has(5150)).toBe(false);
      expect(guard.asSocketOwnerLiveness().getOwnerStatus()).toBe("unknown");
      expect(guard.supersededOwnerForEarlyRecord()).toBeUndefined();
    });

    test("the carried proof passes through a second failed start", () => {
      const { guard, file, running } = makeGuard();
      running.delete(INCUMBENT_PID);
      guard.captureIncumbentBeforeOverwrite();
      file.data = failedStartLeaves(guard);
      running.delete(SELF_PID);

      const second = nextStartGuard(file, running);
      second.captureIncumbentBeforeOverwrite();

      expect(second.supersededOwnerForEarlyRecord()).toEqual({ pid: INCUMBENT_PID });
    });

    test("a carried owner whose PID is alive again keeps the socket unreclaimable", () => {
      const { guard, file, running } = makeGuard();
      running.delete(INCUMBENT_PID);
      guard.captureIncumbentBeforeOverwrite();
      file.data = failedStartLeaves(guard);
      running.delete(SELF_PID);
      // The PID is held again and no token proves it is a different generation.
      running.add(INCUMBENT_PID);

      const next = nextStartGuard(file, running);
      next.captureIncumbentBeforeOverwrite();

      expect(next.asSocketOwnerLiveness().getOwnerStatus()).toBe("live");
    });

    test("a carried owner whose PID was recycled by a different generation reads as dead", () => {
      const { guard, file, running } = makeGuard();
      file.data = { ...record(INCUMBENT_PID), processGenerationToken: "generation-1" };
      running.delete(INCUMBENT_PID);
      guard.captureIncumbentBeforeOverwrite();
      file.data = failedStartLeaves(guard);
      running.delete(SELF_PID);
      running.add(INCUMBENT_PID);

      const next = nextStartGuard(file, running, () => "generation-2");
      next.captureIncumbentBeforeOverwrite();

      expect(next.asSocketOwnerLiveness().getOwnerStatus()).toBe("dead");
    });

    test("a carried zone-free Darwin token survives the early record and still proves a recycled PID dead", () => {
      const { guard, file, running } = makeGuard();
      file.data = {
        ...record(INCUMBENT_PID),
        processGenerationTokenUtc: "darwin-utc:Tue Oct 6 07:35:51 2026",
      };
      running.delete(INCUMBENT_PID);
      guard.captureIncumbentBeforeOverwrite();
      const early = failedStartLeaves(guard);
      file.data = early;
      running.delete(SELF_PID);
      running.add(INCUMBENT_PID);

      // Carried under the zone-free field, never the legacy one older builds compare.
      expect(early.supersededOwner).toEqual({
        pid: INCUMBENT_PID,
        processGenerationTokenUtc: "darwin-utc:Tue Oct 6 07:35:51 2026",
      });
      const next = nextStartGuard(file, running, () => "darwin-utc:Tue Oct 6 09:30:00 2026");
      next.captureIncumbentBeforeOverwrite();

      expect(next.asSocketOwnerLiveness().getOwnerStatus()).toBe("dead");
    });

    test("a live contender's carried proof is never trusted (stays latched closed)", () => {
      const { guard, file, running } = makeGuard();
      running.add(5150);
      file.data = { ...earlyRecord(5150), supersededOwner: { pid: INCUMBENT_PID } };
      running.delete(INCUMBENT_PID);

      guard.captureIncumbentBeforeOverwrite();

      expect(guard.asSocketOwnerLiveness().getOwnerStatus()).toBe("unknown");
      expect(guard.supersededOwnerForEarlyRecord()).toBeUndefined();
    });

    test("a malformed carried owner proves nothing", () => {
      const { guard, file } = makeGuard();
      // A hand-edited or corrupt file: JSON.parse hands back whatever is on disk.
      file.data = JSON.parse(
        JSON.stringify({ ...earlyRecord(5150), supersededOwner: { pid: "9001" } }),
      );

      guard.captureIncumbentBeforeOverwrite();

      expect(guard.asSocketOwnerLiveness().getOwnerStatus()).toBe("unknown");
    });

    test("re-capturing this process's own early record keeps the carried proof", () => {
      const { guard, file, running } = makeGuard();
      running.delete(INCUMBENT_PID);
      guard.captureIncumbentBeforeOverwrite();
      file.data = failedStartLeaves(guard);

      guard.captureIncumbentBeforeOverwrite();

      expect(guard.supersededOwnerForEarlyRecord()).toEqual({ pid: INCUMBENT_PID });
    });
  });
});
