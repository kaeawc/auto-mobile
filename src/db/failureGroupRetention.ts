import { sql, type Kysely } from "kysely";
import type { Database } from "./types";

/**
 * Delete failure groups left with no occurrences after a row-cap prune. Uses a correlated
 * NOT EXISTS (index-served, early-exit) rather than materializing the full DISTINCT set
 * for a NOT IN scan.
 */
export async function deleteOrphanFailureGroups(db: Kysely<Database>): Promise<void> {
  await db
    .deleteFrom("failure_groups")
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom("failure_occurrences")
            .select(sql`1`.as("one"))
            .whereRef("failure_occurrences.group_id", "=", "failure_groups.id"),
        ),
      ),
    )
    .execute();
}
