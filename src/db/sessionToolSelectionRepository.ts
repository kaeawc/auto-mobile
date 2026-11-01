import type { Kysely } from "kysely";
import { getDatabase } from "./database";
import { nowIso } from "./nowIso";
import type { Database } from "./types";
import { defaultTimer, type Timer } from "../utils/SystemTimer";
import type { RepositoryDeps } from "./repositoryDeps";

/** One tool's enable/disable decision inside a batch write. */
export interface SessionToolSelectionEntry {
  toolName: string;
  enabled: boolean;
}

/** Persistent per-session overrides keyed by exact MCP tool name. */
export interface SessionToolSelectionRepository {
  list(sessionUuid: string): Promise<Map<string, boolean>>;
  set(sessionUuid: string, toolName: string, enabled: boolean): Promise<void>;
  /**
   * Persist a whole batch atomically — either every entry lands or none does
   * (#6886 review). Optional: a repository that cannot offer that (an in-memory
   * test double) is written one entry at a time by the service instead. The
   * production SQLite repository implements it with a transaction, which is what
   * makes `setToolEnabled { toolNames: [...] }`'s advertised all-or-nothing
   * contract hold against a mid-batch write failure and against a concurrent
   * enable/disable batch for the same session.
   */
  setMany?(sessionUuid: string, entries: readonly SessionToolSelectionEntry[]): Promise<void>;
  deleteSession(sessionUuid: string): Promise<void>;
}

export class SqliteSessionToolSelectionRepository implements SessionToolSelectionRepository {
  private readonly resolveDatabase: () => Kysely<Database>;
  private readonly timer: Timer;

  /** `resolveDatabase` is called per query, so construction never opens the default database. */
  constructor({
    resolveDatabase = getDatabase,
    timer = defaultTimer,
  }: Pick<RepositoryDeps, "timer"> & { resolveDatabase?: () => Kysely<Database> } = {}) {
    this.resolveDatabase = resolveDatabase;
    this.timer = timer;
  }

  async list(sessionUuid: string): Promise<Map<string, boolean>> {
    const rows = await this.resolveDatabase()
      .selectFrom("session_tool_overrides")
      .select(["tool_name", "enabled"])
      .where("session_uuid", "=", sessionUuid)
      .execute();
    return new Map(rows.map((row) => [row.tool_name, row.enabled !== 0]));
  }

  async set(sessionUuid: string, toolName: string, enabled: boolean): Promise<void> {
    await this.resolveDatabase()
      .insertInto("session_tool_overrides")
      .values({ session_uuid: sessionUuid, tool_name: toolName, enabled: enabled ? 1 : 0 })
      .onConflict((conflict) =>
        conflict.columns(["session_uuid", "tool_name"]).doUpdateSet({
          enabled: enabled ? 1 : 0,
          updated_at: nowIso(this.timer),
        }),
      )
      .execute();
  }

  /**
   * One transaction for the whole batch, so `setToolEnabled { toolNames: [...] }`
   * is all-or-nothing at the storage layer too (#6886 review): a rejection on a
   * later row rolls the earlier ones back, and a concurrent batch for the same
   * session cannot interleave between them.
   */
  async setMany(sessionUuid: string, entries: readonly SessionToolSelectionEntry[]): Promise<void> {
    if (entries.length === 0) {
      return;
    }
    const updatedAt = nowIso(this.timer);
    await this.resolveDatabase()
      .transaction()
      .execute(async (trx) => {
        for (const entry of entries) {
          await trx
            .insertInto("session_tool_overrides")
            .values({
              session_uuid: sessionUuid,
              tool_name: entry.toolName,
              enabled: entry.enabled ? 1 : 0,
            })
            .onConflict((conflict) =>
              conflict.columns(["session_uuid", "tool_name"]).doUpdateSet({
                enabled: entry.enabled ? 1 : 0,
                updated_at: updatedAt,
              }),
            )
            .execute();
        }
      });
  }

  async deleteSession(sessionUuid: string): Promise<void> {
    await this.resolveDatabase()
      .deleteFrom("session_tool_overrides")
      .where("session_uuid", "=", sessionUuid)
      .execute();
  }
}
