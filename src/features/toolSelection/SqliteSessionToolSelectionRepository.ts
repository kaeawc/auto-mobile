import type { Kysely } from "kysely";
import { getDatabase } from "../../db/database";
import type { Database } from "../../db/types";
import type {
  SessionToolSelectionEntry,
  SessionToolSelectionRepository,
} from "./SessionToolSelectionService";

export class SqliteSessionToolSelectionRepository implements SessionToolSelectionRepository {
  constructor(private readonly resolveDatabase: () => Kysely<Database> = getDatabase) {}

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
          updated_at: new Date().toISOString(),
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
    const updatedAt = new Date().toISOString();
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
