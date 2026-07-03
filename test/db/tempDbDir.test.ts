import { describe, expect, test } from "bun:test";
import path from "path";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { FakeTimer } from "../fakes/FakeTimer";
import { removeTempDbDir } from "./tempDbDir";

/**
 * Unit tests for the shared bounded temp-dir cleanup helper (issue #2916).
 *
 * The real hazard the helper guards against — bun:sqlite holding a Windows
 * file handle past `destroy()` so `rm` throws EBUSY — cannot be reproduced on
 * macOS/Linux. So instead of a real DB we inject a fake `rm` and a `FakeTimer`
 * and prove the two properties that keep the Windows CI job from stalling:
 *   1. a persistent lock makes the helper GIVE UP (never throws) within a
 *      strictly bounded sleep budget, and
 *   2. it retries transient locks a bounded number of times before giving up.
 * These run with no real filesystem or wall-clock, so they stay <100ms.
 */
describe("removeTempDbDir (issue #2916)", () => {
  function ebusy(code = "EBUSY"): NodeJS.ErrnoException {
    const error = new Error(`${code}: resource busy`) as NodeJS.ErrnoException;
    error.code = code;
    return error;
  }

  test("removes the dir on the first attempt and never sleeps when rm succeeds", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const calls: string[] = [];
    const rm = async (dir: string) => {
      calls.push(dir);
    };

    await removeTempDbDir("/tmp/auto-mobile-x", { rm, timer });

    expect(calls).toEqual(["/tmp/auto-mobile-x"]);
    expect(timer.getSleepCallCount()).toBe(0);
  });

  test("retries a transient EBUSY, then succeeds", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    let attempts = 0;
    const rm = async () => {
      attempts += 1;
      if (attempts < 3) {
        throw ebusy();
      }
    };

    await removeTempDbDir("/tmp/auto-mobile-x", { rm, timer, maxAttempts: 5, delayMs: 50 });

    expect(attempts).toBe(3);
    // One sleep between each of the two failed attempts and the retry.
    expect(timer.getSleepHistory()).toEqual([50, 50]);
  });

  test("gives up WITHOUT throwing after a persistent lock, within a bounded sleep budget", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    let attempts = 0;
    const rm = async () => {
      attempts += 1;
      throw ebusy();
    };
    const gaveUp: Array<{ dir: string; error: unknown }> = [];

    // Must resolve, not reject — a rejected afterEach cleanup would fail the test.
    await removeTempDbDir("/tmp/auto-mobile-locked", {
      rm,
      timer,
      maxAttempts: 5,
      delayMs: 50,
      onGiveUp: (dir, error) => gaveUp.push({ dir, error }),
    });

    expect(attempts).toBe(5);
    // At most (maxAttempts - 1) sleeps, and the total is strictly bounded so the
    // helper can never approach the CI test timeout on a Windows livelock.
    const history = timer.getSleepHistory();
    expect(history.length).toBe(4);
    expect(history.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(200);
    expect(gaveUp.length).toBe(1);
    expect(gaveUp[0].dir).toBe("/tmp/auto-mobile-locked");
    expect((gaveUp[0].error as NodeJS.ErrnoException).code).toBe("EBUSY");
  });

  test.each(["EPERM", "ENOTEMPTY"])(
    "treats %s as a transient Windows lock and gives up gracefully",
    async code => {
      const timer = new FakeTimer();
      timer.enableAutoAdvance();
      const rm = async () => {
        throw ebusy(code);
      };
      let gaveUp = false;

      await removeTempDbDir("/tmp/auto-mobile-x", {
        rm,
        timer,
        maxAttempts: 3,
        delayMs: 10,
        onGiveUp: () => {
          gaveUp = true;
        },
      });

      expect(gaveUp).toBe(true);
    }
  );

  test("removes a real temp dir (and its contents) through the default rm/timer", async () => {
    // Exercises the un-injected happy path: the default `fsRm(..., recursive,
    // force)` closure and the default timer. macOS/Linux release handles
    // immediately, so this resolves on the first attempt.
    const dir = await mkdtemp(path.join(tmpdir(), "auto-mobile-tempdbdir-real-"));
    await writeFile(path.join(dir, "auto-mobile.db"), "not-a-real-db");
    expect(existsSync(dir)).toBe(true);

    await removeTempDbDir(dir);

    expect(existsSync(dir)).toBe(false);
  });

  test("the default onGiveUp runs without throwing when a lock never clears", async () => {
    // Drives the default onGiveUp (logger.warn) branch — omit `onGiveUp` but keep
    // `rm` failing. Must still resolve, never reject.
    const rm = async () => {
      throw ebusy();
    };

    await expect(
      removeTempDbDir("/tmp/auto-mobile-locked", { rm, maxAttempts: 2, delayMs: 1 })
    ).resolves.toBeUndefined();
  });

  test("rethrows an unexpected (non-lock) error code without retrying", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    let attempts = 0;
    const rm = async () => {
      attempts += 1;
      throw ebusy("EACCES");
    };

    await expect(
      removeTempDbDir("/tmp/auto-mobile-x", { rm, timer, maxAttempts: 5, delayMs: 50 })
    ).rejects.toThrow("EACCES");
    expect(attempts).toBe(1);
    expect(timer.getSleepCallCount()).toBe(0);
  });
});
