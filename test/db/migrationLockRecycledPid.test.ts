import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FileMigrationLock } from "../../src/db/migrationLock";
import { ActionableError } from "../../src/models/ActionableError";
import { FakeLockOwnerGenerationProbe } from "../fakes/FakeLockOwnerGenerationProbe";
import { FakeTimer } from "../fakes/FakeTimer";
import { drainUntil } from "../helpers/fakeTimerStepping";
import { useScratchRoot } from "../helpers/scratchRoot";

describe("migration lock recycled PID (#11812)", () => {
  const scratch = useScratchRoot("migration-recycled-pid-");

  function fixture(verdict: "same" | "different") {
    const path = join(scratch.next(), "db.migrate.lock");
    const body = "9999\ncrashed-owner\n\nlinux:boot:old";
    writeFileSync(path, body);
    const timer = new FakeTimer();
    const probe = new FakeLockOwnerGenerationProbe();
    probe.verdict = verdict;
    const lock = new FileMigrationLock(path, {
      timer,
      isProcessRunning: () => true,
      ownerGeneration: probe,
      pid: 100,
      ownerToken: "new-owner",
      timeoutMs: 200,
      pollIntervalMs: 100,
    });
    return { path, body, timer, probe, lock };
  }

  test("reclaims a recycled live PID without any sleep", async () => {
    const { lock, timer } = fixture("different");
    const acquired = lock.acquire();
    expect(timer.getSleepHistory()).toEqual([]);
    await acquired;
    await lock.release();
  });

  test("a same-generation live owner waits and times out", async () => {
    const { path, body, lock, timer } = fixture("same");
    const outcome = lock.acquire().catch((error: unknown) => error);
    expect(timer.getSleepHistory()).toEqual([100]);
    timer.advanceTime(100);
    await drainUntil(() => timer.getSleepCallCount() === 2, { description: "second lock poll" });
    expect(timer.getSleepHistory()).toEqual([100, 100]);
    timer.advanceTime(100);
    const error = await outcome;
    expect(error).toBeInstanceOf(ActionableError);
    expect((error as ActionableError).message).toContain("Timed out after 200ms");
    expect(readFileSync(path, "utf-8")).toBe(body);
  });
});
