import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "path";
import { closeDatabase } from "../../src/db/database";

export interface TempFileDatabaseHandle {
  /** The temp directory holding `auto-mobile.db`. */
  dir: string;
  /** Restore env, close the DB singleton, and remove the temp dir. Await in teardown. */
  cleanup: () => Promise<void>;
}

/**
 * Point the process-wide `getDatabase()` singleton at a fresh temp-dir file DB
 * for the lifetime of a test file, then tear it down.
 *
 * For tests that must exercise the REAL `getDatabase()` singleton/session
 * semantics (`getInstance()`, `getInstanceForSession()`) — which an injected
 * in-memory DB cannot back because those construct unbound managers — and that
 * AWAIT their writes (so the real-DB-race in issue #3063 does not apply). This
 * satisfies the unit-test DB guard's explicit `AUTOMOBILE_DB_DIR` opt-out
 * (issue #3067) without ever touching the user's real `~/.auto-mobile` DB.
 *
 * `AUTOMOBILE_DB_PATH` is cleared because it would take precedence over
 * `AUTOMOBILE_DB_DIR`. `closeDatabase()` runs before (so the override takes
 * effect against a clean lifecycle) and during cleanup (so the temp singleton
 * never leaks into a sibling file that shares the test process).
 */
export async function useTempFileDatabase(): Promise<TempFileDatabaseHandle> {
  const savedDir = process.env.AUTOMOBILE_DB_DIR;
  const savedPath = process.env.AUTOMOBILE_DB_PATH;

  const dir = await mkdtemp(path.join(tmpdir(), "auto-mobile-unit-test-db-"));
  process.env.AUTOMOBILE_DB_DIR = dir;
  delete process.env.AUTOMOBILE_DB_PATH;
  await closeDatabase();

  return {
    dir,
    cleanup: async () => {
      await closeDatabase();
      restoreEnv("AUTOMOBILE_DB_DIR", savedDir);
      restoreEnv("AUTOMOBILE_DB_PATH", savedPath);
      await rm(dir, { recursive: true, force: true });
    },
  };
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
