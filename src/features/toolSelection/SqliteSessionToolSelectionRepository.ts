import type { Kysely } from "kysely";
import { getDatabase } from "../../db/database";
import type { Database } from "../../db/types";
import type { SessionToolSelectionRepository } from "./SessionToolSelectionService";

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

  async deleteSession(sessionUuid: string): Promise<void> {
    await this.resolveDatabase()
      .deleteFrom("session_tool_overrides")
      .where("session_uuid", "=", sessionUuid)
      .execute();
  }
}
