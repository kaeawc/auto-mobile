import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Kysely } from "kysely";
import type { Database } from "../../src/db/types";
import { ToolSelectionProfileProvenanceRepository } from "../../src/db/toolSelectionProfileProvenanceRepository";
import { PersistentToolSelectionProfileRegistry } from "../../src/server/toolSelectionProfileRegistry";
import { createFileBackedDbHarness } from "./withFileBackedDb";
import { WINDOWS_FILE_DB_TEST_TIMEOUT_MS } from "./fileBackedDbTestTimeout";

/**
 * Issue #6225 (#6148/#6213 follow-up): the whole point of persisting
 * tool-selection-profile provenance is that it survives an ACTUAL daemon
 * restart — a real close of the sqlite connection followed by a fresh process
 * reopening the same on-disk file, not just a second in-memory instance. This
 * exercises that real close/reopen against a real file-backed DB, mirroring
 * `navigationProvenanceLifecycle.integration.test.ts`.
 */
describe("tool-selection-profile provenance — real daemon-restart durability", () => {
  let harness = createFileBackedDbHarness();

  beforeEach(() => {
    harness = createFileBackedDbHarness();
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  test(
    "a minted profile is recognized after a real close+reopen; a fabricated one never is",
    async () => {
      // "Before restart": daemon process 1 mints and records a profile.
      const before = await harness.openLifecycleTestDb("tool-selection-profile-provenance-");
      const dir = before.dir;
      try {
        const dbBefore = before.module.getDatabase() as Kysely<Database>;
        const repoBefore = new ToolSelectionProfileProvenanceRepository(dbBefore);
        const registryBefore = new PersistentToolSelectionProfileRegistry(repoBefore);

        // Write-through directly on the repository (not the fire-and-forget
        // `record()` path) so the persistence write is deterministically awaited
        // before the "restart".
        await repoBefore.insert("minted-uuid");
        registryBefore.record("minted-uuid");
        expect(registryBefore.has("minted-uuid")).toBe(true);
        expect(registryBefore.has("fabricated-uuid")).toBe(false);
      } finally {
        // Close the connection WITHOUT deleting the temp dir — a real daemon
        // restart keeps the on-disk file, it just re-opens a new connection.
        await before.module.closeDatabase();
      }

      // "After restart": daemon process 2 re-opens the SAME on-disk file (the
      // harness leaves AUTOMOBILE_DB_DIR bound to `dir`) with a fresh module
      // instance and a brand-new, empty in-memory registry.
      const after = await harness.importFreshDatabaseModule();
      try {
        after.getDatabase();
        await after.ensureMigrations();
        expect(after.getDatabasePath().startsWith(dir)).toBe(true);

        const dbAfter = after.getDatabase() as Kysely<Database>;
        const repoAfter = new ToolSelectionProfileProvenanceRepository(dbAfter);
        const registryAfter = new PersistentToolSelectionProfileRegistry(repoAfter);

        // Before load(): a fresh in-memory registry recognizes nothing yet.
        expect(registryAfter.has("minted-uuid")).toBe(false);

        await registryAfter.load();

        // The legitimately-minted profile survives the restart and is
        // recognized without re-minting...
        expect(registryAfter.has("minted-uuid")).toBe(true);
        // ...while a value that was never minted is still rejected, because it
        // was never persisted in the first place.
        expect(registryAfter.has("fabricated-uuid")).toBe(false);
      } finally {
        await after.closeDatabase();
      }
    },
    WINDOWS_FILE_DB_TEST_TIMEOUT_MS,
  );
});
