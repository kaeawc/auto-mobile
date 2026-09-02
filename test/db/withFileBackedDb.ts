import path from "path";
import { mkdtemp as fsMkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { DAEMON_LAUNCH_CWD_ENV } from "../../src/utils/workingDirectory";
import { importFreshDatabaseModule } from "./freshDatabaseModule";
import { removeTempDbDir } from "./tempDbDir";
import { WINDOWS_FILE_DB_TEST_TIMEOUT_MS } from "./fileBackedDbTestTimeout";

/**
 * Shared harness that enforces the file-backed DB-lifecycle flake-avoidance
 * pattern in ONE place (issue #3046).
 *
 * This is the third round of the same Windows file-backed DB test flake class
 * (#2916 -> #2923, #2992 -> #3040). Each prior round hardened the *instances*
 * that were flaking; nothing enforced the pattern, so the next engineer who
 * added a file-backed close/reopen suite re-hit it. The knowledge lived only in
 * prose comments across ~5 files, and prose did not stop the recurrence.
 *
 * Every file-backed DB lifecycle suite must independently remember to:
 *   1. import a FRESH `database.ts` module so its lazy module-globals
 *      (`resolvedDbPath`, the migration state machine, ...) are isolated
 *      ({@link importFreshDatabaseModule}, #2916),
 *   2. track its temp dirs and clean them with the BOUNDED {@link removeTempDbDir}
 *      so a Windows file-handle livelock can never stall `afterEach` (#2916),
 *   3. call `getDatabase()` and THEN `await ensureMigrations()` before
 *      `closeDatabase()`, so the detached migration connection settles instead of
 *      contending with the close-time WAL checkpoint on Windows (#2992/#3040),
 *   4. apply {@link WINDOWS_FILE_DB_TEST_TIMEOUT_MS} to the slow-but-correct
 *      migration body.
 *
 * A suite wires `createFileBackedDbHarness()` into `beforeEach` (fresh env
 * snapshot per test) and `harness.cleanup()` into `afterEach`. It then either
 * drives the module directly via the primitives ({@link makeTempDbDir},
 * {@link importFreshDatabaseModule}) for tests that control the migration
 * lifecycle mid-flight, or uses {@link openLifecycleTestDb} for the common
 * open+migrate+close flow. Correct ordering is now the path of least resistance
 * and a new suite gets the whole pattern for free.
 *
 * Every side effect is injectable (`mkdtemp`, `removeTempDir`,
 * `importDatabaseModule`, `env`) so the orchestration is unit-tested with fakes —
 * no real filesystem, DB, or wall-clock — keeping those tests <100ms. The real
 * migrated suites exercise the un-injected path against a temp DB.
 */

/**
 * The narrow slice of `database.ts` the harness drives. Kept minimal (YAGNI):
 * suites that need the wider module surface (`getMigrationsError`,
 * `getMigrationsPromiseForTest`, ...) use the fuller type returned by
 * {@link importFreshDatabaseModule} directly.
 */
export interface LifecycleDatabaseModule {
  getDatabase(): unknown;
  ensureMigrations(): Promise<void>;
  closeDatabase(): Promise<void>;
  getDatabasePath(): string;
}

/**
 * The full fresh `database.ts` module type (the default the harness hands back),
 * so suites can reach beyond the narrow lifecycle slice — `getMigrationsError`,
 * `getMigrationsPromiseForTest`, ... — without a cast.
 */
export type FreshDatabaseModule = Awaited<ReturnType<typeof importFreshDatabaseModule>>;

/** A single open+migrated file-backed DB, with a self-cleaning `close()`. */
export interface OpenLifecycleTestDb {
  /** The fresh `database.ts` module instance backing this DB. */
  module: FreshDatabaseModule;
  /** The tracked temp dir holding the `.db` file. */
  dir: string;
  /** The resolved `auto-mobile.db` path inside {@link dir}. */
  dbPath: string;
  /** Close the connection and remove (and untrack) this DB's temp dir. */
  close(): Promise<void>;
}

export interface FileBackedDbHarness {
  /** `mkdtemp` a tracked temp dir under the OS temp dir for the given prefix. */
  makeTempDbDir(prefix: string): Promise<string>;
  /** Import a fresh, isolated `database.ts` module instance. */
  importFreshDatabaseModule(): Promise<FreshDatabaseModule>;
  /**
   * Open a file-backed DB the correct way: fresh module + tracked temp dir +
   * `AUTOMOBILE_DB_DIR` pointed at it (path/migration overrides cleared) +
   * `getDatabase()` then `await ensureMigrations()`.
   */
  openLifecycleTestDb(prefix: string): Promise<OpenLifecycleTestDb>;
  /** Remove every still-tracked temp dir (bounded) and restore the env snapshot. */
  cleanup(): Promise<void>;
}

export interface FileBackedDbHarnessDeps {
  /**
   * Create a temp dir at an absolute path. Defaults to `fs.mkdtemp`; the harness
   * always passes an absolute `tmpdir()`-joined prefix, so the injected fake
   * receives that full path.
   */
  mkdtemp?: (fullPrefix: string) => Promise<string>;
  /** Remove a temp dir. Defaults to the BOUNDED {@link removeTempDbDir} (#2916). */
  removeTempDir?: (dir: string) => Promise<void>;
  /**
   * Import a fresh `database.ts` module. Defaults to {@link importFreshDatabaseModule}.
   * Typed as the full {@link FreshDatabaseModule} (the only real module); a fake
   * that implements just the narrow {@link LifecycleDatabaseModule} contract casts
   * at this single injection site (see `withFileBackedDb.integration.test.ts`).
   */
  importDatabaseModule?: () => Promise<FreshDatabaseModule>;
  /** The environment object to snapshot/restore. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Env override keys that could redirect a healthy `openLifecycleTestDb` boot away
 * from the fresh temp dir (a stale `AUTOMOBILE_DB_PATH` wins over
 * `AUTOMOBILE_DB_DIR`; a stale migrations dir would fail the migration). Cleared
 * before each open so the only binding is the tracked temp dir.
 */
const LIFECYCLE_OVERRIDE_ENV_KEYS = [
  "AUTOMOBILE_DB_PATH",
  "AUTO_MOBILE_DB_PATH",
  "AUTOMOBILE_MIGRATIONS_DIR",
  "AUTO_MOBILE_MIGRATIONS_DIR",
  DAEMON_LAUNCH_CWD_ENV,
] as const;

export function createFileBackedDbHarness(deps: FileBackedDbHarnessDeps = {}): FileBackedDbHarness {
  const mkdtemp = deps.mkdtemp ?? ((fullPrefix) => fsMkdtemp(fullPrefix));
  const removeTempDir = deps.removeTempDir ?? ((dir) => removeTempDbDir(dir));
  // `importFreshDatabaseModule` already returns `Promise<FreshDatabaseModule>`, so
  // no cast is needed now that the surface is non-generic.
  const importModule = deps.importDatabaseModule ?? importFreshDatabaseModule;
  const env = deps.env ?? process.env;

  // Full-env snapshot taken at creation so every mutated key is restored
  // regardless of which keys a given test touches — no hand-maintained key list
  // can go stale (mirrors freshDatabaseModule's snapshotEnv/restoreEnv, but on
  // the injected env object so unit tests never touch the real process.env).
  const envSnapshot: NodeJS.ProcessEnv = { ...env };
  const tempDirs: string[] = [];

  async function makeTempDbDir(prefix: string): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  function restoreEnv(): void {
    for (const key of Object.keys(env)) {
      if (!(key in envSnapshot)) {
        delete env[key];
      }
    }
    for (const [key, value] of Object.entries(envSnapshot)) {
      if (value !== undefined) {
        env[key] = value;
      }
    }
  }

  async function removeTracked(dir: string): Promise<void> {
    const index = tempDirs.indexOf(dir);
    if (index !== -1) {
      tempDirs.splice(index, 1);
    }
    await removeTempDir(dir);
  }

  async function openLifecycleTestDb(prefix: string): Promise<OpenLifecycleTestDb> {
    const dir = await makeTempDbDir(prefix);

    // Bind the fresh temp dir and clear every override that could redirect the
    // boot elsewhere, so the healthy migration always targets this file.
    env.AUTOMOBILE_DB_DIR = dir;
    for (const key of LIFECYCLE_OVERRIDE_ENV_KEYS) {
      delete env[key];
    }

    const module = await importModule();

    // The #2992/#3040 ordering: arm the detached migration connection, then AWAIT
    // it, before any close — so the close-time WAL checkpoint has nothing left to
    // contend with on Windows.
    module.getDatabase();
    await module.ensureMigrations();

    const dbPath = module.getDatabasePath();

    return {
      module,
      dir,
      dbPath,
      async close() {
        await module.closeDatabase();
        await removeTracked(dir);
      },
    };
  }

  async function cleanup(): Promise<void> {
    try {
      for (const dir of tempDirs.splice(0)) {
        await removeTempDir(dir);
      }
    } finally {
      restoreEnv();
    }
  }

  return {
    makeTempDbDir,
    importFreshDatabaseModule: importModule,
    openLifecycleTestDb,
    cleanup,
  };
}

export { WINDOWS_FILE_DB_TEST_TIMEOUT_MS };
