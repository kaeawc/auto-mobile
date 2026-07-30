import type { Kysely } from "kysely";
import { getDatabase } from "../../db/database";
import type { Database } from "../../db/types";
import type { SessionToolProfileRepository } from "./SessionToolProfileService";

export class SqliteSessionToolProfileRepository implements SessionToolProfileRepository {
  constructor(private readonly db: Kysely<Database> = getDatabase()) {}

  async list(sessionUuid: string): Promise<Map<string, boolean>> {
    const rows = await this.db.selectFrom("session_tool_capabilities")
      .select(["capability", "enabled"])
      .where("session_uuid", "=", sessionUuid)
      .execute();
    return new Map(rows.map(row => [row.capability, row.enabled !== 0]));
  }

  async set(sessionUuid: string, capability: string, enabled: boolean): Promise<void> {
    await this.db.insertInto("session_tool_capabilities")
      .values({ session_uuid: sessionUuid, capability, enabled: enabled ? 1 : 0 })
      .onConflict(conflict => conflict.columns(["session_uuid", "capability"]).doUpdateSet({
        enabled: enabled ? 1 : 0,
        updated_at: new Date().toISOString(),
      }))
      .execute();
  }

  async deleteSession(sessionUuid: string): Promise<void> {
    await this.db.deleteFrom("session_tool_capabilities")
      .where("session_uuid", "=", sessionUuid)
      .execute();
  }
}
