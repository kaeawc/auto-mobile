// nav (app,build) Phase 3: tiered TTL + global LRU size-cap retention (#4986).
//
// Bounds the accumulated cross-build/device/session navigation data written by
// Phases 1/2. Two tiers, plus a size-cap backstop, all keyed on the same
// `last_seen_at` recency signal that drives Phase 2's provenance fade:
//
//   1. SHORT TTL — heavy transient assets. The only heavy asset the nav DB
//      references is a node's `screenshot_path`. Stale screenshots have their
//      pointer cleared (and the file best-effort unlinked); the light node row
//      itself survives under the long tier.
//   2. LONG TTL — nav-graph structure + provenance. The per-observation rows
//      (navigation_node_observations / navigation_edge_observations) are the
//      unbounded surface — one row per (build, device, session) per node/edge —
//      so they are pruned by age, and build keys orphaned by that prune are
//      swept. Nodes/edges themselves are bounded (one per screen/transition) and
//      durable, so they are intentionally NOT age-deleted here. The TTL tier
//      spares the active build key entirely (never age-delete what is current).
//   3. Global LRU size cap — a backstop enforcing a per-app AND a global budget
//      on the observation rows, evicting oldest by `last_seen_at`. Unlike the TTL
//      tier, the cap counts the active build key's rows too (otherwise a
//      continuously-used single-build app would never be bounded), but it never
//      evicts the *active* rows themselves — the newest `last_seen_at` per
//      protected build key is excluded relationally (see the eviction queries).
//
// Active-data safety (AC3): the most-recently-seen build key per app is the
// active context. The TTL tier and the orphan-build-key sweep never touch it, and
// the size cap never evicts its newest observation(s). Because in-flight writes
// land on the current build key (newest `last_seen_at`), this protects whatever is
// being observed right now without a separate liveness signal. The whole pass runs
// in one transaction (atomic, no torn graph); observations are deleted before
// their orphaned build keys (FK-safe order), and file unlinks run AFTER commit as
// side effects (never inside the txn).
//
// SQLite scale safety: every statement in this module keeps its bound-parameter
// count and expression-tree depth bounded regardless of DB size. Row-count id
// lists (stale screenshots, evicted observations) are processed in batches capped
// at `evictionChunkSize` (<= MAX_EVICTION_CHUNK_SIZE, well under bun:sqlite's
// MAX_VARIABLE_NUMBER of 250_000). App/build-key filters bind at most one param
// per app (`protectedIds`, `activeIds`) or use a join on `app_id` (no id list at
// all), and the active-row lookup is a relational max-join, never a per-row OR
// chain. See the per-helper notes below.

import type { Kysely } from "kysely";
import type { Database } from "./types";
import { logger as defaultLogger, type Logger } from "../utils/logger";

/** Tunable retention thresholds. All durations are milliseconds. */
export interface NavigationRetentionConfig {
  /** SHORT tier: max age of a node screenshot before its pointer is cleared. */
  screenshotTtlMs: number;
  /** LONG tier: max age of an observation row before it is pruned. */
  structureTtlMs: number;
  /** Backstop: max observation rows kept per app. */
  perAppMaxObservations: number;
  /** Backstop: max observation rows kept across all apps. */
  globalMaxObservations: number;
  /**
   * Max ids bound in one batched DELETE/UPDATE. Clamped to
   * {@link MAX_EVICTION_CHUNK_SIZE} so a misconfigured value can never approach
   * bun:sqlite's `MAX_VARIABLE_NUMBER` (250_000) and defeat the batching.
   */
  evictionChunkSize: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

// Conservative defaults (hand-off merge — the maintainer owns the final policy):
// nothing surprising should be deleted, so screenshots live a week and structure
// three months, with generous size caps that only trip on genuine runaway growth.
export const DEFAULT_SCREENSHOT_TTL_MS = 7 * DAY_MS; // 7 days
export const DEFAULT_STRUCTURE_TTL_MS = 90 * DAY_MS; // ~3 months
export const DEFAULT_PER_APP_MAX_OBSERVATIONS = 50_000;
export const DEFAULT_GLOBAL_MAX_OBSERVATIONS = 500_000;
export const DEFAULT_EVICTION_CHUNK_SIZE = 5_000;

/** Default cadence of the background pass: every 6 hours. */
export const DEFAULT_NAV_RETENTION_INTERVAL_MS = 6 * 60 * 60 * 1000;

// Hard SQLite/runtime ceilings the config is validated against.
// A single DELETE/UPDATE binds at most this many ids — comfortably under
// bun:sqlite's MAX_VARIABLE_NUMBER (250_000), and small enough that each batch
// statement stays cheap.
export const MAX_EVICTION_CHUNK_SIZE = 10_000;
// setInterval delays above the signed-32-bit max are silently clamped to 1ms by
// the runtime, so an interval over this is treated as invalid and defaulted.
export const MAX_INTERVAL_MS = 2_147_483_647;

/**
 * Deletes a screenshot file previously referenced by a pruned node. Injected so
 * unit tests observe the calls without touching disk; production wires the
 * canonical filesystem unlink.
 */
export type ScreenshotFileRemover = (filePath: string) => Promise<void>;

/** Outcome of a single prune pass, surfaced for logging / a storage indicator. */
export interface NavigationRetentionSummary {
  screenshotsCleared: number;
  nodeObservationsDeleted: number;
  edgeObservationsDeleted: number;
  buildKeysDeleted: number;
  /** Clock time (ms) the pass ran at. */
  prunedAt: number;
}

function emptySummary(prunedAt: number): NavigationRetentionSummary {
  return {
    screenshotsCleared: 0,
    nodeObservationsDeleted: 0,
    edgeObservationsDeleted: 0,
    buildKeysDeleted: 0,
    prunedAt,
  };
}

/** A positive safe integer within `[1, max]`, else undefined (0/neg/NaN/float/too-big). */
function sanitizePositiveInt(
  value: number | undefined,
  max: number = Number.MAX_SAFE_INTEGER
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  return Number.isSafeInteger(value) && value > 0 && value <= max ? value : undefined;
}

/**
 * Strict env read: the ENTIRE trimmed value must be a run of digits, so partial
 * parses that `Number.parseInt` would silently accept ("1e6" -> 1, "12abc" -> 12)
 * are rejected and fall back to the default rather than becoming a 1ms interval.
 * The parsed value is then bounded by `max`.
 */
function readPositiveIntEnv(name: string, max: number = Number.MAX_SAFE_INTEGER): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw || !/^\d+$/.test(raw)) {
    return undefined;
  }
  return sanitizePositiveInt(Number.parseInt(raw, 10), max);
}

/**
 * Resolve the retention config from explicit overrides, then env, then the
 * conservative defaults. Every source is validated against its REAL ceiling — not
 * just positivity — so a stray `perAppMaxObservations: 0`, a float, or an
 * oversized chunk falls back / clamps rather than corrupting the pass.
 */
export function resolveNavigationRetentionConfig(
  overrides: Partial<NavigationRetentionConfig> = {}
): NavigationRetentionConfig {
  const resolve = (
    override: number | undefined,
    envName: string,
    def: number,
    max: number = Number.MAX_SAFE_INTEGER
  ): number => sanitizePositiveInt(override, max) ?? readPositiveIntEnv(envName, max) ?? def;

  return {
    screenshotTtlMs: resolve(
      overrides.screenshotTtlMs,
      "AUTOMOBILE_NAV_RETENTION_SCREENSHOT_TTL_MS",
      DEFAULT_SCREENSHOT_TTL_MS
    ),
    structureTtlMs: resolve(
      overrides.structureTtlMs,
      "AUTOMOBILE_NAV_RETENTION_STRUCTURE_TTL_MS",
      DEFAULT_STRUCTURE_TTL_MS
    ),
    perAppMaxObservations: resolve(
      overrides.perAppMaxObservations,
      "AUTOMOBILE_NAV_RETENTION_PER_APP_MAX_OBSERVATIONS",
      DEFAULT_PER_APP_MAX_OBSERVATIONS
    ),
    globalMaxObservations: resolve(
      overrides.globalMaxObservations,
      "AUTOMOBILE_NAV_RETENTION_GLOBAL_MAX_OBSERVATIONS",
      DEFAULT_GLOBAL_MAX_OBSERVATIONS
    ),
    // Resolve as a positive integer, then clamp to the hard batch ceiling so any
    // configured value keeps the batching effective.
    evictionChunkSize: Math.min(
      resolve(
        overrides.evictionChunkSize,
        "AUTOMOBILE_NAV_RETENTION_EVICTION_CHUNK_SIZE",
        DEFAULT_EVICTION_CHUNK_SIZE
      ),
      MAX_EVICTION_CHUNK_SIZE
    ),
  };
}

/**
 * Resolve the background-pass interval (ms) from override, env, or the default,
 * bounded by the signed-32-bit setInterval ceiling (a larger value would be
 * clamped to 1ms by the runtime, so it is rejected and defaulted).
 */
export function resolveNavigationRetentionIntervalMs(override?: number): number {
  return (
    sanitizePositiveInt(override, MAX_INTERVAL_MS)
    ?? readPositiveIntEnv("AUTOMOBILE_NAV_RETENTION_INTERVAL_MS", MAX_INTERVAL_MS)
    ?? DEFAULT_NAV_RETENTION_INTERVAL_MS
  );
}

interface BuildKeyRow {
  id: number;
  appId: string;
}

interface EvictionCandidate {
  isNode: boolean;
  id: number;
  lastSeenAt: number;
}

/**
 * Prunes the persisted nav data in one atomic pass. Stateless and recency-based:
 * inject the clock `now` and (optionally) a file remover so the whole thing is
 * deterministic under FakeTimer + an in-memory DB.
 *
 * The two observation tables are handled by explicit node/edge branches rather
 * than a table-name variable: their relevant columns are identical, but keeping
 * the table a literal lets Kysely fully type every query (no `any`).
 */
export class NavigationRetention {
  private readonly config: NavigationRetentionConfig;

  constructor(
    private readonly db: Kysely<Database>,
    config: Partial<NavigationRetentionConfig> = {},
    private readonly removeScreenshotFile?: ScreenshotFileRemover,
    private readonly logger: Logger = defaultLogger
  ) {
    this.config = resolveNavigationRetentionConfig(config);
  }

  /**
   * Run every tier once against `now` (ms). Returns a per-pass summary. All DB
   * work is a single transaction; screenshot files are unlinked AFTER commit so
   * a slow/failed unlink can never hold the daemon's one connection.
   */
  async prune(now: number): Promise<NavigationRetentionSummary> {
    const summary = emptySummary(now);
    let filesToRemove: string[] = [];

    await this.db.transaction().execute(async trx => {
      // Read the build keys + protected set INSIDE the txn: it holds the single
      // connection exclusively, so no concurrent write can shift which build is
      // newest between the read and the deletes.
      const buildKeys = await loadBuildKeys(trx);
      const protectedIds = await computeProtectedBuildKeyIds(trx, buildKeys);

      filesToRemove = await this.pruneScreenshots(trx, now, protectedIds, summary);
      await this.pruneObservationsByTtl(trx, now, protectedIds, summary);
      await this.enforceCaps(trx, buildKeys, protectedIds, summary);
      await this.pruneOrphanBuildKeys(trx, protectedIds, summary);
    });

    await this.removeFiles(filesToRemove);
    return summary;
  }

  private async removeFiles(filePaths: string[]): Promise<void> {
    if (!this.removeScreenshotFile) {
      return;
    }
    for (const filePath of filePaths) {
      try {
        await this.removeScreenshotFile(filePath);
      } catch (error) {
        // Best-effort: the DB pointer is already cleared, so a leftover file is
        // just an orphan the screenshot cache's own LRU will reclaim later.
        this.logger.debug(`nav retention: failed to unlink screenshot ${filePath}: ${error}`);
      }
    }
  }

  /**
   * SHORT tier: clear `screenshot_path` on nodes last seen before the cutoff,
   * unless the node is still observed under the active (protected) build. Returns
   * the file paths whose pointers were cleared, for post-commit unlinking.
   *
   * Batched: node cardinality is NOT bounded by the observation caps, so a large
   * stale set is cleared in chunks of `evictionChunkSize` — each UPDATE binds at
   * most that many ids. Clearing the pointer removes rows from the next batch's
   * predicate, so the loop terminates.
   */
  private async pruneScreenshots(
    trx: Kysely<Database>,
    now: number,
    protectedIds: number[],
    summary: NavigationRetentionSummary
  ): Promise<string[]> {
    const cutoff = now - this.config.screenshotTtlMs;
    const chunk = this.config.evictionChunkSize;
    const paths: string[] = [];

    for (;;) {
      let query = trx
        .selectFrom("navigation_nodes")
        .select(["id", "screenshot_path"])
        .where("screenshot_path", "is not", null)
        .where("last_seen_at", "<", cutoff);

      if (protectedIds.length > 0) {
        // Keep the screenshot if the node has any observation under a protected
        // build key (i.e. it is part of the active context).
        query = query.where("id", "not in", eb =>
          eb
            .selectFrom("navigation_node_observations")
            .select("node_id")
            .where("build_key_id", "in", protectedIds)
        );
      }

      const batch = await query.limit(chunk).execute();
      if (batch.length === 0) {
        break;
      }

      const ids = batch.map(row => row.id);
      await trx
        .updateTable("navigation_nodes")
        .set({ screenshot_path: null })
        .where("id", "in", ids)
        .execute();

      summary.screenshotsCleared += ids.length;
      for (const row of batch) {
        if (row.screenshot_path !== null) {
          paths.push(row.screenshot_path);
        }
      }

      if (batch.length < chunk) {
        break;
      }
    }

    return paths;
  }

  /**
   * LONG tier: delete observation rows last seen before the cutoff, except those
   * on a protected (active) build key. A single DELETE by predicate — it binds
   * only the (per-app-bounded) protected id list, never one param per matched row.
   */
  private async pruneObservationsByTtl(
    trx: Kysely<Database>,
    now: number,
    protectedIds: number[],
    summary: NavigationRetentionSummary
  ): Promise<void> {
    const cutoff = now - this.config.structureTtlMs;

    {
      let query = trx.deleteFrom("navigation_node_observations").where("last_seen_at", "<", cutoff);
      if (protectedIds.length > 0) {
        query = query.where("build_key_id", "not in", protectedIds);
      }
      const result = await query.executeTakeFirst();
      summary.nodeObservationsDeleted += Number(result.numDeletedRows ?? 0);
    }
    {
      let query = trx.deleteFrom("navigation_edge_observations").where("last_seen_at", "<", cutoff);
      if (protectedIds.length > 0) {
        query = query.where("build_key_id", "not in", protectedIds);
      }
      const result = await query.executeTakeFirst();
      summary.edgeObservationsDeleted += Number(result.numDeletedRows ?? 0);
    }
  }

  /**
   * Backstop: enforce the per-app budget first, then the global budget, evicting
   * the oldest observation rows by `last_seen_at`. The budgets count ALL of an
   * app's rows (so a single-build app is still bounded), but the newest row of
   * each protected build key is shielded so the active context is never evicted.
   *
   * Per-app scope is expressed as a join on `app_id` (binds one param, the app id)
   * rather than an id list of the app's build keys, so it stays bounded no matter
   * how many builds an app accumulates.
   */
  private async enforceCaps(
    trx: Kysely<Database>,
    buildKeys: BuildKeyRow[],
    protectedIds: number[],
    summary: NavigationRetentionSummary
  ): Promise<void> {
    const appIds = Array.from(new Set(buildKeys.map(bk => bk.appId)));
    for (const appId of appIds) {
      const count = await countObservations(trx, appId);
      const overflow = count - this.config.perAppMaxObservations;
      if (overflow > 0) {
        await this.evictOldest(trx, appId, protectedIds, overflow, summary);
      }
    }

    const globalCount = await countObservations(trx, null);
    const globalOverflow = globalCount - this.config.globalMaxObservations;
    if (globalOverflow > 0) {
      await this.evictOldest(trx, null, protectedIds, globalOverflow, summary);
    }
  }

  /**
   * Evict `count` oldest observation rows in scope (`appId === null` == global),
   * in bounded batches so a single DELETE never binds more ids than
   * `evictionChunkSize`. The loop terminates when the target is met or no
   * evictable rows remain (active rows are excluded relationally, so a scope can
   * be irreducible below its active set).
   *
   * Perf note: each batch reads the oldest rows `ORDER BY last_seen_at, id`
   * across build keys. The `(last_seen_at, id)` index from
   * 2026_08_22_002_navigation_observation_eviction_index.ts (issue #5309) serves
   * that ordering directly, so the batch is an index range scan rather than a
   * scan + temp-B-tree sort.
   */
  private async evictOldest(
    trx: Kysely<Database>,
    appId: string | null,
    protectedIds: number[],
    count: number,
    summary: NavigationRetentionSummary
  ): Promise<void> {
    let remaining = count;
    while (remaining > 0) {
      const batch = Math.min(remaining, this.config.evictionChunkSize);
      const victims = await collectOldestEvictable(trx, appId, protectedIds, batch);
      if (victims.length === 0) {
        return;
      }

      const nodeIds = victims.filter(v => v.isNode).map(v => v.id);
      const edgeIds = victims.filter(v => !v.isNode).map(v => v.id);
      if (nodeIds.length > 0) {
        const deleted = await trx
          .deleteFrom("navigation_node_observations")
          .where("id", "in", nodeIds)
          .executeTakeFirst();
        summary.nodeObservationsDeleted += Number(deleted.numDeletedRows ?? 0);
      }
      if (edgeIds.length > 0) {
        const deleted = await trx
          .deleteFrom("navigation_edge_observations")
          .where("id", "in", edgeIds)
          .executeTakeFirst();
        summary.edgeObservationsDeleted += Number(deleted.numDeletedRows ?? 0);
      }
      remaining -= victims.length;
    }
  }

  /**
   * Sweep build keys left with no observations (except protected ones). Runs
   * after observation deletes so the FK-safe order holds even with foreign_keys
   * ON (deleting a still-referenced build key would cascade-wipe its rows). The
   * "no observations" test is a correlated subquery (binds O(1)); only the
   * per-app-bounded protected id list is bound directly.
   */
  private async pruneOrphanBuildKeys(
    trx: Kysely<Database>,
    protectedIds: number[],
    summary: NavigationRetentionSummary
  ): Promise<void> {
    let query = trx
      .deleteFrom("navigation_build_keys")
      .where("id", "not in", eb =>
        eb.selectFrom("navigation_node_observations").select("build_key_id")
      )
      .where("id", "not in", eb =>
        eb.selectFrom("navigation_edge_observations").select("build_key_id")
      );

    if (protectedIds.length > 0) {
      query = query.where("id", "not in", protectedIds);
    }

    const deleted = await query.executeTakeFirst();
    summary.buildKeysDeleted += Number(deleted.numDeletedRows ?? 0);
  }
}

// ---------------------------------------------------------------------------
// Free helpers (kept small so the class methods stay under the complexity gate).
// ---------------------------------------------------------------------------

async function loadBuildKeys(db: Kysely<Database>): Promise<BuildKeyRow[]> {
  const rows = await db.selectFrom("navigation_build_keys").select(["id", "app_id"]).execute();
  return rows.map(row => ({ id: row.id, appId: row.app_id }));
}

/**
 * The active/most-recent build key per app: the one whose observations have the
 * greatest `last_seen_at` (ties and no-observation apps fall back to the newest
 * build-key id). These are never age-pruned or orphan-swept.
 */
export async function computeProtectedBuildKeyIds(
  db: Kysely<Database>,
  buildKeys?: BuildKeyRow[]
): Promise<number[]> {
  const keys = buildKeys ?? (await loadBuildKeys(db));
  if (keys.length === 0) {
    return [];
  }
  const maxSeen = await loadMaxSeenByBuildKey(db);

  // Per app, pick the build key with the greatest (lastSeen, id).
  const best = new Map<string, { id: number; seen: number }>();
  for (const bk of keys) {
    const seen = maxSeen.get(bk.id) ?? Number.NEGATIVE_INFINITY;
    if (isNewerBuild(best.get(bk.appId), bk.id, seen)) {
      best.set(bk.appId, { id: bk.id, seen });
    }
  }

  return Array.from(best.values(), entry => entry.id);
}

function isNewerBuild(
  current: { id: number; seen: number } | undefined,
  id: number,
  seen: number
): boolean {
  if (current === undefined) {
    return true;
  }
  return seen > current.seen || (seen === current.seen && id > current.id);
}

/** Greatest `last_seen_at` per build key across both observation tables. */
async function loadMaxSeenByBuildKey(db: Kysely<Database>): Promise<Map<number, number>> {
  const nodeMax = await db
    .selectFrom("navigation_node_observations")
    .select(eb => ["build_key_id", eb.fn.max("last_seen_at").as("max_seen")])
    .groupBy("build_key_id")
    .execute();
  const edgeMax = await db
    .selectFrom("navigation_edge_observations")
    .select(eb => ["build_key_id", eb.fn.max("last_seen_at").as("max_seen")])
    .groupBy("build_key_id")
    .execute();

  const maxSeen = new Map<number, number>();
  for (const row of [...nodeMax, ...edgeMax]) {
    const seen = Number(row.max_seen ?? 0);
    const prev = maxSeen.get(row.build_key_id);
    if (prev === undefined || seen > prev) {
      maxSeen.set(row.build_key_id, seen);
    }
  }
  return maxSeen;
}

/**
 * Count observation rows (node + edge). `appId === null` counts every row
 * (global); otherwise it joins on `app_id` (one bound param) rather than an id
 * list of the app's build keys.
 */
async function countObservations(
  trx: Kysely<Database>,
  appId: string | null
): Promise<number> {
  if (appId === null) {
    const nodeRow = await trx
      .selectFrom("navigation_node_observations")
      .select(eb => eb.fn.countAll<number>().as("c"))
      .executeTakeFirst();
    const edgeRow = await trx
      .selectFrom("navigation_edge_observations")
      .select(eb => eb.fn.countAll<number>().as("c"))
      .executeTakeFirst();
    return Number(nodeRow?.c ?? 0) + Number(edgeRow?.c ?? 0);
  }

  const nodeRow = await trx
    .selectFrom("navigation_node_observations as o")
    .innerJoin("navigation_build_keys as bk", "bk.id", "o.build_key_id")
    .select(eb => eb.fn.countAll<number>().as("c"))
    .where("bk.app_id", "=", appId)
    .executeTakeFirst();
  const edgeRow = await trx
    .selectFrom("navigation_edge_observations as o")
    .innerJoin("navigation_build_keys as bk", "bk.id", "o.build_key_id")
    .select(eb => eb.fn.countAll<number>().as("c"))
    .where("bk.app_id", "=", appId)
    .executeTakeFirst();
  return Number(nodeRow?.c ?? 0) + Number(edgeRow?.c ?? 0);
}

/**
 * Collect the `limit` oldest evictable observation rows (by last_seen_at, then
 * id), optionally scoped to one app, excluding the active rows RELATIONALLY.
 * Fetches at most `limit` rows per table then merges, so it never loads the whole
 * table — only the batch being evicted.
 */
async function collectOldestEvictable(
  trx: Kysely<Database>,
  appId: string | null,
  protectedIds: number[],
  limit: number
): Promise<EvictionCandidate[]> {
  const nodeRows = await buildOldestNodeEvictableQuery(trx, appId, protectedIds, limit).execute();
  const edgeRows = await buildOldestEdgeEvictableQuery(trx, appId, protectedIds, limit).execute();

  const candidates: EvictionCandidate[] = [
    ...nodeRows.map(row => ({ isNode: true, id: row.id, lastSeenAt: row.last_seen_at })),
    ...edgeRows.map(row => ({ isNode: false, id: row.id, lastSeenAt: row.last_seen_at })),
  ];
  // Oldest first; break ties by table (nodes before edges) then id for determinism.
  candidates.sort(
    (a, b) =>
      a.lastSeenAt - b.lastSeenAt
      || Number(b.isNode) - Number(a.isNode)
      || a.id - b.id
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
  limit: number
) {
  let query = db.selectFrom("navigation_node_observations").select(["id", "last_seen_at"]);
  if (appId !== null) {
    query = query.where("build_key_id", "in", eb =>
      eb.selectFrom("navigation_build_keys").select("id").where("app_id", "=", appId)
    );
  }
  if (protectedIds.length > 0) {
    query = query.where(eb =>
      eb.or([
        eb("build_key_id", "not in", protectedIds),
        eb(
          "last_seen_at",
          "<>",
          eb
            .selectFrom("navigation_node_observations as t")
            .select(sb => sb.fn.max("t.last_seen_at").as("m"))
            .whereRef("t.build_key_id", "=", "navigation_node_observations.build_key_id")
        ),
      ])
    );
  }
  return query.orderBy("last_seen_at", "asc").orderBy("id", "asc").limit(limit);
}

/** Edge-table counterpart of {@link buildOldestNodeEvictableQuery}. */
export function buildOldestEdgeEvictableQuery(
  db: Kysely<Database>,
  appId: string | null,
  protectedIds: number[],
  limit: number
) {
  let query = db.selectFrom("navigation_edge_observations").select(["id", "last_seen_at"]);
  if (appId !== null) {
    query = query.where("build_key_id", "in", eb =>
      eb.selectFrom("navigation_build_keys").select("id").where("app_id", "=", appId)
    );
  }
  if (protectedIds.length > 0) {
    query = query.where(eb =>
      eb.or([
        eb("build_key_id", "not in", protectedIds),
        eb(
          "last_seen_at",
          "<>",
          eb
            .selectFrom("navigation_edge_observations as t")
            .select(sb => sb.fn.max("t.last_seen_at").as("m"))
            .whereRef("t.build_key_id", "=", "navigation_edge_observations.build_key_id")
        ),
      ])
    );
  }
  return query.orderBy("last_seen_at", "asc").orderBy("id", "asc").limit(limit);
}
