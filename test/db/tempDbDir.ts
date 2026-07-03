import { rm as fsRm } from "node:fs/promises";
import type { Timer } from "../../src/utils/SystemTimer";
import { defaultTimer } from "../../src/utils/SystemTimer";

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
   * single `console.warn` so a leaked dir is visible in CI logs; the unit test
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

function defaultOnGiveUp(dir: string, error: unknown): void {
  const code = (error as NodeJS.ErrnoException | undefined)?.code ?? "unknown";
  // Log-and-continue: the dir is a throwaway temp dir the OS will sweep; a
  // Windows handle livelock is the expected reason and is safe to swallow.
  console.warn(
    `removeTempDbDir: gave up removing ${dir} after ${code}; leaving it for OS temp cleanup (issue #2916)`
  );
}

export async function removeTempDbDir(
  dir: string,
  options: RemoveTempDbDirOptions = {}
): Promise<void> {
  const rm = options.rm ?? (target => fsRm(target, { recursive: true, force: true }));
  const timer = options.timer ?? defaultTimer;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const delayMs = options.delayMs ?? DEFAULT_DELAY_MS;
  const onGiveUp = options.onGiveUp ?? defaultOnGiveUp;

  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      await rm(dir);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!code || !TRANSIENT_LOCK_CODES.has(code)) {
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
