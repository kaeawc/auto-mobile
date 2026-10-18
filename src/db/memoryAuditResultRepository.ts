import type { Kysely } from "kysely";
import { getDatabase } from "./database";
import type { Database, NewMemoryAuditResult } from "./types";

/**
 * Persistence for `memory_audit_results` rows. The Kysely handle is resolved
 * lazily per call (an injected handle wins) so constructing a repository never
 * opens the real file-backed database (issue #3067).
 */
export class MemoryAuditResultRepository {
  constructor(private readonly injectedDb?: Kysely<Database>) {}

  async insert(result: NewMemoryAuditResult): Promise<void> {
    const db = this.injectedDb ?? getDatabase();
    await db.insertInto("memory_audit_results").values(result).execute();
  }
}
