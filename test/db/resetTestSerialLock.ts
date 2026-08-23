/**
 * Cross-file serialization lock for the DB-reset test suites (issue #2942).
 *
 * The three reset suites — `databaseReset.test.ts`, `databaseLazyPath.test.ts`,
 * `databaseLifecycleReset.test.ts` (and relatedly `dbWriteBarrierResetOnClose`) —
 * each mutate the PROCESS-GLOBAL `process.env.AUTOMOBILE_DB_DIR` /
 * `AUTOMOBILE_DB_PATH` / `AUTOMOBILE_MIGRATIONS_DIR` and then `await` a fresh
 * `database.ts` module import (a `?query`-string cache-bust). The `?query` bust
 * gives each file a PRIVATE module instance but NOT a private `process.env`.
 *
 * `bun test test/db/` loads every matched file into ONE process. Each file passes
 * in isolation, but the `await` inside a test body yields the microtask queue,
 * letting a test in another reset file run its own env mutation + fresh-module
 * resolution during that window. The victim then resolves its DB path against a
 * half-mutated env belonging to the other file — the intermittent
 * `databaseReset.test.ts:135`-style flake seen during the PR #2930 review.
 *
 * The `createFileBackedDbHarness()` per-test env snapshot/restore is correct but
 * insufficient: restoration happens in `afterEach`, AFTER the interleaving window
 * has already closed. This lock removes the interleave itself — a single shared
 * FIFO async mutex that every reset TEST (across every reset file) acquires for
 * its whole body, so no two reset tests ever hold the shared env + fresh-module
 * resolution surface at the same time.
 *
 * The lock is module-scoped, so all files that `import` it share the SAME queue
 * — that shared identity is the whole point (a per-file lock would not serialize
 * across files). Kept as a bare promise-chain FIFO (no external primitive):
 * `runExclusive` chains each caller behind the previous release, and a `finally`
 * guarantees release even if the body throws, so one failing test cannot deadlock
 * the rest of the queue.
 */

let tail: Promise<void> = Promise.resolve();

/**
 * Run `body` with exclusive access to the shared reset-test env surface. Callers
 * across all reset files queue FIFO; the returned promise resolves/rejects with
 * `body`'s outcome so `await runExclusiveResetTest(...)` preserves normal test
 * semantics.
 */
export async function runExclusiveResetTest<T>(body: () => Promise<T>): Promise<T> {
  // Chain onto the current tail: our turn starts only once every prior caller has
  // released. `.catch(() => {})` on the awaited predecessor prevents an upstream
  // rejection from propagating into (and failing) an unrelated later test — each
  // caller still surfaces its OWN body error below.
  const prior = tail;
  let release!: () => void;
  tail = new Promise<void>((resolve) => {
    release = resolve;
  });

  await prior.catch(() => {});
  try {
    return await body();
  } finally {
    release();
  }
}
