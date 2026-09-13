import type { Kysely } from "kysely";
import { getDatabase } from "./database";
import type { DeviceSnapshotManifest, DeviceSnapshotMetadata, DeviceSnapshotType } from "../models";
import type {
  Database,
  DeviceSnapshot as DbDeviceSnapshot,
  NewDeviceSnapshot,
  DeviceSnapshotUpdate,
} from "./types";
import { logger } from "../utils/logger";

export interface DeviceSnapshotRecord extends DeviceSnapshotMetadata {}

export interface DeviceSnapshotQuery {
  deviceId?: string;
  platform?: "android" | "ios";
  snapshotType?: DeviceSnapshotType;
  limit?: number;
  orderByLastAccessed?: "asc" | "desc";
  orderByCreatedAt?: "asc" | "desc";
  /** Restrict to rows whose in-AVD payload still needs reclaiming (#6490). */
  pendingReclaim?: boolean;
}

function parseManifest(snapshotName: string, manifestJson: string): DeviceSnapshotManifest | null {
  try {
    return JSON.parse(manifestJson) as DeviceSnapshotManifest;
  } catch (error) {
    logger.warn(
      `[DeviceSnapshotRepository] Failed to parse manifest for ${snapshotName}: ${error}`,
    );
    return null;
  }
}

function toRecord(row: DbDeviceSnapshot): DeviceSnapshotRecord | null {
  const manifest = parseManifest(row.snapshot_name, row.manifest_json);
  if (!manifest) {
    return null;
  }

  return {
    snapshotName: row.snapshot_name,
    deviceId: row.device_id,
    deviceName: row.device_name,
    platform: row.platform,
    snapshotType: row.snapshot_type as DeviceSnapshotType,
    includeAppData: Boolean(row.include_app_data),
    includeSettings: Boolean(row.include_settings),
    createdAt: row.created_at,
    lastAccessedAt: row.last_accessed_at,
    // size_unknown is the nullable-size carrier: SQLite cannot relax
    // size_bytes NOT NULL in place, so an unmeasurable payload is stored as
    // (0, 1) and read back as null — never as a silent zero (#6490).
    sizeBytes: row.size_unknown ? null : row.size_bytes,
    pendingReclaim: Boolean(row.pending_reclaim),
    ...(row.pending_reclaim_reason === null
      ? {}
      : { pendingReclaimReason: row.pending_reclaim_reason }),
    manifest,
  };
}

/**
 * Column writers keyed by record field. A declarative table rather than a
 * ladder of `if (update.x !== undefined)` blocks, so adding a column (#6490
 * added three) costs one entry instead of another branch in an already-complex
 * function.
 */
const SNAPSHOT_UPDATE_WRITERS: {
  [K in keyof DeviceSnapshotRecord]?: (
    payload: DeviceSnapshotUpdate,
    value: NonNullable<DeviceSnapshotRecord[K]>,
  ) => void;
} = {
  deviceId: (payload, value) => {
    payload.device_id = value;
  },
  deviceName: (payload, value) => {
    payload.device_name = value;
  },
  platform: (payload, value) => {
    payload.platform = value;
  },
  snapshotType: (payload, value) => {
    payload.snapshot_type = value;
  },
  includeAppData: (payload, value) => {
    payload.include_app_data = value ? 1 : 0;
  },
  includeSettings: (payload, value) => {
    payload.include_settings = value ? 1 : 0;
  },
  createdAt: (payload, value) => {
    payload.created_at = value;
  },
  lastAccessedAt: (payload, value) => {
    payload.last_accessed_at = value;
  },
  pendingReclaim: (payload, value) => {
    payload.pending_reclaim = value ? 1 : 0;
  },
  pendingReclaimReason: (payload, value) => {
    payload.pending_reclaim_reason = value;
  },
  manifest: (payload, value) => {
    payload.manifest_json = JSON.stringify(value);
  },
};

function buildUpdatePayload(update: Partial<DeviceSnapshotRecord>): DeviceSnapshotUpdate {
  const payload: DeviceSnapshotUpdate = {};

  for (const [field, write] of Object.entries(SNAPSHOT_UPDATE_WRITERS)) {
    const value = update[field as keyof DeviceSnapshotRecord];
    if (value !== undefined) {
      (write as (target: DeviceSnapshotUpdate, raw: unknown) => void)(payload, value);
    }
  }

  // sizeBytes is the one field whose `null` is meaningful (unknown size), so it
  // writes two columns and cannot go through the table above (#6490).
  if (update.sizeBytes !== undefined) {
    payload.size_bytes = update.sizeBytes ?? 0;
    payload.size_unknown = update.sizeBytes === null ? 1 : 0;
  }

  return payload;
}

export class DeviceSnapshotRepository {
  private db: Kysely<Database> | null;

  constructor(db?: Kysely<Database>) {
    this.db = db ?? null;
  }

  // Migration gating is owned by startup (ensureMigrations) plus the app dialect
  // first-query gate (waitForMigrationsBeforeQuery, #6703); a repository helper
  // must NOT await ensureMigrations itself. Resolve the injected executor, else
  // the singleton, synchronously.
  private getDb(): Kysely<Database> {
    return this.db ?? getDatabase();
  }

  async insertSnapshot(record: DeviceSnapshotRecord): Promise<void> {
    const db = await this.getDb();
    const row: NewDeviceSnapshot = {
      snapshot_name: record.snapshotName,
      device_id: record.deviceId,
      device_name: record.deviceName,
      platform: record.platform,
      snapshot_type: record.snapshotType,
      include_app_data: record.includeAppData ? 1 : 0,
      include_settings: record.includeSettings ? 1 : 0,
      created_at: record.createdAt,
      last_accessed_at: record.lastAccessedAt,
      size_bytes: record.sizeBytes ?? 0,
      size_unknown: record.sizeBytes === null ? 1 : 0,
      pending_reclaim: record.pendingReclaim ? 1 : 0,
      pending_reclaim_reason: record.pendingReclaimReason ?? null,
      manifest_json: JSON.stringify(record.manifest),
    };

    await db
      .insertInto("device_snapshots")
      .values(row)
      .onConflict((oc) =>
        // created_at is intentionally omitted: on overwrite the original creation
        // time must survive (retention ordering / age display depend on it). The
        // INSERT still sets it for new rows; last_accessed_at carries the "touched"
        // time (#3498).
        oc.column("snapshot_name").doUpdateSet({
          device_id: row.device_id,
          device_name: row.device_name,
          platform: row.platform,
          snapshot_type: row.snapshot_type,
          include_app_data: row.include_app_data,
          include_settings: row.include_settings,
          last_accessed_at: row.last_accessed_at,
          size_bytes: row.size_bytes,
          size_unknown: row.size_unknown,
          pending_reclaim: row.pending_reclaim,
          pending_reclaim_reason: row.pending_reclaim_reason,
          manifest_json: row.manifest_json,
        }),
      )
      .execute();
  }

  async updateSnapshot(snapshotName: string, update: Partial<DeviceSnapshotRecord>): Promise<void> {
    const db = await this.getDb();
    const payload = buildUpdatePayload(update);
    if (Object.keys(payload).length === 0) {
      return;
    }

    await db
      .updateTable("device_snapshots")
      .set(payload)
      .where("snapshot_name", "=", snapshotName)
      .execute();
  }

  async getSnapshot(snapshotName: string): Promise<DeviceSnapshotRecord | null> {
    const db = await this.getDb();
    const row = await db
      .selectFrom("device_snapshots")
      .selectAll()
      .where("snapshot_name", "=", snapshotName)
      .executeTakeFirst();

    return row ? toRecord(row) : null;
  }

  async listSnapshots(query: DeviceSnapshotQuery = {}): Promise<DeviceSnapshotRecord[]> {
    const db = await this.getDb();
    let builder = db.selectFrom("device_snapshots").selectAll();

    if (query.deviceId) {
      builder = builder.where("device_id", "=", query.deviceId);
    }
    if (query.platform) {
      builder = builder.where("platform", "=", query.platform);
    }
    if (query.snapshotType) {
      builder = builder.where("snapshot_type", "=", query.snapshotType);
    }
    if (query.pendingReclaim !== undefined) {
      builder = builder.where("pending_reclaim", "=", query.pendingReclaim ? 1 : 0);
    }
    if (query.orderByLastAccessed) {
      builder = builder.orderBy("last_accessed_at", query.orderByLastAccessed);
    }
    if (query.orderByCreatedAt) {
      builder = builder.orderBy("created_at", query.orderByCreatedAt);
    }
    if (query.limit && query.limit > 0) {
      builder = builder.limit(query.limit);
    }

    const rows = await builder.execute();
    return rows
      .map((row) => toRecord(row))
      .filter((record): record is DeviceSnapshotRecord => Boolean(record));
  }

  async touchSnapshot(snapshotName: string, timestamp: string): Promise<void> {
    await this.updateSnapshot(snapshotName, { lastAccessedAt: timestamp });
  }

  async deleteSnapshot(snapshotName: string): Promise<boolean> {
    const db = await this.getDb();
    const result = await db
      .deleteFrom("device_snapshots")
      .where("snapshot_name", "=", snapshotName)
      .executeTakeFirst();

    return Number(result.numDeletedRows ?? 0) > 0;
  }
}
