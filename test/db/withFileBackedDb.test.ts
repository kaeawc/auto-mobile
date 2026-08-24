import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import path from "path";
import { tmpdir } from "node:os";
import { DAEMON_LAUNCH_CWD_ENV } from "../../src/utils/workingDirectory";
import { WINDOWS_FILE_DB_TEST_TIMEOUT_MS } from "./fileBackedDbTestTimeout";
import {
  createFileBackedDbHarness,
  WINDOWS_FILE_DB_TEST_TIMEOUT_MS as HARNESS_TIMEOUT_REEXPORT,
} from "./withFileBackedDb";
import type { FreshDatabaseModule, LifecycleDatabaseModule } from "./withFileBackedDb";

/**
 * The harness's `importDatabaseModule` dep is typed as the full
 * {@link FreshDatabaseModule} (the only real module). The fakes here implement
 * just the narrow {@link LifecycleDatabaseModule} contract the harness actually
 * drives, so they cast at this ONE injection helper — the deliberate trade
 * (issue #3081, item 2) for dropping the `<M>` generic that previously threaded
 * through four interfaces.
 */
const asFreshModule = (module: LifecycleDatabaseModule): FreshDatabaseModule =>
  module as unknown as FreshDatabaseModule;

/**
 * Unit tests for the shared file-backed DB-lifecycle harness (issue #3046).
 *
 * The harness centralizes the flake-avoidance pattern the file-backed DB
 * lifecycle suites otherwise re-apply by hand (#2916/#2992/#3040). These tests
 * inject fakes for every side effect — `mkdtemp`, temp-dir removal, the fresh
 * `database.ts` module, and the environment object — so the orchestration is
 * proven with no real filesystem, DB, or wall-clock and stays <100ms. The real
 * migrated suites exercise the un-injected path against a real temp DB.
 */
describe("createFileBackedDbHarness (issue #3046)", () => {
  /** A fake `database.ts` module that records the order of lifecycle calls. */
  function makeFakeModule(dbPath = "/fake/db/auto-mobile.db"): LifecycleDatabaseModule & {
    calls: string[];
  } {
    const calls: string[] = [];
    return {
      calls,
      getDatabase() {
        calls.push("getDatabase");
        return {} as never;
      },
      async ensureMigrations() {
        calls.push("ensureMigrations");
      },
      async closeDatabase() {
        calls.push("closeDatabase");
      },
      getDatabasePath() {
        calls.push("getDatabasePath");
        return dbPath;
      },
    };
  }

  /** A fake mkdtemp that returns a deterministic unique dir per call. */
  function makeFakeMkdtemp() {
    const received: string[] = [];
    let counter = 0;
    const mkdtemp = async (prefix: string): Promise<string> => {
      received.push(prefix);
      counter += 1;
      return `/fake-tmp/${prefix}${counter}`;
    };
    return { mkdtemp, received };
  }

  /** A fake temp-dir remover that records each dir it was asked to remove. */
  function makeFakeRemover() {
    const removed: string[] = [];
    const removeTempDir = async (dir: string): Promise<void> => {
      removed.push(dir);
    };
    return { removeTempDir, removed };
  }

  test("re-exports the canonical file-backed timeout constant", () => {
    expect(HARNESS_TIMEOUT_REEXPORT).toBe(WINDOWS_FILE_DB_TEST_TIMEOUT_MS);
  });

  test("makeTempDbDir joins tmpdir onto the prefix, tracks, and returns the dir", async () => {
    const { mkdtemp, received } = makeFakeMkdtemp();
    const { removeTempDir, removed } = makeFakeRemover();
    const harness = createFileBackedDbHarness({ mkdtemp, removeTempDir, env: {} });

    const dir = await harness.makeTempDbDir("am-x-");

    // The tmpdir join is the harness's responsibility, so the fake receives an
    // absolute path under the OS temp dir — not the bare prefix.
    expect(received).toEqual([path.join(tmpdir(), "am-x-")]);
    expect(dir).toBe(`/fake-tmp/${path.join(tmpdir(), "am-x-")}1`);

    // Tracked: cleanup removes exactly what makeTempDbDir handed out.
    await harness.cleanup();
    expect(removed).toEqual([dir]);
  });

  test("cleanup removes every tracked dir and restores the env to its creation snapshot", async () => {
    const { mkdtemp } = makeFakeMkdtemp();
    const { removeTempDir, removed } = makeFakeRemover();
    const env: NodeJS.ProcessEnv = { KEEP: "1", CHANGE: "old", REMOVE: "x" };

    // Snapshot is taken at creation.
    const harness = createFileBackedDbHarness({ mkdtemp, removeTempDir, env });

    const a = await harness.makeTempDbDir("a-");
    const b = await harness.makeTempDbDir("b-");

    // Mutate the env the way a test would: add, change, and delete keys.
    env.ADDED = "new";
    env.CHANGE = "new";
    delete env.REMOVE;

    await harness.cleanup();

    expect(removed).toEqual([a, b]);
    expect(env).toEqual({ KEEP: "1", CHANGE: "old", REMOVE: "x" });
  });

  test("openLifecycleTestDb points env at a fresh tracked dir and clears overrides", async () => {
    const { mkdtemp } = makeFakeMkdtemp();
    const { removeTempDir } = makeFakeRemover();
    const fake = makeFakeModule();
    const env: NodeJS.ProcessEnv = {
      AUTOMOBILE_DB_PATH: "/stale/path",
      AUTO_MOBILE_DB_PATH: "/stale/legacy",
      AUTOMOBILE_MIGRATIONS_DIR: "/stale/migrations",
      AUTO_MOBILE_MIGRATIONS_DIR: "/stale/legacy-migrations",
      [DAEMON_LAUNCH_CWD_ENV]: "/stale/cwd",
    };
    const harness = createFileBackedDbHarness({
      mkdtemp,
      removeTempDir,
      env,
      importDatabaseModule: async () => asFreshModule(fake),
    });

    const opened = await harness.openLifecycleTestDb("am-life-");

    // Bound to the fresh temp dir; every path/migration override that could
    // derail a healthy boot is cleared.
    expect(env.AUTOMOBILE_DB_DIR).toBe(opened.dir);
    expect(env.AUTOMOBILE_DB_PATH).toBeUndefined();
    expect(env.AUTO_MOBILE_DB_PATH).toBeUndefined();
    expect(env.AUTOMOBILE_MIGRATIONS_DIR).toBeUndefined();
    expect(env.AUTO_MOBILE_MIGRATIONS_DIR).toBeUndefined();
    expect(env[DAEMON_LAUNCH_CWD_ENV]).toBeUndefined();

    expect(opened.module).toBe(fake);
    expect(opened.dbPath).toBe("/fake/db/auto-mobile.db");
  });

  test("openLifecycleTestDb runs getDatabase() BEFORE ensureMigrations() (the #2992 ordering)", async () => {
    const { mkdtemp } = makeFakeMkdtemp();
    const { removeTempDir } = makeFakeRemover();
    const fake = makeFakeModule();
    const harness = createFileBackedDbHarness({
      mkdtemp,
      removeTempDir,
      env: {},
      importDatabaseModule: async () => asFreshModule(fake),
    });

    await harness.openLifecycleTestDb("am-life-");

    // The whole point of the harness: the detached migration connection is armed
    // (getDatabase) and then awaited (ensureMigrations) before any close, so a
    // close-time WAL checkpoint can't contend on Windows. Pin the exact call
    // sequence — getDatabase before ensureMigrations, then getDatabasePath —
    // rather than a loose ordering check that a reordered harness could satisfy.
    expect(fake.calls).toEqual(["getDatabase", "ensureMigrations", "getDatabasePath"]);
  });

  test("openLifecycleTestDb close() closes the DB and removes+untracks its dir (no double-remove)", async () => {
    const { mkdtemp } = makeFakeMkdtemp();
    const { removeTempDir, removed } = makeFakeRemover();
    const fake = makeFakeModule();
    const harness = createFileBackedDbHarness({
      mkdtemp,
      removeTempDir,
      env: {},
      importDatabaseModule: async () => asFreshModule(fake),
    });

    const opened = await harness.openLifecycleTestDb("am-life-");
    await opened.close();

    expect(fake.calls).toContain("closeDatabase");
    expect(removed).toEqual([opened.dir]);

    // cleanup must not remove the same dir a second time.
    await harness.cleanup();
    expect(removed).toEqual([opened.dir]);
  });

  test("importFreshDatabaseModule delegates to the injected importer", async () => {
    const { mkdtemp } = makeFakeMkdtemp();
    const { removeTempDir } = makeFakeRemover();
    const fake = makeFakeModule();
    let importCount = 0;
    const harness = createFileBackedDbHarness({
      mkdtemp,
      removeTempDir,
      env: {},
      importDatabaseModule: async () => {
        importCount += 1;
        return asFreshModule(fake);
      },
    });

    const mod = await harness.importFreshDatabaseModule();

    expect(mod).toBe(fake);
    expect(importCount).toBe(1);
  });

  test("cleanup restores the env even if a temp-dir removal throws", async () => {
    const { mkdtemp } = makeFakeMkdtemp();
    const env: NodeJS.ProcessEnv = { CHANGE: "old" };
    const removeTempDir = async (): Promise<void> => {
      throw new Error("boom");
    };
    const harness = createFileBackedDbHarness({ mkdtemp, removeTempDir, env });

    await harness.makeTempDbDir("a-");
    env.CHANGE = "new";
    env.ADDED = "leak";

    await expect(harness.cleanup()).rejects.toThrow("boom");
    // The env restore runs in a finally so a flaky removal never leaks env state
    // into the next test.
    expect(env).toEqual({ CHANGE: "old" });
  });

  test("cleanup is a no-op-safe call when nothing was tracked", async () => {
    const { mkdtemp } = makeFakeMkdtemp();
    const { removeTempDir, removed } = makeFakeRemover();
    const harness = createFileBackedDbHarness({ mkdtemp, removeTempDir, env: {} });

    await harness.cleanup();
    expect(removed).toEqual([]);
  });
});

/**
 * Integration test for the un-injected `openLifecycleTestDb` path (issue #3046).
 *
 * The fake-based unit tests above prove the orchestration; this one drives the
 * real convenience method end-to-end against a genuine temp `.db` — a fresh
 * `database.ts` module, the full startup migration set on a real file, then a
 * self-cleaning `close()`. It both guards the real integration the fakes cannot
 * (a migrated schema is actually queryable) and doubles as the reference example
 * a new file-backed suite copies. It is the one file-backed body here, so it
 * carries the shared `WINDOWS_FILE_DB_TEST_TIMEOUT_MS` ceiling.
 *
 * It deliberately does NOT assert the temp dir is gone after `close()`:
 * `removeTempDbDir` is bounded/best-effort and GIVES UP (leaving the dir for the
 * OS sweeper) when Windows holds the sqlite handle past `destroy()` — asserting
 * removal would reintroduce the exact flake class this harness exists to avoid
 * (#2916). The Windows-safe contract is that `close()` resolves and the dir is
 * untracked so a following `cleanup()` never double-removes it.
 */
describe("openLifecycleTestDb against a real file-backed DB (issue #3046)", () => {
  let harness = createFileBackedDbHarness();

  beforeEach(() => {
    harness = createFileBackedDbHarness();
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  test(
    "opens + migrates a real temp DB, exposes a queryable migrated schema, and self-cleans on close",
    async () => {
      const opened = await harness.openLifecycleTestDb("am-harness-int-");

      // dbPath resolves inside the fresh temp dir the harness created.
      expect(opened.dbPath).toBe(path.join(opened.dir, "auto-mobile.db"));
      expect(process.env.AUTOMOBILE_DB_DIR).toBe(opened.dir);

      // The migrated schema is genuinely present: `ensureMigrations()` already
      // ran the full startup set, so a query against a migrated table returns
      // rows (empty) rather than "no such table: tool_calls".
      const db = opened.module.getDatabase() as ReturnType<
        Awaited<ReturnType<typeof harness.importFreshDatabaseModule>>["getDatabase"]
      >;
      const rows = await db
        .selectFrom("tool_calls" as never)
        .selectAll()
        .execute();
      expect(rows).toEqual([]);

      // close() destroys the connection and removes+untracks its temp dir
      // (best-effort: it may survive on a Windows handle livelock, which is why
      // we assert close() resolves rather than that the dir is gone).
      await expect(opened.close()).resolves.toBeUndefined();

      // Untracked by close(): a subsequent cleanup() must not throw trying to
      // remove it a second time.
      await expect(harness.cleanup()).resolves.toBeUndefined();
    },
    WINDOWS_FILE_DB_TEST_TIMEOUT_MS,
  );
});
