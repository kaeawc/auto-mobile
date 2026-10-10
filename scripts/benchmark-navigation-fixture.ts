/**
 * An in-memory `NavigationGraphManager` for benchmark fixtures (#11375).
 *
 * `test/helpers/navigationTestHarness.ts` does this for unit tests, but it imports
 * `test/db/testDbHelper.ts`, which registers a `beforeAll` and so cannot load outside `bun test`.
 * This builds the same thing without it: a migrated `:memory:` database behind both repositories,
 * installed as the `getInstance()` singleton so no code path resolves the real file-backed DB, and
 * the post-commit telemetry write silenced.
 */
import { Database as BunDatabase } from "bun:sqlite";
import { Kysely } from "kysely";
import { BunSqliteDialect } from "../src/db/bunSqliteDialect";
import { runMigrations } from "../src/db/migrator";
import { NavigationRepository } from "../src/db/navigationRepository";
import { TestCoverageRepository } from "../src/db/testCoverageRepository";
import type { Database } from "../src/db/types";
import { NavigationGraphManager } from "../src/features/navigation/NavigationGraphManager";
import { TelemetryRecorder } from "../src/features/telemetry/TelemetryRecorder";

export interface BenchmarkNavigationManager {
  /** Restore telemetry, reset the singletons and close the database. */
  dispose(): Promise<void>;
}

export async function installBenchmarkNavigationManager(): Promise<BenchmarkNavigationManager> {
  const db = new Kysely<Database>({
    dialect: new BunSqliteDialect({ database: new BunDatabase(":memory:") }),
  });
  await runMigrations(db as Kysely<unknown>);
  // Both repositories share the one connection (NavigationGraphManager's precondition).
  const manager = NavigationGraphManager.createForTesting(
    new NavigationRepository(db),
    new TestCoverageRepository(undefined, db),
  );
  NavigationGraphManager.setInstanceForTesting(manager);

  TelemetryRecorder.resetInstance();
  const telemetry = TelemetryRecorder.getInstance();
  const recordNavigationEvent = telemetry.recordNavigationEvent;
  telemetry.recordNavigationEvent = async () => {};

  return {
    async dispose() {
      telemetry.recordNavigationEvent = recordNavigationEvent;
      TelemetryRecorder.resetInstance();
      NavigationGraphManager.resetInstance();
      await db.destroy();
    },
  };
}
