import { sql, type Kysely, type SelectQueryBuilder } from "kysely";
import { z } from "zod";
import { getDatabase } from "./database";
import type {
  VideoCaptureTeardownDescriptor,
  VideoContainerFormat,
  VideoRecordingConfig,
  VideoRecordingHighlightEntry,
  VideoRecordingMetadata,
} from "../models";
import { parseVideoRecordingConfig } from "../models/VideoRecordingConfigParsing";
import type {
  Database,
  NewVideoRecording,
  VideoRecordingUpdate,
  VideoRecording as DbVideoRecording,
} from "./types";
import { logger } from "../utils/logger";
import type { RepositoryDeps } from "./repositoryDeps";

/**
 * `incomplete`: a release-time stop exceeded its finalize cap (#10957), so the capture was
 * force-stopped and whatever reached the host is kept.
 */
export type VideoRecordingStatus = "recording" | "completed" | "interrupted" | "incomplete";

/** Statuses of a recording that is no longer capturing and has an artifact row to read. */
export const FINISHED_VIDEO_RECORDING_STATUSES: VideoRecordingStatus[] = [
  "completed",
  "interrupted",
  "incomplete",
];

export interface VideoRecordingRecord extends VideoRecordingMetadata {
  captureTeardown?: VideoCaptureTeardownDescriptor;
  recorderDaemonSessionId?: string;
  deviceId: string;
  platform: "android" | "ios";
  status: VideoRecordingStatus;
  /**
   * Daemon session that started the recording (issue #4752). Absent for legacy
   * rows written before owner-scoping, which stay readable by any session.
   */
  ownerSessionUuid?: string;
}

/**
 * Owner scoping for a read (issue #4752). When `ownerSessionUuid` is set, the
 * query is restricted to rows the caller may see: rows owned by that session,
 * plus legacy rows with a NULL owner (which predate scoping and would otherwise
 * become permanently unreadable). When absent, no owner filter is applied and
 * callers see every row — reserved for internal/maintenance paths (eviction,
 * restart interruption sweep) that operate on the whole archive.
 */
export interface VideoRecordingOwnerScope {
  ownerSessionUuid?: string;
  /**
   * Base session of the requester (#11533). With `ownerSessionUuid` set, the scope also admits
   * rows owned by this base session or by a derived `${base}:${label}` session of it, the same
   * owners the active-recording stop accepts (#11140). Another base's rows stay hidden.
   */
  ownerBaseSessionUuid?: string;
}

/** Whether `owner` is `base` itself or a derived `${base}:${label}` session of it. */
export function isOwnerWithinBase(owner: string, base: string): boolean {
  return owner === base || owner.startsWith(`${base}:`);
}

/** Whether a row owned by `owner` (undefined = legacy) is visible under `scope`. */
export function ownerVisibleInScope(
  owner: string | undefined,
  scope: VideoRecordingOwnerScope,
): boolean {
  if (!scope.ownerSessionUuid) {
    return true;
  }
  return (
    owner === undefined ||
    owner === scope.ownerSessionUuid ||
    (scope.ownerBaseSessionUuid !== undefined &&
      isOwnerWithinBase(owner, scope.ownerBaseSessionUuid))
  );
}

export interface VideoRecordingQuery extends VideoRecordingOwnerScope {
  hasCaptureTeardown?: boolean;
  /** Maintenance excludes live recorders, unknown recorders while any peer is live,
   * and active owners belonging to live daemons. */
  excludeLiveDaemonSessionIds?: ReadonlySet<string>;
  /** The caller's own daemon id; it is not a peer for the unknown-recorder rule. */
  ownDaemonSessionId?: string;
  status?: VideoRecordingStatus | VideoRecordingStatus[];
  deviceId?: string;
  platform?: "android" | "ios";
  limit?: number;
  orderByLastAccessed?: "asc" | "desc";
  orderByStartedAt?: "asc" | "desc";
}

function parseConfig(configJson: string): VideoRecordingConfig {
  try {
    const parsed = JSON.parse(configJson) as VideoRecordingConfig;
    return parseVideoRecordingConfig(parsed);
  } catch (error) {
    logger.warn(`[VideoRecordingRepository] Failed to parse config JSON: ${error}`);
    return parseVideoRecordingConfig(null);
  }
}

const highlightTimelineSchema = z.object({
  appearedAtSeconds: z.number().finite(),
  disappearedAtSeconds: z.number().finite().optional(),
});

// The shape payload is only rendered, never branched on here; require an object with a type tag.
const highlightEntrySchema = z.custom<VideoRecordingHighlightEntry>((value) => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const { description, shape, timeline } = value as Record<string, unknown>;
  return (
    (description === undefined || typeof description === "string") &&
    typeof shape === "object" &&
    shape !== null &&
    typeof (shape as { type?: unknown }).type === "string" &&
    highlightTimelineSchema.safeParse(timeline).success
  );
});

const panelSchema = z.object({
  key: z.string(),
  role: z.enum(["inner", "cover", "rear", "external", "unknown"]),
});

const transitionsSchema = z.array(
  z.object({ atMs: z.number().finite(), from: panelSchema, to: panelSchema }),
);

function parseHighlights(
  highlightsJson: string | null,
): VideoRecordingHighlightEntry[] | undefined {
  if (!highlightsJson) {
    return undefined;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(highlightsJson);
  } catch (error) {
    logger.warn(`[VideoRecordingRepository] Failed to parse highlights JSON: ${error}`);
    return undefined;
  }
  if (!Array.isArray(raw)) {
    return undefined;
  }
  // Entries drive overlay timing; drop malformed ones instead of handing them to the renderer.
  const valid = raw.flatMap((entry): VideoRecordingHighlightEntry[] => {
    const result = highlightEntrySchema.safeParse(entry);
    if (!result.success) {
      logger.warn(`[VideoRecordingRepository] Dropping invalid highlight: ${result.error.message}`);
      return [];
    }
    return [result.data];
  });
  return valid;
}

const warningsSchema = z.array(z.string());

function parseDisplayMetadata<S extends z.ZodTypeAny>(
  value: string | null,
  schema: S,
): z.infer<S> | undefined {
  if (!value) {
    return undefined;
  }
  try {
    return schema.parse(JSON.parse(value));
  } catch (error) {
    logger.warn(`[VideoRecordingRepository] Failed to parse display metadata: ${error}`);
    return undefined;
  }
}

const captureTeardownSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("android-screenrecord"),
    deviceTempPath: z.string().min(1),
    devicePid: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  }),
  z.object({
    kind: z.literal("ios-host-recorder"),
    hostPid: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    hostStartToken: z.string().min(1),
    udid: z.string().min(1),
    capturePath: z.string().optional(),
  }),
]);

function parseCaptureTeardown(value: string | null): VideoCaptureTeardownDescriptor | undefined {
  if (value === null) {
    return undefined;
  }
  try {
    return captureTeardownSchema.parse(JSON.parse(value));
  } catch (error) {
    logger.warn("[VideoRecordingRepository] Failed to parse capture teardown descriptor", error);
    return undefined;
  }
}

function toRecord(row: DbVideoRecording): VideoRecordingRecord {
  return {
    recordingId: row.recording_id,
    recorderDaemonSessionId: row.recorder_daemon_session_id ?? undefined,
    captureTeardown: parseCaptureTeardown(row.capture_teardown_json),
    deviceId: row.device_id,
    platform: row.platform as "android" | "ios",
    status: row.status as VideoRecordingStatus,
    outputName: row.output_name ?? undefined,
    fileName: row.file_name,
    filePath: row.file_path,
    format: row.format as VideoContainerFormat,
    sizeBytes: row.size_bytes,
    durationMs: row.duration_ms ?? undefined,
    codec: row.codec ?? undefined,
    createdAt: row.created_at,
    startedAt: row.started_at,
    endedAt: row.ended_at ?? undefined,
    lastAccessedAt: row.last_accessed_at,
    config: parseConfig(row.config_json),
    highlights: parseHighlights(row.highlights_json ?? null),
    recordedPanel: parseDisplayMetadata(row.recorded_panel_json, panelSchema),
    transitions: parseDisplayMetadata(row.display_transitions_json, transitionsSchema),
    ...(row.has_audio_track === null ? {} : { hasAudioTrack: row.has_audio_track === 1 }),
    warnings: parseDisplayMetadata(row.warnings_json, warningsSchema),
    ownerSessionUuid: row.owner_session_uuid ?? undefined,
  };
}

/**
 * Restrict a `video_recordings` select to rows the given session may read
 * (issue #4752): rows it owns, plus legacy NULL-owner rows that predate scoping.
 * A no-op when `ownerSessionUuid` is undefined, preserving the unscoped
 * whole-archive reads used by internal maintenance paths.
 */
function applyOwnerScope<O>(
  builder: SelectQueryBuilder<Database, "video_recordings", O>,
  scope: VideoRecordingOwnerScope,
): SelectQueryBuilder<Database, "video_recordings", O> {
  const { ownerSessionUuid, ownerBaseSessionUuid } = scope;
  if (!ownerSessionUuid) {
    return builder;
  }
  return builder.where((eb) => {
    const owners = [
      eb("owner_session_uuid", "is", null),
      eb("owner_session_uuid", "=", ownerSessionUuid),
    ];
    if (ownerBaseSessionUuid !== undefined) {
      // The base session's own rows and its derived `${base}:${label}` sessions' (#11533). A
      // substr prefix compare, not LIKE, so a base containing % or _ cannot widen the match.
      const prefix = `${ownerBaseSessionUuid}:`;
      owners.push(
        eb("owner_session_uuid", "=", ownerBaseSessionUuid),
        eb(sql<string>`substr(owner_session_uuid, 1, ${Array.from(prefix).length})`, "=", prefix),
      );
    }
    return eb.or(owners);
  });
}

/** Persisted orphan maintenance leaves live peer-daemon captures alone. */
function applyMaintenanceScope<O>(
  builder: SelectQueryBuilder<Database, "video_recordings", O>,
  query: VideoRecordingQuery,
): SelectQueryBuilder<Database, "video_recordings", O> {
  const liveDaemonSessionIds = Array.from(query.excludeLiveDaemonSessionIds ?? []);
  if (liveDaemonSessionIds.length > 0) {
    const peers = liveDaemonSessionIds.filter((id) => id !== query.ownDaemonSessionId);
    if (peers.length > 0) {
      builder = builder.where("recorder_daemon_session_id", "is not", null);
    }
    builder = builder
      .where((eb) =>
        eb.or([
          eb("recorder_daemon_session_id", "is", null),
          eb("recorder_daemon_session_id", "not in", liveDaemonSessionIds),
        ]),
      )
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom("device_sessions")
              .select("session_uuid")
              .whereRef("device_sessions.session_uuid", "=", "video_recordings.owner_session_uuid")
              .where("device_sessions.status", "=", "active")
              .where("device_sessions.daemon_session_id", "in", liveDaemonSessionIds),
          ),
        ),
      );
  }
  if (query.hasCaptureTeardown) {
    builder = builder.where("capture_teardown_json", "is not", null);
  }
  return builder;
}

function buildUpdatePayload(update: Partial<VideoRecordingRecord>): VideoRecordingUpdate {
  const payload: VideoRecordingUpdate = {};

  applyRecordingFileUpdate(payload, update);
  applyRecordingTimestampUpdate(payload, update);
  applyRecordingMetadataUpdate(payload, update);
  // Presence, not value: an explicit undefined clears the nullable descriptor.
  if (Object.hasOwn(update, "captureTeardown")) {
    payload.capture_teardown_json = update.captureTeardown
      ? JSON.stringify(update.captureTeardown)
      : null;
  }
  return payload;
}

function applyRecordingIdentityUpdate(
  payload: VideoRecordingUpdate,
  update: Partial<VideoRecordingRecord>,
): void {
  if (update.deviceId !== undefined) {
    payload.device_id = update.deviceId;
  }
  if (update.platform !== undefined) {
    payload.platform = update.platform;
  }
  if (update.status !== undefined) {
    payload.status = update.status;
  }
  if (update.outputName !== undefined) {
    payload.output_name = update.outputName ?? null;
  }
}

function applyRecordingFileUpdate(
  payload: VideoRecordingUpdate,
  update: Partial<VideoRecordingRecord>,
): void {
  applyRecordingIdentityUpdate(payload, update);
  if (update.fileName !== undefined) {
    payload.file_name = update.fileName;
  }
  if (update.filePath !== undefined) {
    payload.file_path = update.filePath;
  }
  if (update.format !== undefined) {
    payload.format = update.format;
  }
  if (update.sizeBytes !== undefined) {
    payload.size_bytes = update.sizeBytes;
  }
  if (update.durationMs !== undefined) {
    payload.duration_ms = update.durationMs ?? null;
  }
  if (update.codec !== undefined) {
    payload.codec = update.codec ?? null;
  }
}

function applyRecordingTimestampUpdate(
  payload: VideoRecordingUpdate,
  update: Partial<VideoRecordingRecord>,
): void {
  if (update.createdAt !== undefined) {
    payload.created_at = update.createdAt;
  }
  if (update.startedAt !== undefined) {
    payload.started_at = update.startedAt;
  }
  if (update.endedAt !== undefined) {
    payload.ended_at = update.endedAt ?? null;
  }
  if (update.lastAccessedAt !== undefined) {
    payload.last_accessed_at = update.lastAccessedAt;
  }
}

function applyRecordingMetadataUpdate(
  payload: VideoRecordingUpdate,
  update: Partial<VideoRecordingRecord>,
): void {
  if (update.config !== undefined) {
    payload.config_json = JSON.stringify(update.config);
  }
  if (update.highlights !== undefined) {
    payload.highlights_json = JSON.stringify(update.highlights ?? []);
  }
  if (update.recordedPanel !== undefined) {
    payload.recorded_panel_json = JSON.stringify(update.recordedPanel);
  }
  if (update.transitions !== undefined) {
    payload.display_transitions_json = JSON.stringify(update.transitions);
  }
  if (update.ownerSessionUuid !== undefined) {
    payload.owner_session_uuid = update.ownerSessionUuid ?? null;
  }
  applyRecordingAudioStateUpdate(payload, update);
}

/** SQLite has no boolean: 1 or 0, and null for a recording that did not ask for audio. */
function audioTrackColumn(hasAudioTrack: boolean | undefined): number | null {
  if (hasAudioTrack === undefined) {
    return null;
  }
  return hasAudioTrack ? 1 : 0;
}

function applyRecordingAudioStateUpdate(
  payload: VideoRecordingUpdate,
  update: Partial<VideoRecordingRecord>,
): void {
  if (update.hasAudioTrack !== undefined) {
    payload.has_audio_track = audioTrackColumn(update.hasAudioTrack);
  }
  if (update.warnings !== undefined) {
    payload.warnings_json = JSON.stringify(update.warnings);
  }
}

export class VideoRecordingRepository {
  private db: Kysely<Database> | null;

  constructor({ db }: Pick<RepositoryDeps, "db"> = {}) {
    this.db = db ?? null;
  }

  // Migration gating is owned by startup (ensureMigrations) plus the app dialect
  // first-query gate (waitForMigrationsBeforeQuery, #6703); a repository helper
  // must NOT await ensureMigrations itself. Resolve the injected executor, else
  // the singleton, synchronously.
  private getDb(): Kysely<Database> {
    return this.db ?? getDatabase();
  }

  async insertRecording(record: VideoRecordingRecord): Promise<void> {
    const db = await this.getDb();
    const row: NewVideoRecording = {
      recording_id: record.recordingId,
      recorder_daemon_session_id: record.recorderDaemonSessionId ?? null,
      device_id: record.deviceId,
      platform: record.platform,
      status: record.status,
      output_name: record.outputName ?? null,
      file_name: record.fileName,
      file_path: record.filePath,
      format: record.format,
      size_bytes: record.sizeBytes,
      duration_ms: record.durationMs ?? null,
      codec: record.codec ?? null,
      created_at: record.createdAt,
      started_at: record.startedAt,
      ended_at: record.endedAt ?? null,
      last_accessed_at: record.lastAccessedAt,
      config_json: JSON.stringify(record.config),
      highlights_json: record.highlights ? JSON.stringify(record.highlights) : null,
      capture_teardown_json: record.captureTeardown ? JSON.stringify(record.captureTeardown) : null,
      recorded_panel_json: record.recordedPanel ? JSON.stringify(record.recordedPanel) : null,
      display_transitions_json: record.transitions ? JSON.stringify(record.transitions) : null,
      has_audio_track: audioTrackColumn(record.hasAudioTrack),
      warnings_json: record.warnings ? JSON.stringify(record.warnings) : null,
      owner_session_uuid: record.ownerSessionUuid ?? null,
    };

    await db
      .insertInto("video_recordings")
      .values(row)
      .onConflict((oc) =>
        // created_at is intentionally omitted: on overwrite the original creation
        // time must survive (retention ordering / age display depend on it). The
        // INSERT still sets it for new rows; last_accessed_at carries the "touched"
        // time (#3498).
        oc.column("recording_id").doUpdateSet({
          recorder_daemon_session_id: sql<
            string | null
          >`coalesce(${row.recorder_daemon_session_id}, video_recordings.recorder_daemon_session_id)`,
          device_id: row.device_id,
          platform: row.platform,
          status: row.status,
          output_name: row.output_name,
          file_name: row.file_name,
          file_path: row.file_path,
          format: row.format,
          size_bytes: row.size_bytes,
          duration_ms: row.duration_ms,
          codec: row.codec,
          started_at: row.started_at,
          ended_at: row.ended_at,
          last_accessed_at: row.last_accessed_at,
          config_json: row.config_json,
          highlights_json: row.highlights_json,
          capture_teardown_json: row.capture_teardown_json,
          recorded_panel_json: row.recorded_panel_json,
          display_transitions_json: row.display_transitions_json,
          has_audio_track: row.has_audio_track,
          warnings_json: row.warnings_json,
          owner_session_uuid: row.owner_session_uuid,
        }),
      )
      .execute();
  }

  async updateRecording(recordingId: string, update: Partial<VideoRecordingRecord>): Promise<void> {
    const db = await this.getDb();
    const payload = buildUpdatePayload(update);
    if (Object.keys(payload).length === 0) {
      return;
    }
    await db
      .updateTable("video_recordings")
      .set(payload)
      .where("recording_id", "=", recordingId)
      .execute();
  }

  async getRecording(
    recordingId: string,
    scope: VideoRecordingOwnerScope = {},
  ): Promise<VideoRecordingRecord | null> {
    const db = await this.getDb();
    let builder = db
      .selectFrom("video_recordings")
      .selectAll()
      .where("recording_id", "=", recordingId);
    builder = applyOwnerScope(builder, scope);
    const row = await builder.executeTakeFirst();

    return row ? toRecord(row) : null;
  }

  async listRecordings(query: VideoRecordingQuery = {}): Promise<VideoRecordingRecord[]> {
    const db = await this.getDb();
    let builder = db.selectFrom("video_recordings").selectAll();

    builder = applyOwnerScope(builder, query);
    builder = applyMaintenanceScope(builder, query);
    if (query.status !== undefined) {
      const statuses = Array.isArray(query.status) ? query.status : [query.status];
      builder = builder.where("status", "in", statuses);
    }
    if (query.deviceId) {
      builder = builder.where("device_id", "=", query.deviceId);
    }
    if (query.platform) {
      builder = builder.where("platform", "=", query.platform);
    }
    if (query.orderByLastAccessed) {
      builder = builder.orderBy("last_accessed_at", query.orderByLastAccessed);
    }
    if (query.orderByStartedAt) {
      builder = builder
        .orderBy("started_at", query.orderByStartedAt)
        .orderBy("recording_id", query.orderByStartedAt);
    }
    if (query.limit && query.limit > 0) {
      builder = builder.limit(query.limit);
    }

    const rows = await builder.execute();
    return rows.map(toRecord);
  }

  async getLatestRecording(): Promise<VideoRecordingRecord | null> {
    const rows = await this.listRecordings({
      status: FINISHED_VIDEO_RECORDING_STATUSES,
      orderByStartedAt: "desc",
      limit: 1,
    });
    return rows[0] ?? null;
  }

  async touchRecording(recordingId: string, timestamp: string): Promise<void> {
    await this.updateRecording(recordingId, { lastAccessedAt: timestamp });
  }

  async deleteRecording(recordingId: string): Promise<boolean> {
    const db = await this.getDb();
    const result = await db
      .deleteFrom("video_recordings")
      .where("recording_id", "=", recordingId)
      .executeTakeFirst();

    return Number(result.numDeletedRows ?? 0) > 0;
  }
}
