import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import path from "path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { DAEMON_LAUNCH_CWD_ENV } from "../../src/utils/workingDirectory";
import { getDbWriteBarrier, resetDbWriteBarrier } from "../../src/db/dbWriteBarrier";
import { removeTempDbDir } from "./tempDbDir";
import { importFreshDatabaseModule, restoreEnv, snapshotEnv } from "./freshDatabaseModule";
import { WINDOWS_FILE_DB_TEST_TIMEOUT_MS } from "./fileBackedDbTestTimeout";

/**
 * Regression tests for issue #2896 (follow-up to #2796).
 *
 * #2796 made `closeDatabase()` reset the migration/path module globals so a
 * same-process reopen behaves like a cold start. The one shutdown-state global
 * it deliberately left untouched was the {@link getDbWriteBarrier} drain latch:
 * once `beginDrain()`/`drain()` flips it, it stays draining for the process
 * lifetime and every tracked best-effort write short-circuits
 * (`dbWriteBarrier.ts` `track()`).
 *
 * The daemon quiesces in-flight writes by calling `getDbWriteBarrier().drain()`
 * BEFORE `closeDatabase()` (issue #2792 ordering). If any future path reopens
 * the DB in the same process after that drain (config reload, DB path switch,
 * restart-without-exit) without also cold-starting the barrier, the reopened DB
 * would silently skip every tracked best-effort write. `closeDatabase()` now
 * clears the barrier via `resetDbWriteBarrier()` so the cold-start contract is
 * fully true.
 *
 * The shared barrier is a process-global singleton; `resetDbWriteBarrier()` in
 * `beforeEach`/`afterEach` isolates these tests from the rest of the suite.
 */
describe("closeDatabase cold-starts the dbWriteBarrier drain latch (issue #2896)", () => {
  // Opens a real file-backed DB (needs a shared on-disk file across the
  // migration and app connections). This timeout only covers the test BODY
  // (migrations + queries on slow Windows disk I/O). The cleanup stall from
  // issue #2916 is bounded separately by `removeTempDbDir` (best-effort,
  // ~200ms/dir); the `afterEach` hook is given the same generous ceiling below
  // so a slow Windows temp-dir release cannot read as a hook timeout (#2992).
  const FILE_BACKED_TEST_TIMEOUT_MS = WINDOWS_FILE_DB_TEST_TIMEOUT_MS;

  const tempDirs: string[] = [];
  let envSnapshot: NodeJS.ProcessEnv;

  beforeEach(() => {
    envSnapshot = snapshotEnv();
    // Start every test from a fresh, non-draining shared barrier so a latched
    // barrier leaked by another test cannot mask the reset under test.
    resetDbWriteBarrier();
  });

  afterEach(async () => {
    resetDbWriteBarrier();
    restoreEnv(envSnapshot);
    for (const dir of tempDirs.splice(0)) {
      await removeTempDbDir(dir);
    }
    // Give the hook the same generous ceiling as the body: on windows-latest a
    // just-released bun:sqlite handle can keep the temp dir locked long enough
    // for the bounded `removeTempDbDir` retries to run, and the default 5s hook
    // timeout would read that as a failure even though the body passed (#2992).
  }, WINDOWS_FILE_DB_TEST_TIMEOUT_MS);

  async function makeTempDbDir(prefix: string): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  test("a tracked best-effort write after drain -> close -> reopen is NOT skipped", async () => {
    const firstDir = await makeTempDbDir("auto-mobile-barrier-reset-first-");
    process.env.AUTOMOBILE_DB_DIR = firstDir;
    delete process.env[DAEMON_LAUNCH_CWD_ENV];

    const databaseModule = await importFreshDatabaseModule();

    // Cold start on the first DB, then let startup migrations fully settle. The
    // detached migration run opens its OWN connection to the same file and
    // destroys it only when done; awaiting settle here means the later
    // closeDatabase() checkpoint has no concurrent writer to contend with. On
    // windows-latest that concurrency is exactly what produced the compounding
    // busy_timeout stall that blew this test's body/hook timeouts (#2992).
    databaseModule.getDatabase();
    await databaseModule.ensureMigrations();

    // Model the daemon shutdown ordering: drain in-flight best-effort writes,
    // then close the connection (issue #2792).
    const shutdownBarrier = getDbWriteBarrier();
    expect(await shutdownBarrier.drain(1000)).toBe(true);
    expect(shutdownBarrier.isDraining()).toBe(true);

    await databaseModule.closeDatabase();

    // Reopen in the same process against a brand-new DB dir (config reload / DB
    // path switch / restart-without-exit).
    const secondDir = await makeTempDbDir("auto-mobile-barrier-reset-second-");
    process.env.AUTOMOBILE_DB_DIR = secondDir;
    databaseModule.getDatabase();
    // Settle the reopened DB's migrations too, so the final closeDatabase() in
    // this test closes cleanly instead of racing a detached migration (#2992).
    await databaseModule.ensureMigrations();

    // The barrier must have cold-started: a distinct, non-draining instance.
    const reopenedBarrier = getDbWriteBarrier();
    expect(reopenedBarrier).not.toBe(shutdownBarrier);
    expect(reopenedBarrier.isDraining()).toBe(false);

    // The core contract: a tracked best-effort write actually runs against the
    // reopened DB instead of being silently skipped by a latched barrier.
    let ran = false;
    const result = await reopenedBarrier.track(async () => {
      ran = true;
      return "written";
    });
    expect(ran).toBe(true);
    expect(result).toBe("written");

    await databaseModule.closeDatabase();
  }, FILE_BACKED_TEST_TIMEOUT_MS);

  test("closeDatabase clears a drain latch even with no open connection", async () => {
    const dir = await makeTempDbDir("auto-mobile-barrier-reset-noconn-");
    process.env.AUTOMOBILE_DB_DIR = dir;
    delete process.env[DAEMON_LAUNCH_CWD_ENV];

    const databaseModule = await importFreshDatabaseModule();

    // Latch the barrier without ever opening the DB, then close. The reset is
    // unconditional (mirrors the migration-global reset), so the latch clears
    // even on a partially-initialized shutdown.
    const latched = getDbWriteBarrier();
    latched.beginDrain();
    expect(latched.isDraining()).toBe(true);

    await databaseModule.closeDatabase();

    const fresh = getDbWriteBarrier();
    expect(fresh).not.toBe(latched);
    expect(fresh.isDraining()).toBe(false);
  });
});
