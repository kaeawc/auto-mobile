import { spyOn } from "bun:test";
import type { Kysely } from "kysely";
import { createTestDatabase } from "../db/testDbHelper";
import { NavigationRepository } from "../../src/db/navigationRepository";
import { TestCoverageRepository } from "../../src/db/testCoverageRepository";
import { NavigationGraphManager } from "../../src/features/navigation/NavigationGraphManager";
import { TelemetryRecorder } from "../../src/features/telemetry/TelemetryRecorder";
import type { Database } from "../../src/db/types";

export interface InMemoryNavManagerHarness {
  /** The NavigationGraphManager installed as the `getInstance()` singleton. */
  manager: NavigationGraphManager;
  /** The in-memory, already-migrated DB backing both repositories. */
  db: Kysely<Database>;
  /** The stubbed post-commit telemetry write (asserts/inspection if needed). */
  telemetrySpy: ReturnType<typeof spyOn>;
  /** Restore telemetry, reset singletons, and destroy the DB. Await in teardown. */
  dispose: () => Promise<void>;
}

/**
 * Install a `NavigationGraphManager` singleton backed by a fresh in-memory,
 * already-migrated database, and silence its post-commit fire-and-forget
 * `TelemetryRecorder.recordNavigationEvent` write.
 *
 * Consumers that resolve the manager via `getInstance()` (AndroidCtrlProxyClient,
 * HierarchyNavigationDetector, SmartNavigationHelper, …) then exercise
 * deterministic, migration-gate-free DB writes instead of the real `getDatabase()`
 * file DB — whose first-use migrations + file IO run on real wall-clock time and
 * race async-write assertions (issue #3063). The telemetry stub keeps
 * `recordNavigationEvent`'s post-commit floating promise from resolving the real
 * `~/.auto-mobile` DB, which the unit-test guard would otherwise reject (#3067).
 *
 * Both repositories share the one connection to satisfy NavigationGraphManager's
 * shared-connection precondition. Callers MUST `await dispose()` in teardown.
 */
export async function installInMemoryNavManager(): Promise<InMemoryNavManagerHarness> {
  const db = await createTestDatabase();
  const navRepo = new NavigationRepository(db);
  const coverageRepo = new TestCoverageRepository(undefined, db);
  const manager = NavigationGraphManager.createForTesting(navRepo, coverageRepo);
  NavigationGraphManager.setInstanceForTesting(manager);

  TelemetryRecorder.resetInstance();
  const telemetrySpy = spyOn(
    TelemetryRecorder.getInstance(),
    "recordNavigationEvent",
  ).mockResolvedValue(undefined);

  return {
    manager,
    db,
    telemetrySpy,
    dispose: async () => {
      telemetrySpy.mockRestore();
      TelemetryRecorder.resetInstance();
      NavigationGraphManager.resetInstance();
      await db.destroy();
    },
  };
}
