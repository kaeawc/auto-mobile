import type { Kysely } from "kysely";
import { getDatabase } from "./database";
import type { Database, NewRecompositionMetrics } from "./types";
import type { RepositoryDeps } from "./repositoryDeps";

/**
 * Persistence for `recomposition_metrics` rows. The Kysely handle is resolved
 * lazily per call so constructing a repository never opens the real
 * file-backed database (issue #3067).
 */
export class RecompositionMetricsRepository {
  private readonly database: () => Kysely<Database>;

  /** `resolveDatabase` is called per query, so construction never opens the default database. */
  constructor({
    resolveDatabase = getDatabase,
  }: { resolveDatabase?: () => Kysely<Database> } = {}) {
    this.database = resolveDatabase;
  }

  async insertMany(rows: NewRecompositionMetrics[]): Promise<void> {
    if (rows.length === 0) {
      return;
    }
    await this.database().insertInto("recomposition_metrics").values(rows).execute();
  }

  /** Delete the oldest rows (by timestamp) so at most `maxRows` remain. */
  async pruneToMaxRows(maxRows: number): Promise<void> {
    const db = this.database();
    const result = await db
      .selectFrom("recomposition_metrics")
      .select(({ fn }) => fn.count<number>("id").as("count"))
      .executeTakeFirst();

    const count = Number(result?.count ?? 0);
    if (count <= maxRows) {
      return;
    }

    const deleteCount = count - maxRows;
    await db
      .deleteFrom("recomposition_metrics")
      .where(
        "id",
        "in",
        db.selectFrom("recomposition_metrics").select("id").orderBy("timestamp").limit(deleteCount),
      )
      .execute();
  }
}
