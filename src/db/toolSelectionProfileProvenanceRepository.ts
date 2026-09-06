import type { Kysely } from "kysely";
import { ensureMigrations, getDatabase } from "./database";
import type { Database } from "./types";
import { logger } from "../utils/logger";

/**
 * The narrow slice of `ToolSelectionProfileProvenanceRepository` that
 * `ToolSelectionProfileRegistry` (`src/server/toolSelectionProfileRegistry.ts`)
 * actually consumes (YAGNI). The concrete repository holds a private `db`
 * field, so a structurally-compatible test fake could not satisfy the
 * concrete class type without an `as unknown as` cast — a future change to
 * the repository's real contract could then leave such a fake compiling but
 * silently wrong. Consumers (and their test fakes) depend on this interface
 * instead, so the compiler enforces the contract for real. Co-located with
 * the concrete implementation (rather than in the registry module) so the
 * registry can import just this type without a circular module dependency.
 */
export interface ToolSelectionProfileProvenanceStore {
  /** Persist a minted profile uuid. Idempotent: re-inserting the same uuid is a no-op. */
  insert(profileUuid: string): Promise<void>;
  /** Every previously-minted profile uuid, for reloading into the in-memory registry at startup. */
  loadAll(): Promise<string[]>;
}

/**
 * Durable membership set for `ToolSelectionProfileRegistry` (issue #6225): one
 * row per crypto-random tool-selection-profile uuid this daemon process has
 * minted. Backs the in-memory registry's write-through/load so a legitimately
 * minted profile survives a daemon restart/upgrade, while a value never
 * inserted here is still rejected after one.
 *
 * Both operations are best-effort (log-and-continue on failure), matching
 * `DeviceLockRepository`: a persistence hiccup must degrade to the pre-#6225
 * in-memory-only behavior (re-mint on reconnect), never fail the `setToolEnabled`
 * call that triggered it or block daemon startup.
 */
export class ToolSelectionProfileProvenanceRepository implements ToolSelectionProfileProvenanceStore {
  private db: Kysely<Database> | null;

  constructor(db?: Kysely<Database>) {
    this.db = db ?? null;
  }

  private async getDb(): Promise<Kysely<Database>> {
    if (this.db) {
      return this.db;
    }
    await ensureMigrations();
    return getDatabase();
  }

  /** Record a minted profile uuid. Idempotent: re-inserting the same uuid is a no-op. */
  async insert(profileUuid: string): Promise<void> {
    try {
      const db = await this.getDb();
      await db
        .insertInto("tool_selection_profile_provenance")
        .values({ profile_uuid: profileUuid })
        .onConflict((oc) => oc.column("profile_uuid").doNothing())
        .execute();
    } catch (error) {
      logger.warn(
        `[ToolSelectionProfileProvenanceRepository] Failed to persist minted profile ${profileUuid}: ${error}`,
      );
    }
  }

  /** Every previously-minted profile uuid, for reloading into the in-memory registry at startup. */
  async loadAll(): Promise<string[]> {
    try {
      const db = await this.getDb();
      const rows = await db
        .selectFrom("tool_selection_profile_provenance")
        .select(["profile_uuid"])
        .execute();
      return rows.map((row) => row.profile_uuid);
    } catch (error) {
      logger.warn(
        `[ToolSelectionProfileProvenanceRepository] Failed to load persisted profiles: ${error}`,
      );
      return [];
    }
  }
}
