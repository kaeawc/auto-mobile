import { describe, expect, test } from "bun:test";
import { runStartupPrologue, type StartupPrologueSteps } from "../../src/daemon/startupPrologue";

/**
 * Fake prologue steps that record the exact order their methods run in, with no
 * real PID-file write or DB. Exercises the #2871 invariant — writeEarlyOwnerRecord
 * (which publishes dbPath) must run BEFORE initializeDatabase opens the DB —
 * directly, without Daemon.start()'s process side effects (chdir, lifecycle
 * handlers). Each step also records whether the previous one had already resolved.
 */
function recordingSteps(): { steps: StartupPrologueSteps; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    steps: {
      writeEarlyOwnerRecord: async () => {
        calls.push("writeEarlyOwnerRecord");
      },
      initializeDatabase: async () => {
        calls.push("initializeDatabase");
      },
    },
  };
}

describe("runStartupPrologue", () => {
  test("publishes the early owner record BEFORE opening the DB (#2871)", async () => {
    const { steps, calls } = recordingSteps();

    await runStartupPrologue(steps);

    expect(calls).toEqual(["writeEarlyOwnerRecord", "initializeDatabase"]);
  });

  test("awaits the owner-record write to settle before the DB touch", async () => {
    const calls: string[] = [];
    let earlyOwnerResolved = false;

    await runStartupPrologue({
      writeEarlyOwnerRecord: async () => {
        // Defer resolution a microtask so a non-awaiting caller would let
        // initializeDatabase start first; the seam must serialize them.
        await Promise.resolve();
        earlyOwnerResolved = true;
        calls.push("writeEarlyOwnerRecord");
      },
      initializeDatabase: async () => {
        expect(earlyOwnerResolved).toBe(true);
        calls.push("initializeDatabase");
      },
    });

    expect(calls).toEqual(["writeEarlyOwnerRecord", "initializeDatabase"]);
  });

  test("does not open the DB when the early owner record fails", async () => {
    const calls: string[] = [];
    const failure = new Error("owner record write failed");

    await expect(
      runStartupPrologue({
        writeEarlyOwnerRecord: async () => {
          calls.push("writeEarlyOwnerRecord");
          throw failure;
        },
        initializeDatabase: async () => {
          calls.push("initializeDatabase");
        },
      }),
    ).rejects.toBe(failure);

    // The DB is never touched if we could not publish the owned path first.
    expect(calls).toEqual(["writeEarlyOwnerRecord"]);
  });
});
