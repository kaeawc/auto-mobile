import type { Kysely } from "kysely";
import type { Database } from "./types";
import { getDb } from "./eventRepositoryBase";

export interface FailureBackfillQuery {
  failureType: "crash" | "anr" | "nonfatal";
  deviceId?: string;
  sessionId?: string;
  limit: number;
}

/** Navigation nodes whose screen name is one of `screenNames` (telemetry screenshot URI lookup). */
export async function getNavigationNodesByScreenNames(
  screenNames: readonly string[],
  db?: Kysely<Database>,
) {
  return getDb(db)
    .selectFrom("navigation_nodes")
    .select(["id", "screen_name", "app_id"])
    .where("screen_name", "in", [...screenNames])
    .execute();
}

/** Failure occurrences joined to their groups, newest first, for telemetry backfill. */
export async function getFailureBackfillRows(query: FailureBackfillQuery, db?: Kysely<Database>) {
  const { failureType, deviceId, sessionId, limit } = query;
  let q = getDb(db)
    .selectFrom("failure_occurrences")
    .innerJoin("failure_groups", "failure_groups.id", "failure_occurrences.group_id")
    .select([
      "failure_occurrences.id as occurrenceId",
      "failure_occurrences.group_id as groupId",
      "failure_occurrences.timestamp",
      "failure_occurrences.device_id as deviceId",
      // Selected so the crash/ANR/tool-failure backfill can report the
      // originating session like every sibling projection does (#4209).
      "failure_occurrences.session_id as sessionId",
      "failure_occurrences.screen_at_failure as screen",
      "failure_groups.type",
      "failure_groups.severity",
      "failure_groups.title",
      "failure_groups.stack_trace_json",
    ])
    .where("failure_groups.type", "=", failureType);

  // Always filter by device — never send failures with empty/null device_id
  if (deviceId) {
    q = q.where("failure_occurrences.device_id", "=", deviceId);
  } else {
    q = q
      .where("failure_occurrences.device_id", "is not", null)
      .where("failure_occurrences.device_id", "!=", "");
  }
  if (sessionId) {
    q = q.where("failure_occurrences.session_id", "=", sessionId);
  }

  return q.orderBy("failure_occurrences.timestamp", "desc").limit(limit).execute();
}
