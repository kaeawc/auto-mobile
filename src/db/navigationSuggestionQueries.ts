import { sql, type Kysely } from "kysely";
import type {
  Database,
  NavigationNodeFingerprint,
  NavigationSuggestion,
  NewNavigationSuggestion,
  NavigationBuildKey,
  NewNavigationBuildKey,
  NewNavigationNodeObservation,
  NewNavigationEdgeObservation,
  NewNavigationSuggestionObservation,
} from "./types";
import { logger } from "../utils/logger";
import type {
  NavigationEdgeProvenanceRow,
  NavigationNodeProvenanceRow,
  NavigationQueryContext,
} from "./navigationRepositoryTypes";

export async function addOrUpdateSuggestion(
  ctx: NavigationQueryContext,
  appId: string,
  hash: string,
  data: string,
  timestamp: number,
): Promise<NavigationSuggestion> {
  const db = ctx.getDb();

  // Atomic upsert on UNIQUE(app_id, fingerprint_hash)
  // (idx_navigation_suggestions_app_hash). occurrence_count increments in SQL so a
  // concurrent first-create no longer throws a UNIQUE collision and concurrent
  // revisits don't lose increments (R2356). first_seen_at and promoted_to_fingerprint_id
  // are left untouched on the conflict path so a prior promotion is never clobbered.
  const newSuggestion: NewNavigationSuggestion = {
    app_id: appId,
    fingerprint_hash: hash,
    fingerprint_data: data,
    first_seen_at: timestamp,
    last_seen_at: timestamp,
    occurrence_count: 1,
    promoted_to_fingerprint_id: null,
  };

  const result = await db
    .insertInto("navigation_suggestions")
    .values(newSuggestion)
    .onConflict((oc) =>
      oc.columns(["app_id", "fingerprint_hash"]).doUpdateSet((eb) => ({
        last_seen_at: timestamp,
        occurrence_count: eb("navigation_suggestions.occurrence_count", "+", 1),
      })),
    )
    .returningAll()
    .executeTakeFirstOrThrow();

  return result;
}

/** The build, device and session one provenance observation was made under. */
export interface ObservationSource {
  buildKeyId: number;
  deviceId: string;
  sessionUuid: string;
}

export async function recordSuggestionObservation(
  ctx: NavigationQueryContext,
  suggestionId: number,
  source: ObservationSource,
  seenAt: number,
): Promise<void> {
  const { buildKeyId, deviceId, sessionUuid } = source;
  const observation: NewNavigationSuggestionObservation = {
    suggestion_id: suggestionId,
    build_key_id: buildKeyId,
    device_id: deviceId,
    session_uuid: sessionUuid,
    first_seen_at: seenAt,
    last_seen_at: seenAt,
  };
  await ctx
    .getDb()
    .insertInto("navigation_suggestion_observations")
    .values(observation)
    .onConflict((oc) =>
      oc.columns(["suggestion_id", "build_key_id", "device_id", "session_uuid"]).doUpdateSet({
        first_seen_at: sql`min(navigation_suggestion_observations.first_seen_at, ${seenAt})`,
        last_seen_at: sql`max(navigation_suggestion_observations.last_seen_at, ${seenAt})`,
      }),
    )
    .execute();
}

export async function transferSuggestionObservations(
  ctx: NavigationQueryContext,
  suggestionId: number,
  nodeId: number,
): Promise<boolean> {
  const rows = await ctx
    .getDb()
    .selectFrom("navigation_suggestion_observations")
    .select(["build_key_id", "device_id", "session_uuid", "first_seen_at", "last_seen_at"])
    .where("suggestion_id", "=", suggestionId)
    .execute();

  for (const row of rows) {
    await recordNodeObservationWindow(
      ctx,
      nodeId,
      { buildKeyId: row.build_key_id, deviceId: row.device_id, sessionUuid: row.session_uuid },
      { firstSeenAt: row.first_seen_at, lastSeenAt: row.last_seen_at },
    );
  }
  if (rows.length > 0) {
    await ctx
      .getDb()
      .deleteFrom("navigation_suggestion_observations")
      .where("suggestion_id", "=", suggestionId)
      .execute();
  }
  return rows.length > 0;
}

export async function promoteSuggestion(
  ctx: NavigationQueryContext,
  suggestionId: number,
  nodeId: number,
  timestamp: number,
): Promise<NavigationNodeFingerprint> {
  const db = ctx.getDb();
  if (db.isTransaction) {
    return promoteSuggestionWithin(ctx, db, suggestionId, nodeId, timestamp);
  }

  return db
    .transaction()
    .execute((trx) => promoteSuggestionWithin(ctx, trx, suggestionId, nodeId, timestamp));
}

async function promoteSuggestionWithin(
  ctx: NavigationQueryContext,
  db: Kysely<Database>,
  suggestionId: number,
  nodeId: number,
  timestamp: number,
): Promise<NavigationNodeFingerprint> {
  // Get the suggestion
  const suggestion = await db
    .selectFrom("navigation_suggestions")
    .selectAll()
    .where("id", "=", suggestionId)
    .executeTakeFirst();

  if (!suggestion) {
    throw new Error(`Suggestion not found: ${suggestionId}`);
  }

  // Create fingerprint record (using app_id from suggestion)
  const fingerprint = await ctx.repository
    .withExecutor(db)
    .getOrCreateFingerprint(
      suggestion.app_id,
      nodeId,
      suggestion.fingerprint_hash,
      suggestion.fingerprint_data,
      timestamp,
    );

  // Link suggestion to fingerprint
  await db
    .updateTable("navigation_suggestions")
    .set({ promoted_to_fingerprint_id: fingerprint.id })
    .where("id", "=", suggestionId)
    .execute();

  logger.info(`[NAV_REPO] Promoted suggestion ${suggestionId} to node ${nodeId}`);

  return fingerprint;
}

export async function hasNamedNodes(ctx: NavigationQueryContext, appId: string): Promise<boolean> {
  const db = ctx.getDb();
  const result = await db
    .selectFrom("navigation_nodes")
    .select(db.fn.countAll<number>().as("count"))
    .where("app_id", "=", appId)
    .executeTakeFirst();

  return Number(result?.count || 0) > 0;
}

export async function getSuggestions(
  ctx: NavigationQueryContext,
  appId: string,
): Promise<NavigationSuggestion[]> {
  const db = ctx.getDb();
  return db
    .selectFrom("navigation_suggestions")
    .selectAll()
    .where("app_id", "=", appId)
    .where("promoted_to_fingerprint_id", "is", null)
    .orderBy("occurrence_count", "desc")
    .execute();
}

export async function getOrCreateBuildKey(
  ctx: NavigationQueryContext,
  appId: string,
  versionCode: number,
  contentHash: string,
): Promise<NavigationBuildKey> {
  const db = ctx.getDb();
  const newBuildKey: NewNavigationBuildKey = {
    app_id: appId,
    version_code: versionCode,
    content_hash: contentHash,
  };

  return db
    .insertInto("navigation_build_keys")
    .values(newBuildKey)
    .onConflict((oc) =>
      oc.columns(["app_id", "version_code", "content_hash"]).doUpdateSet((eb) => ({
        app_id: eb.ref("navigation_build_keys.app_id"),
      })),
    )
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function recordNodeObservation(
  ctx: NavigationQueryContext,
  nodeId: number,
  source: ObservationSource,
  seenAt: number,
): Promise<void> {
  await recordNodeObservationWindow(ctx, nodeId, source, {
    firstSeenAt: seenAt,
    lastSeenAt: seenAt,
  });
}

async function recordNodeObservationWindow(
  ctx: NavigationQueryContext,
  nodeId: number,
  { buildKeyId, deviceId, sessionUuid }: ObservationSource,
  { firstSeenAt, lastSeenAt }: { firstSeenAt: number; lastSeenAt: number },
): Promise<void> {
  const db = ctx.getDb();
  const observation: NewNavigationNodeObservation = {
    node_id: nodeId,
    build_key_id: buildKeyId,
    device_id: deviceId,
    session_uuid: sessionUuid,
    first_seen_at: firstSeenAt,
    last_seen_at: lastSeenAt,
  };

  await db
    .insertInto("navigation_node_observations")
    .values(observation)
    .onConflict((oc) =>
      oc.columns(["node_id", "build_key_id", "device_id", "session_uuid"]).doUpdateSet({
        first_seen_at: sql`min(navigation_node_observations.first_seen_at, ${firstSeenAt})`,
        last_seen_at: sql`max(navigation_node_observations.last_seen_at, ${lastSeenAt})`,
      }),
    )
    .execute();
}

export async function recordEdgeObservation(
  ctx: NavigationQueryContext,
  edgeId: number,
  source: ObservationSource,
  seenAt: number,
): Promise<void> {
  const { buildKeyId, deviceId, sessionUuid } = source;
  const db = ctx.getDb();
  const observation: NewNavigationEdgeObservation = {
    edge_id: edgeId,
    build_key_id: buildKeyId,
    device_id: deviceId,
    session_uuid: sessionUuid,
    first_seen_at: seenAt,
    last_seen_at: seenAt,
  };

  await db
    .insertInto("navigation_edge_observations")
    .values(observation)
    .onConflict((oc) =>
      oc.columns(["edge_id", "build_key_id", "device_id", "session_uuid"]).doUpdateSet({
        first_seen_at: sql`min(navigation_edge_observations.first_seen_at, ${seenAt})`,
        last_seen_at: sql`max(navigation_edge_observations.last_seen_at, ${seenAt})`,
      }),
    )
    .execute();
}

export async function getNodeProvenanceForApp(
  ctx: NavigationQueryContext,
  appId: string,
): Promise<NavigationNodeProvenanceRow[]> {
  const db = ctx.getDb();
  return (
    db
      .selectFrom("navigation_node_observations as obs")
      .innerJoin("navigation_build_keys as bk", "bk.id", "obs.build_key_id")
      .innerJoin("navigation_nodes as n", "n.id", "obs.node_id")
      .where("n.app_id", "=", appId)
      // Constrain the build key to the node's own app: observation rows accept
      // independent entity + build-key ids, so a mis-scoped build key must not
      // surface another app's provenance in this app-union (#4985).
      .whereRef("bk.app_id", "=", "n.app_id")
      .select([
        "obs.node_id as node_id",
        "bk.app_id as package_id",
        "bk.version_code as version_code",
        "bk.content_hash as content_hash",
        "obs.device_id as device_id",
        "obs.session_uuid as session_uuid",
        "obs.last_seen_at as last_seen_at",
      ])
      .orderBy("obs.last_seen_at", "desc")
      .orderBy("obs.device_id", "asc")
      .execute()
  );
}

export async function getEdgeProvenanceForApp(
  ctx: NavigationQueryContext,
  appId: string,
): Promise<NavigationEdgeProvenanceRow[]> {
  const db = ctx.getDb();
  return (
    db
      .selectFrom("navigation_edge_observations as obs")
      .innerJoin("navigation_build_keys as bk", "bk.id", "obs.build_key_id")
      .innerJoin("navigation_edges as e", "e.id", "obs.edge_id")
      .where("e.app_id", "=", appId)
      // Symmetric to the node query: pin the build key to the edge's own app so
      // a mis-scoped build key cannot leak another app's provenance (#4985).
      .whereRef("bk.app_id", "=", "e.app_id")
      .select([
        "obs.edge_id as edge_id",
        "bk.app_id as package_id",
        "bk.version_code as version_code",
        "bk.content_hash as content_hash",
        "obs.device_id as device_id",
        "obs.session_uuid as session_uuid",
        "obs.last_seen_at as last_seen_at",
      ])
      .orderBy("obs.last_seen_at", "desc")
      .orderBy("obs.device_id", "asc")
      .execute()
  );
}
