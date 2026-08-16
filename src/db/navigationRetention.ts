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
//      durable, so they are intentionally NOT age-deleted here.
//   3. Global LRU size cap — a backstop enforcing a per-app AND a global budget
//      on the (evictable) observation rows, evicting oldest by `last_seen_at`.
//
// Active-data safety (AC3): the most-recently-seen build key per app is treated
// as the active context and NEVER pruned by any tier. Because in-flight writes
// land on the current build key (which has the newest `last_seen_at`), this
// protects whatever is being observed right now without a separate liveness
// signal. The whole pass runs in one transaction (atomic, no torn graph);
// observations are deleted before their orphaned build keys (FK-safe order), and
// file unlinks run AFTER commit as side effects (never inside the txn).

import type { Kysely } from "kysely";
import type { Database } from "./types";
import { logger as defaultLogger, type Logger } from "../utils/logger";

/** Tunable retention thresholds. All durations are milliseconds. */
export interface NavigationRetentionConfig {
  /** SHORT tier: max age of a node screenshot before its pointer is cleared. */
  screenshotTtlMs: number;
  /** LONG tier: max age of an observation row before it is pruned. */
  structureTtlMs: number;
  /** Backstop: max evictable observation rows kept per app. */
  perAppMaxObservations: number;
  /** Backstop: max evictable observation rows kept across all apps. */
  globalMaxObservations: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

// Conservative defaults (hand-off merge — the maintainer owns the final policy):
// nothing surprising should be deleted, so screenshots live a week and structure
// three months, with generous size caps that only trip on genuine runaway growth.
export const DEFAULT_SCREENSHOT_TTL_MS = 7 * DAY_MS; // 7 days
export const DEFAULT_STRUCTURE_TTL_MS = 90 * DAY_MS; // ~3 months
export const DEFAULT_PER_APP_MAX_OBSERVATIONS = 50_000;
export const DEFAULT_GLOBAL_MAX_OBSERVATIONS = 500_000;

/** Default cadence of the background pass: every 6 hours. */
export const DEFAULT_NAV_RETENTION_INTERVAL_MS = 6 * 60 * 60 * 1000;

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

function readPositiveIntEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) {
    return undefined;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Resolve the retention config from explicit overrides, then env, then the
 * conservative defaults above. Overrides win so tests stay hermetic.
 */
export function resolveNavigationRetentionConfig(
  overrides: Partial<NavigationRetentionConfig> = {}
): NavigationRetentionConfig {
  return {
    screenshotTtlMs:
      overrides.screenshotTtlMs
      ?? readPositiveIntEnv("AUTOMOBILE_NAV_RETENTION_SCREENSHOT_TTL_MS")
      ?? DEFAULT_SCREENSHOT_TTL_MS,
    structureTtlMs:
      overrides.structureTtlMs
      ?? readPositiveIntEnv("AUTOMOBILE_NAV_RETENTION_STRUCTURE_TTL_MS")
      ?? DEFAULT_STRUCTURE_TTL_MS,
    perAppMaxObservations:
      overrides.perAppMaxObservations
      ?? readPositiveIntEnv("AUTOMOBILE_NAV_RETENTION_PER_APP_MAX_OBSERVATIONS")
      ?? DEFAULT_PER_APP_MAX_OBSERVATIONS,
    globalMaxObservations:
      overrides.globalMaxObservations
      ?? readPositiveIntEnv("AUTOMOBILE_NAV_RETENTION_GLOBAL_MAX_OBSERVATIONS")
      ?? DEFAULT_GLOBAL_MAX_OBSERVATIONS,
  };
}

/** Resolve the background-pass interval (ms) from env or the default. */
export function resolveNavigationRetentionIntervalMs(override?: number): number {
  return (
    override
    ?? readPositiveIntEnv("AUTOMOBILE_NAV_RETENTION_INTERVAL_MS")
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

  getConfig(): NavigationRetentionConfig {
    return this.config;
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
      const protectedSet = new Set(protectedIds);

      filesToRemove = await this.pruneScreenshots(trx, now, protectedIds, summary);
      await this.pruneObservationsByTtl(trx, now, protectedIds, summary);
      await this.enforceCaps(trx, buildKeys, protectedSet, summary);
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
   */
  private async pruneScreenshots(
    trx: Kysely<Database>,
    now: number,
    protectedIds: number[],
    summary: NavigationRetentionSummary
  ): Promise<string[]> {
    const cutoff = now - this.config.screenshotTtlMs;

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

    const stale = await query.execute();
    if (stale.length === 0) {
      return [];
    }

    const ids = stale.map(row => row.id);
    await trx
      .updateTable("navigation_nodes")
      .set({ screenshot_path: null })
      .where("id", "in", ids)
      .execute();

    summary.screenshotsCleared += ids.length;
    return stale
      .map(row => row.screenshot_path)
      .filter((p): p is string => p !== null);
  }

  /**
   * LONG tier: delete observation rows last seen before the cutoff, except those
   * on a protected (active) build key.
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
   * the oldest evictable observation rows by `last_seen_at`.
   */
  private async enforceCaps(
    trx: Kysely<Database>,
    buildKeys: BuildKeyRow[],
    protectedSet: Set<number>,
    summary: NavigationRetentionSummary
  ): Promise<void> {
    // Per-app: each app's evictable build keys (its own keys minus the protected
    // one). Observations are scoped by `build_key_id IN (...)`, so no join needed.
    const evictableByApp = new Map<string, number[]>();
    for (const bk of buildKeys) {
      if (protectedSet.has(bk.id)) {
        continue;
      }
      const list = evictableByApp.get(bk.appId) ?? [];
      list.push(bk.id);
      evictableByApp.set(bk.appId, list);
    }

    for (const [, buildKeyIds] of evictableByApp) {
      const count = await countObservations(trx, buildKeyIds);
      const overflow = count - this.config.perAppMaxObservations;
      if (overflow > 0) {
        await this.evictOldest(trx, buildKeyIds, overflow, summary);
      }
    }

    // Global: every evictable build key across all apps.
    const globalEvictable = buildKeys.filter(bk => !protectedSet.has(bk.id)).map(bk => bk.id);
    const globalCount = await countObservations(trx, globalEvictable);
    const globalOverflow = globalCount - this.config.globalMaxObservations;
    if (globalOverflow > 0) {
      await this.evictOldest(trx, globalEvictable, globalOverflow, summary);
    }
  }

  private async evictOldest(
    trx: Kysely<Database>,
    buildKeyIds: number[],
    count: number,
    summary: NavigationRetentionSummary
  ): Promise<void> {
    if (buildKeyIds.length === 0 || count <= 0) {
      return;
    }
    const victims = await collectOldestEvictable(trx, buildKeyIds, count);

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
  }

  /**
   * Sweep build keys left with no observations (except protected ones). Runs
   * after observation deletes so the FK-safe order holds even with foreign_keys
   * ON (deleting a still-referenced build key would cascade-wipe its rows).
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
 * build-key id). These are never pruned.
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

/** Count observation rows (node + edge) whose build key is in `buildKeyIds`. */
async function countObservations(
  trx: Kysely<Database>,
  buildKeyIds: number[]
): Promise<number> {
  if (buildKeyIds.length === 0) {
    return 0;
  }
  const nodeRow = await trx
    .selectFrom("navigation_node_observations")
    .select(eb => eb.fn.countAll<number>().as("c"))
    .where("build_key_id", "in", buildKeyIds)
    .executeTakeFirst();
  const edgeRow = await trx
    .selectFrom("navigation_edge_observations")
    .select(eb => eb.fn.countAll<number>().as("c"))
    .where("build_key_id", "in", buildKeyIds)
    .executeTakeFirst();
  return Number(nodeRow?.c ?? 0) + Number(edgeRow?.c ?? 0);
}

/**
 * Collect the `limit` oldest evictable observation rows (by last_seen_at, then
 * id) whose build key is in `buildKeyIds`. Fetches at most `limit` rows per table
 * then merges, so it never loads the whole table — only the overflow being
 * evicted.
 */
async function collectOldestEvictable(
  trx: Kysely<Database>,
  buildKeyIds: number[],
  limit: number
): Promise<EvictionCandidate[]> {
  const nodeRows = await trx
    .selectFrom("navigation_node_observations")
    .select(["id", "last_seen_at"])
    .where("build_key_id", "in", buildKeyIds)
    .orderBy("last_seen_at", "asc")
    .orderBy("id", "asc")
    .limit(limit)
    .execute();
  const edgeRows = await trx
    .selectFrom("navigation_edge_observations")
    .select(["id", "last_seen_at"])
    .where("build_key_id", "in", buildKeyIds)
    .orderBy("last_seen_at", "asc")
    .orderBy("id", "asc")
    .limit(limit)
    .execute();

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
