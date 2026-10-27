import { sql, type Kysely } from "kysely";
import type { Database } from "./types";

interface BuildKeyRow {
  id: number;
  appId: string;
}

interface EvictionCandidate {
  kind: "node" | "edge" | "suggestion";
  id: number;
  buildKeyId: number;
  lastSeenAt: number;
}

// ---------------------------------------------------------------------------
// Free helpers (kept small so the class methods stay under the complexity gate).
// ---------------------------------------------------------------------------

export async function loadBuildKeys(
  db: Kysely<Database>,
  appIds?: readonly string[],
): Promise<BuildKeyRow[]> {
  let query = db.selectFrom("navigation_build_keys").select(["id", "app_id"]);
  if (appIds && appIds.length > 0) {
    query = query.where("app_id", "in", appIds);
  }
  const rows = await query.execute();
  return rows.map((row) => ({ id: row.id, appId: row.app_id }));
}

/**
 * The active/most-recent build key per app: the one whose observations have the
 * greatest `last_seen_at` (ties and no-observation apps fall back to the newest
 * build-key id). These are never age-pruned or orphan-swept.
 */
export async function computeProtectedBuildKeyIds(
  db: Kysely<Database>,
  buildKeys?: BuildKeyRow[],
  appIds?: readonly string[],
): Promise<number[]> {
  const keys = buildKeys ?? (await loadBuildKeys(db, appIds));
  if (keys.length === 0) {
    return [];
  }
  const maxSeen = await loadMaxSeenByBuildKey(db, appIds);

  // Per app, pick the build key with the greatest (lastSeen, id).
  const best = new Map<string, { id: number; seen: number }>();
  for (const bk of keys) {
    const seen = maxSeen.get(bk.id) ?? Number.NEGATIVE_INFINITY;
    if (isNewerBuild(best.get(bk.appId), bk.id, seen)) {
      best.set(bk.appId, { id: bk.id, seen });
    }
  }

  return Array.from(best.values(), (entry) => entry.id);
}

function isNewerBuild(
  current: { id: number; seen: number } | undefined,
  id: number,
  seen: number,
): boolean {
  if (current === undefined) {
    return true;
  }
  return seen > current.seen || (seen === current.seen && id > current.id);
}

export function containSameIds(left: readonly number[], right: readonly number[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const rightIds = new Set(right);
  return left.every((id) => rightIds.has(id));
}

/** Greatest `last_seen_at` per build key across all observation tables. */
async function loadMaxSeenByBuildKey(
  db: Kysely<Database>,
  appIds?: readonly string[],
): Promise<Map<number, number>> {
  let nodeQuery = db
    .selectFrom("navigation_node_observations as observation")
    .innerJoin("navigation_build_keys as buildKey", "buildKey.id", "observation.build_key_id")
    .select((eb) => [
      "observation.build_key_id",
      eb.fn.max("observation.last_seen_at").as("max_seen"),
    ]);
  let edgeQuery = db
    .selectFrom("navigation_edge_observations as observation")
    .innerJoin("navigation_build_keys as buildKey", "buildKey.id", "observation.build_key_id")
    .select((eb) => [
      "observation.build_key_id",
      eb.fn.max("observation.last_seen_at").as("max_seen"),
    ]);
  let suggestionQuery = db
    .selectFrom("navigation_suggestion_observations as observation")
    .innerJoin("navigation_build_keys as buildKey", "buildKey.id", "observation.build_key_id")
    .select((eb) => [
      "observation.build_key_id",
      eb.fn.max("observation.last_seen_at").as("max_seen"),
    ]);
  if (appIds && appIds.length > 0) {
    nodeQuery = nodeQuery.where("buildKey.app_id", "in", appIds);
    edgeQuery = edgeQuery.where("buildKey.app_id", "in", appIds);
    suggestionQuery = suggestionQuery.where("buildKey.app_id", "in", appIds);
  }
  const nodeMax = await nodeQuery.groupBy("observation.build_key_id").execute();
  const edgeMax = await edgeQuery.groupBy("observation.build_key_id").execute();
  const suggestionMax = await suggestionQuery.groupBy("observation.build_key_id").execute();

  const maxSeen = new Map<number, number>();
  for (const row of [...nodeMax, ...edgeMax, ...suggestionMax]) {
    const seen = Number(row.max_seen ?? 0);
    const prev = maxSeen.get(row.build_key_id);
    if (prev === undefined || seen > prev) {
      maxSeen.set(row.build_key_id, seen);
    }
  }
  return maxSeen;
}

export async function loadMaxSeenByBuildKeyIds(
  db: Kysely<Database>,
  ids: readonly number[],
): Promise<Map<number, number>> {
  if (ids.length === 0) {
    return new Map();
  }
  const uniqueIds = Array.from(new Set(ids));
  return loadMaxSeenByBuildKeyForIds(db, uniqueIds);
}

async function loadMaxSeenByBuildKeyForIds(
  db: Kysely<Database>,
  ids: number[],
): Promise<Map<number, number>> {
  const nodeMax = await db
    .selectFrom("navigation_node_observations")
    .select((eb) => ["build_key_id", eb.fn.max("last_seen_at").as("max_seen")])
    .where("build_key_id", "in", ids)
    .groupBy("build_key_id")
    .execute();
  const edgeMax = await db
    .selectFrom("navigation_edge_observations")
    .select((eb) => ["build_key_id", eb.fn.max("last_seen_at").as("max_seen")])
    .where("build_key_id", "in", ids)
    .groupBy("build_key_id")
    .execute();
  const suggestionMax = await db
    .selectFrom("navigation_suggestion_observations")
    .select((eb) => ["build_key_id", eb.fn.max("last_seen_at").as("max_seen")])
    .where("build_key_id", "in", ids)
    .groupBy("build_key_id")
    .execute();
  const maxSeen = new Map<number, number>();
  for (const row of [...nodeMax, ...edgeMax, ...suggestionMax]) {
    const seen = Number(row.max_seen ?? 0);
    const previous = maxSeen.get(row.build_key_id);
    if (previous === undefined || seen > previous) {
      maxSeen.set(row.build_key_id, seen);
    }
  }
  return maxSeen;
}

export async function loadProtectedNodeRows(
  db: Kysely<Database>,
  nodeIds: readonly number[],
  protectedIds: readonly number[],
): Promise<number[]> {
  if (nodeIds.length === 0 || protectedIds.length === 0) {
    return [];
  }
  const rows = await db
    .selectFrom("navigation_node_observations")
    .select("node_id")
    .where("node_id", "in", nodeIds)
    .where("build_key_id", "in", protectedIds)
    .execute();
  return rows.map((row) => row.node_id);
}

/**
 * Count observation rows (node + edge + suggestion). `appId === null` counts every row
 * (global); otherwise it joins on `app_id` (one bound param) rather than an id
 * list of the app's build keys.
 */
export async function countObservations(
  trx: Kysely<Database>,
  appId: string | null,
): Promise<number> {
  return appId === null ? countGlobalObservations(trx) : countAppObservations(trx, appId);
}

async function countGlobalObservations(trx: Kysely<Database>): Promise<number> {
  const row = await trx
    .selectNoFrom(
      sql<number>`(SELECT COUNT(*) FROM navigation_node_observations)
        + (SELECT COUNT(*) FROM navigation_edge_observations)
        + (SELECT COUNT(*) FROM navigation_suggestion_observations)`.as("c"),
    )
    .executeTakeFirstOrThrow();
  return Number(row.c);
}

async function countAppObservations(trx: Kysely<Database>, appId: string): Promise<number> {
  const row = await trx
    .selectNoFrom(
      sql<number>`(SELECT COUNT(*) FROM navigation_node_observations AS o
        JOIN navigation_build_keys AS bk ON bk.id = o.build_key_id WHERE bk.app_id = ${appId})
        + (SELECT COUNT(*) FROM navigation_edge_observations AS o
        JOIN navigation_build_keys AS bk ON bk.id = o.build_key_id WHERE bk.app_id = ${appId})
        + (SELECT COUNT(*) FROM navigation_suggestion_observations AS o
        JOIN navigation_build_keys AS bk ON bk.id = o.build_key_id WHERE bk.app_id = ${appId})`.as(
        "c",
      ),
    )
    .executeTakeFirstOrThrow();
  return Number(row.c);
}

/**
 * Collect the `limit` oldest evictable observation rows (by last_seen_at, then
 * id), optionally scoped to one app, excluding the active rows RELATIONALLY.
 * Fetches at most `limit` rows per table then merges, so it never loads the whole
 * table — only the batch being evicted.
 */
export async function collectOldestEvictable(
  trx: Kysely<Database>,
  appId: string | null,
  protectedIds: number[],
  limit: number,
): Promise<EvictionCandidate[]> {
  const nodeRows = await buildOldestNodeEvictableQuery(trx, appId, protectedIds, limit).execute();
  const edgeRows = await buildOldestEdgeEvictableQuery(trx, appId, protectedIds, limit).execute();
  const suggestionRows = await buildOldestSuggestionEvictableQuery(
    trx,
    appId,
    protectedIds,
    limit,
  ).execute();

  const candidates: EvictionCandidate[] = [
    ...nodeRows.map((row) => ({
      kind: "node" as const,
      id: row.id,
      buildKeyId: row.build_key_id,
      lastSeenAt: row.last_seen_at,
    })),
    ...edgeRows.map((row) => ({
      kind: "edge" as const,
      id: row.id,
      buildKeyId: row.build_key_id,
      lastSeenAt: row.last_seen_at,
    })),
    ...suggestionRows.map((row) => ({
      kind: "suggestion" as const,
      id: row.id,
      buildKeyId: row.build_key_id,
      lastSeenAt: row.last_seen_at,
    })),
  ];
  // Oldest first; break ties by table and then id for determinism.
  const kindOrder = { node: 0, edge: 1, suggestion: 2 };
  candidates.sort(
    (a, b) => a.lastSeenAt - b.lastSeenAt || kindOrder[a.kind] - kindOrder[b.kind] || a.id - b.id,
  );
  return candidates.slice(0, limit);
}

/**
 * Build the "oldest evictable node observations" query. Scope and active-row
 * exclusion are BOTH expressed relationally, so the bound-parameter count stays
 * O(protected apps) regardless of how many observations (or active rows) exist:
 *
 * - App scope: `build_key_id IN (SELECT id FROM navigation_build_keys WHERE
 *   app_id = ?)` — binds the app id only, not the app's build-key ids.
 * - Active-row exclusion: keep a row unless its build key is protected AND its
 *   `last_seen_at` equals that build key's max (a correlated scalar subquery). No
 *   materialized `NOT IN (activeIds)` list, which could otherwise exceed
 *   bun:sqlite's MAX_VARIABLE_NUMBER when many rows tie at the max instant or many
 *   apps are protected.
 *
 * Exported so a test can compile it and assert the O(apps) bind shape.
 */
export function buildOldestNodeEvictableQuery(
  db: Kysely<Database>,
  appId: string | null,
  protectedIds: number[],
  limit: number,
) {
  let query = db
    .selectFrom("navigation_node_observations")
    .select(["id", "build_key_id", "last_seen_at"]);
  if (appId !== null) {
    query = query.where("build_key_id", "in", (eb) =>
      eb.selectFrom("navigation_build_keys").select("id").where("app_id", "=", appId),
    );
  }
  if (protectedIds.length > 0) {
    query = query.where((eb) =>
      eb.or([
        eb("build_key_id", "not in", protectedIds),
        eb(
          "last_seen_at",
          "<>",
          eb
            .selectFrom("navigation_node_observations as t")
            .select((sb) => sb.fn.max("t.last_seen_at").as("m"))
            .whereRef("t.build_key_id", "=", "navigation_node_observations.build_key_id"),
        ),
      ]),
    );
  }
  return query.orderBy("last_seen_at", "asc").orderBy("id", "asc").limit(limit);
}

/** Edge-table counterpart of {@link buildOldestNodeEvictableQuery}. */
export function buildOldestEdgeEvictableQuery(
  db: Kysely<Database>,
  appId: string | null,
  protectedIds: number[],
  limit: number,
) {
  let query = db
    .selectFrom("navigation_edge_observations")
    .select(["id", "build_key_id", "last_seen_at"]);
  if (appId !== null) {
    query = query.where("build_key_id", "in", (eb) =>
      eb.selectFrom("navigation_build_keys").select("id").where("app_id", "=", appId),
    );
  }
  if (protectedIds.length > 0) {
    query = query.where((eb) =>
      eb.or([
        eb("build_key_id", "not in", protectedIds),
        eb(
          "last_seen_at",
          "<>",
          eb
            .selectFrom("navigation_edge_observations as t")
            .select((sb) => sb.fn.max("t.last_seen_at").as("m"))
            .whereRef("t.build_key_id", "=", "navigation_edge_observations.build_key_id"),
        ),
      ]),
    );
  }
  return query.orderBy("last_seen_at", "asc").orderBy("id", "asc").limit(limit);
}

/** Suggestion-table counterpart of {@link buildOldestNodeEvictableQuery}. */
export function buildOldestSuggestionEvictableQuery(
  db: Kysely<Database>,
  appId: string | null,
  protectedIds: number[],
  limit: number,
) {
  let query = db
    .selectFrom("navigation_suggestion_observations")
    .select(["id", "build_key_id", "last_seen_at"]);
  if (appId !== null) {
    query = query.where("build_key_id", "in", (eb) =>
      eb.selectFrom("navigation_build_keys").select("id").where("app_id", "=", appId),
    );
  }
  if (protectedIds.length > 0) {
    query = query.where((eb) =>
      eb.or([
        eb("build_key_id", "not in", protectedIds),
        eb(
          "last_seen_at",
          "<>",
          eb
            .selectFrom("navigation_suggestion_observations as t")
            .select((sb) => sb.fn.max("t.last_seen_at").as("m"))
            .whereRef("t.build_key_id", "=", "navigation_suggestion_observations.build_key_id"),
        ),
      ]),
    );
  }
  return query.orderBy("last_seen_at", "asc").orderBy("id", "asc").limit(limit);
}
