import { beforeEach, describe, expect, test } from "bun:test";
import path from "path";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { FakeTimer } from "../fakes/FakeTimer";
import {
  getDefaultGiveUpCount,
  removeTempDbDir,
  removeTempDbDirSync,
  resetDefaultGiveUpCount,
} from "./tempDbDir";

function ebusy(code = "EBUSY"): NodeJS.ErrnoException {
  const error = new Error(`${code}: resource busy`) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

class FakeSyncTimer {
  private readonly sleepHistory: number[] = [];

  sleep(ms: number): void {
    this.sleepHistory.push(ms);
  }

  getSleepHistory(): number[] {
    return [...this.sleepHistory];
  }

  getSleepCallCount(): number {
    return this.sleepHistory.length;
  }
}

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
    async (code) => {
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
    },
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
      removeTempDbDir("/tmp/auto-mobile-locked", { rm, maxAttempts: 2, delayMs: 1 }),
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
      removeTempDbDir("/tmp/auto-mobile-x", { rm, timer, maxAttempts: 5, delayMs: 50 }),
    ).rejects.toThrow("EACCES");
    expect(attempts).toBe(1);
    expect(timer.getSleepCallCount()).toBe(0);
  });
});

/**
 * Give-up tripwire (issue #2949).
 *
 * The DEFAULT (un-injected) give-up path is expected to fire ONLY on Windows,
 * where bun:sqlite holds `.db`/`-wal`/`-shm` handles past `Kysely.destroy()`.
 * macOS/Linux release handles immediately, so `rm` wins on the first attempt and
 * no give-up should ever fire. The module-level counter makes that observable so
 * a future cross-platform handle-leak regression surfaces instead of being
 * swallowed by a silent `logger.warn`. These tests assert:
 *   1. the DEFAULT give-up increments the counter (async + sync),
 *   2. an INJECTED `onGiveUp` spy does NOT (unit tests deliberately give up),
 *   3. on non-`win32`, real happy-path cleanup leaves the counter at 0.
 */
describe("removeTempDbDir give-up tripwire (issue #2949)", () => {
  beforeEach(() => {
    resetDefaultGiveUpCount();
  });

  test("the DEFAULT give-up increments the tripwire counter", async () => {
    const rm = async () => {
      throw ebusy();
    };

    await removeTempDbDir("/tmp/auto-mobile-locked", { rm, maxAttempts: 2, delayMs: 1 });

    expect(getDefaultGiveUpCount()).toBe(1);
  });

  test("the DEFAULT sync give-up increments the tripwire counter", () => {
    const rmSync = () => {
      throw ebusy();
    };

    removeTempDbDirSync("/tmp/auto-mobile-locked", { rmSync, maxAttempts: 2, delayMs: 1 });

    expect(getDefaultGiveUpCount()).toBe(1);
  });

  test("an INJECTED onGiveUp does NOT increment the tripwire counter", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const rm = async () => {
      throw ebusy();
    };
    let injectedGaveUp = false;

    await removeTempDbDir("/tmp/auto-mobile-locked", {
      rm,
      timer,
      maxAttempts: 2,
      delayMs: 1,
      onGiveUp: () => {
        injectedGaveUp = true;
      },
    });

    expect(injectedGaveUp).toBe(true);
    // Injected spy replaces the default entirely; the tripwire must stay silent
    // so unit-test give-ups can never trip the non-win32 assertion below.
    expect(getDefaultGiveUpCount()).toBe(0);
  });

  test("resetDefaultGiveUpCount zeroes an accumulated count", async () => {
    const rm = async () => {
      throw ebusy();
    };
    await removeTempDbDir("/tmp/a", { rm, maxAttempts: 1, delayMs: 1 });
    await removeTempDbDir("/tmp/b", { rm, maxAttempts: 1, delayMs: 1 });
    expect(getDefaultGiveUpCount()).toBe(2);

    resetDefaultGiveUpCount();

    expect(getDefaultGiveUpCount()).toBe(0);
  });

  test("real happy-path cleanup never gives up on non-win32", async () => {
    // The invariant the tripwire protects: on macOS/Linux the default rm wins on
    // the first attempt, so no give-up ever fires. On Windows the handle-leak is
    // expected, so we only assert this off-Windows.
    if (process.platform === "win32") {
      return;
    }

    const dir = await mkdtemp(path.join(tmpdir(), "auto-mobile-tempdbdir-tripwire-"));
    await writeFile(path.join(dir, "auto-mobile.db"), "not-a-real-db");

    await removeTempDbDir(dir);
    const syncDir = mkdtempSync(path.join(tmpdir(), "auto-mobile-tempdbdir-tripwire-sync-"));
    writeFileSync(path.join(syncDir, "auto-mobile.db"), "not-a-real-db");
    removeTempDbDirSync(syncDir);

    expect(existsSync(dir)).toBe(false);
    expect(existsSync(syncDir)).toBe(false);
    expect(getDefaultGiveUpCount()).toBe(0);
  });
});

/**
 * Degenerate `maxAttempts` rows (issue #4186). `maxAttempts: 0` makes the retry
 * loop body run ZERO times, so removal is never even attempted and the helper
 * silently "gives up" with no underlying error. That silent-skip is a footgun a
 * caller could hit by threading a computed 0 through; pin it (mirrored across the
 * async and sync helpers) so the behaviour cannot change unnoticed.
 */
describe("removeTempDbDir degenerate maxAttempts (issue #4186)", () => {
  test("async maxAttempts:0 attempts no removal and gives up with no error", async () => {
    let rmCalls = 0;
    const gaveUpErrors: unknown[] = [];

    await removeTempDbDir("/tmp/auto-mobile-degenerate", {
      rm: async () => {
        rmCalls += 1;
      },
      maxAttempts: 0,
      delayMs: 1,
      onGiveUp: (_dir, error) => gaveUpErrors.push(error),
    });

    expect(rmCalls).toBe(0);
    expect(gaveUpErrors).toEqual([undefined]);
  });

  test("sync maxAttempts:0 attempts no removal and gives up with no error", () => {
    let rmCalls = 0;
    const gaveUpErrors: unknown[] = [];

    removeTempDbDirSync("/tmp/auto-mobile-degenerate", {
      rmSync: () => {
        rmCalls += 1;
      },
      maxAttempts: 0,
      delayMs: 1,
      onGiveUp: (_dir, error) => gaveUpErrors.push(error),
    });

    expect(rmCalls).toBe(0);
    expect(gaveUpErrors).toEqual([undefined]);
  });
});

describe("removeTempDbDirSync (issue #2948)", () => {
  test("removes the dir on the first attempt and never sleeps when rmSync succeeds", () => {
    const timer = new FakeSyncTimer();
    const calls: string[] = [];
    const rmSync = (dir: string) => {
      calls.push(dir);
    };

    removeTempDbDirSync("/tmp/auto-mobile-x", { rmSync, timer });

    expect(calls).toEqual(["/tmp/auto-mobile-x"]);
    expect(timer.getSleepCallCount()).toBe(0);
  });

  test("retries a transient EBUSY synchronously, then succeeds", () => {
    const timer = new FakeSyncTimer();
    let attempts = 0;
    const rmSync = () => {
      attempts += 1;
      if (attempts < 3) {
        throw ebusy();
      }
    };

    removeTempDbDirSync("/tmp/auto-mobile-x", { rmSync, timer, maxAttempts: 5, delayMs: 50 });

    expect(attempts).toBe(3);
    expect(timer.getSleepHistory()).toEqual([50, 50]);
  });

  test("gives up WITHOUT throwing after a persistent sync lock, within a bounded sleep budget", () => {
    const timer = new FakeSyncTimer();
    let attempts = 0;
    const rmSync = () => {
      attempts += 1;
      throw ebusy();
    };
    const gaveUp: Array<{ dir: string; error: unknown }> = [];

    removeTempDbDirSync("/tmp/auto-mobile-locked", {
      rmSync,
      timer,
      maxAttempts: 5,
      delayMs: 50,
      onGiveUp: (dir, error) => gaveUp.push({ dir, error }),
    });

    expect(attempts).toBe(5);
    const history = timer.getSleepHistory();
    expect(history.length).toBe(4);
    expect(history.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(200);
    expect(gaveUp.length).toBe(1);
    expect(gaveUp[0].dir).toBe("/tmp/auto-mobile-locked");
    expect((gaveUp[0].error as NodeJS.ErrnoException).code).toBe("EBUSY");
  });

  test.each(["EPERM", "ENOTEMPTY"])(
    "treats %s as a transient sync Windows lock and gives up gracefully",
    (code) => {
      const timer = new FakeSyncTimer();
      const rmSync = () => {
        throw ebusy(code);
      };
      let gaveUp = false;

      removeTempDbDirSync("/tmp/auto-mobile-x", {
        rmSync,
        timer,
        maxAttempts: 3,
        delayMs: 10,
        onGiveUp: () => {
          gaveUp = true;
        },
      });

      expect(gaveUp).toBe(true);
    },
  );

  test("removes a real temp dir (and its contents) through the default sync rm/timer", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "auto-mobile-tempdbdir-sync-real-"));
    writeFileSync(path.join(dir, "auto-mobile.db"), "not-a-real-db");
    expect(existsSync(dir)).toBe(true);

    removeTempDbDirSync(dir);

    expect(existsSync(dir)).toBe(false);
  });

  test("the default sync onGiveUp runs without throwing when a lock never clears", () => {
    const rmSync = () => {
      throw ebusy();
    };

    expect(() =>
      removeTempDbDirSync("/tmp/auto-mobile-locked", { rmSync, maxAttempts: 2, delayMs: 1 }),
    ).not.toThrow();
  });

  test("rethrows an unexpected sync non-lock error code without retrying", () => {
    const timer = new FakeSyncTimer();
    let attempts = 0;
    const rmSync = () => {
      attempts += 1;
      throw ebusy("EACCES");
    };

    expect(() =>
      removeTempDbDirSync("/tmp/auto-mobile-x", { rmSync, timer, maxAttempts: 5, delayMs: 50 }),
    ).toThrow("EACCES");
    expect(attempts).toBe(1);
    expect(timer.getSleepCallCount()).toBe(0);
  });
});
