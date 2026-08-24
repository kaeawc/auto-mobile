import { closeDatabase } from "../../src/db/database";
import { IN_MEMORY_DB_OPT_IN_ENV } from "../../src/db/migrationLock";

/**
 * Run `fn` with the process-wide `getDatabase()` singleton pointed at an
 * in-memory (`:memory:`) database, then restore the prior state.
 *
 * A handful of tests must assert on the REAL `getDatabase()` singleton itself —
 * e.g. that two independently-constructed unbound repositories resolve to the
 * SAME connection. Under the unit-test DB guard (issue #3067) a bare
 * `getDatabase()` throws because it would resolve the user's real
 * `~/.auto-mobile` file DB. Redirecting the singleton to `:memory:` satisfies the
 * guard's explicit opt-out while keeping the singleton semantics the test needs.
 *
 * Routing `:memory:` through the real `getDatabase()` also requires the #3065
 * production opt-in (`IN_MEMORY_DB_OPT_IN_ENV`): without it,
 * `resolveDatabasePathFromEnvironment` rejects `:memory:` as an invalid
 * production DB before the #3067 guard is even reached. Both env vars are
 * saved/restored.
 *
 * `closeDatabase()` is called before (to clear any cached path/instance so the
 * `:memory:` override actually takes effect) and after (so the transient
 * `:memory:` singleton never leaks into a sibling test).
 */
export async function withInMemorySingletonDatabase(fn: () => void | Promise<void>): Promise<void> {
  const savedDbPath = process.env.AUTOMOBILE_DB_PATH;
  const savedOptIn = process.env[IN_MEMORY_DB_OPT_IN_ENV];
  process.env.AUTOMOBILE_DB_PATH = ":memory:";
  process.env[IN_MEMORY_DB_OPT_IN_ENV] = "1";
  await closeDatabase();
  try {
    await fn();
  } finally {
    await closeDatabase();
    restoreEnv("AUTOMOBILE_DB_PATH", savedDbPath);
    restoreEnv(IN_MEMORY_DB_OPT_IN_ENV, savedOptIn);
  }
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
