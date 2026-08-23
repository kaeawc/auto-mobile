import { rmSync as fsRmSync } from "node:fs";
import { rm as fsRm } from "node:fs/promises";
import type { Timer } from "../../src/utils/SystemTimer";
import { defaultTimer } from "../../src/utils/SystemTimer";
import { logger } from "../../src/utils/logger";

/**
 * Shared bounded, best-effort temp-dir cleanup for file-backed DB tests (issue
 * #2916).
 *
 * On `windows-latest` CI, bun:sqlite can hold the `.db`/`-wal`/`-shm` file
 * handles past `Kysely.destroy()`, so removing the enclosing `mkdtemp` dir
 * throws `EBUSY`/`EPERM`/`ENOTEMPTY`. The previous per-file helpers retried
 * 100×50ms = 5s PER DIR; a close/reopen test with two temp dirs therefore
 * stalled ~10s in `afterEach` and blew the test timeout — a different file-DB
 * test flaked each run.
 *
 * This helper caps the wait: it retries a small, bounded number of times and
 * then GIVES UP, leaving the temp dir for the OS temp sweeper rather than
 * blocking. Each test uses a fresh unique `mkdtemp` dir, so a leaked dir never
 * contends with another test; correctness never depends on the removal
 * succeeding. macOS/Linux release handles immediately, so the first `rm` wins
 * and the retry path is Windows-only.
 *
 * `rm`/`timer` are injectable so the retry/give-up behavior is unit-tested with
 * a fake filesystem and {@link FakeTimer} (no real handle livelock exists off
 * Windows to reproduce).
 *
 * Why not eliminate the file entirely? The migration-dependent close/reopen
 * tests need the app connection to see a schema migrated on a SEPARATE
 * connection (`startMigrations` in `src/db/database.ts` opens and destroys its
 * own Kysely), so a plain `:memory:` DB — private per connection — cannot work.
 * `file::memory:?cache=shared` would give one shared in-memory DB with no handle
 * to leak, but bun:sqlite URI-filename support plus the real file-based
 * migration lock (`createFileMigrationLock(dbPath)`) make it higher-risk than a
 * real temp file with bounded cleanup. The issue (#2916) explicitly sanctioned
 * this bounded-retry approach.
 */
export interface RemoveTempDbDirOptions {
  /** Removal primitive. Defaults to `rm(dir, { recursive: true, force: true })`. */
  rm?: (dir: string) => Promise<void>;
  /** Backoff sleeper. Defaults to the real system timer. */
  timer?: Pick<Timer, "sleep">;
  /** Total attempts before giving up. Bounded so cleanup can never stall CI. */
  maxAttempts?: number;
  /** Delay between attempts, in ms. */
  delayMs?: number;
  /**
   * Invoked once if every attempt loses to a persistent lock. Defaults to a
   * single `logger.warn` so a leaked dir is visible in CI logs; the unit test
   * injects a spy instead.
   */
  onGiveUp?: (dir: string, error: unknown) => void;
}

export interface SyncTimer {
  sleep(ms: number): void;
}

export interface RemoveTempDbDirSyncOptions {
  /** Removal primitive. Defaults to `rmSync(dir, { recursive: true, force: true })`. */
  rmSync?: (dir: string) => void;
  /** Synchronous backoff sleeper. Defaults to a bounded blocking sleep. */
  timer?: SyncTimer;
  /** Total attempts before giving up. Bounded so cleanup can never stall CI. */
  maxAttempts?: number;
  /** Delay between attempts, in ms. */
  delayMs?: number;
  /**
   * Invoked once if every attempt loses to a persistent lock. Defaults to a
   * single `logger.warn` so a leaked dir is visible in CI logs; the unit test
   * injects a spy instead.
   */
  onGiveUp?: (dir: string, error: unknown) => void;
}

// Windows raises these while a bun:sqlite handle outlives destroy(); they are
// the only codes we treat as a transient lock and retry. Anything else is a
// real failure and rethrown.
const TRANSIENT_LOCK_CODES = new Set(["EBUSY", "EPERM", "ENOTEMPTY"]);

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_DELAY_MS = 50;

const defaultSyncTimer: SyncTimer = {
  sleep(ms: number): void {
    if (ms <= 0) {
      return;
    }
    const shared = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(shared, 0, 0, ms);
  },
};

function isTransientLockError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return Boolean(code && TRANSIENT_LOCK_CODES.has(code));
}

/**
 * Tripwire counter (issue #2949): every DEFAULT give-up — the un-injected path
 * that fires in real file-backed tests — bumps this. The give-up path is only
 * expected to fire on Windows (bun:sqlite holds `.db`/`-wal`/`-shm` handles past
 * `Kysely.destroy()` there). macOS/Linux release handles immediately, so `rm`
 * should win on the first attempt and this stays `0`. `test/db` asserts it is
 * `0` on non-`win32` so a future cross-platform handle-leak regression surfaces
 * instead of being swallowed by a silent `logger.warn`.
 *
 * Only the DEFAULT give-up increments it: unit tests that deliberately drive a
 * give-up inject their own `onGiveUp` spy and must NOT perturb this counter.
 */
let defaultGiveUpCount = 0;

/** Total number of default give-ups since the last {@link resetDefaultGiveUpCount}. */
export function getDefaultGiveUpCount(): number {
  return defaultGiveUpCount;
}

/** Reset the tripwire counter (call in a suite `beforeAll`/`afterAll`). */
export function resetDefaultGiveUpCount(): void {
  defaultGiveUpCount = 0;
}

function defaultOnGiveUp(helperName: string, dir: string, error: unknown): void {
  defaultGiveUpCount += 1;
  const code = (error as NodeJS.ErrnoException | undefined)?.code ?? "unknown";
  // Log-and-continue: the dir is a throwaway temp dir the OS will sweep; a
  // Windows handle livelock is the expected reason and is safe to swallow.
  logger.warn(
    `${helperName}: gave up removing ${dir} after ${code}; leaving it for OS temp cleanup (issue #2916)`,
    error,
  );
}

export async function removeTempDbDir(
  dir: string,
  options: RemoveTempDbDirOptions = {},
): Promise<void> {
  const rm = options.rm ?? ((target) => fsRm(target, { recursive: true, force: true }));
  const timer = options.timer ?? defaultTimer;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const delayMs = options.delayMs ?? DEFAULT_DELAY_MS;
  const onGiveUp =
    options.onGiveUp ?? ((target, error) => defaultOnGiveUp("removeTempDbDir", target, error));

  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      await rm(dir);
      return;
    } catch (error) {
      if (!isTransientLockError(error)) {
        throw error;
      }
      lastError = error;
      if (attempt < maxAttempts - 1) {
        await timer.sleep(delayMs);
      }
    }
  }

  onGiveUp(dir, lastError);
}

export function removeTempDbDirSync(dir: string, options: RemoveTempDbDirSyncOptions = {}): void {
  const rmSync = options.rmSync ?? ((target) => fsRmSync(target, { recursive: true, force: true }));
  const timer = options.timer ?? defaultSyncTimer;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const delayMs = options.delayMs ?? DEFAULT_DELAY_MS;
  const onGiveUp =
    options.onGiveUp ?? ((target, error) => defaultOnGiveUp("removeTempDbDirSync", target, error));

  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      rmSync(dir);
      return;
    } catch (error) {
      if (!isTransientLockError(error)) {
        throw error;
      }
      lastError = error;
      if (attempt < maxAttempts - 1) {
        timer.sleep(delayMs);
      }
    }
  }

  onGiveUp(dir, lastError);
}
