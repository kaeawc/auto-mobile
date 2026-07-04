import { closeDatabase } from "../../src/db/database";

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
 * `closeDatabase()` is called before (to clear any cached path/instance so the
 * `:memory:` override actually takes effect) and after (so the transient
 * `:memory:` singleton never leaks into a sibling test).
 */
export async function withInMemorySingletonDatabase(
  fn: () => void | Promise<void>
): Promise<void> {
  const savedDbPath = process.env.AUTOMOBILE_DB_PATH;
  process.env.AUTOMOBILE_DB_PATH = ":memory:";
  await closeDatabase();
  try {
    await fn();
  } finally {
    await closeDatabase();
    if (savedDbPath === undefined) {
      delete process.env.AUTOMOBILE_DB_PATH;
    } else {
      process.env.AUTOMOBILE_DB_PATH = savedDbPath;
    }
  }
}
