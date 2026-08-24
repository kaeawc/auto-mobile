import { logger } from "../../utils/logger";
import { recordNetworkEvent, type RecordNetworkEventInput } from "../../db/networkEventRepository";
import { NetworkState } from "../../server/NetworkState";
import { recordLogEvent, type RecordLogEventInput } from "../../db/logEventRepository";
import { recordOsEvent, type RecordOsEventInput } from "../../db/osEventRepository";
import {
  recordNavigationEvent,
  type RecordNavigationEventInput,
} from "../../db/navigationEventRepository";
import { recordStorageEvent, type RecordStorageEventInput } from "../../db/storageEventRepository";
import { recordLayoutEvent, type RecordLayoutEventInput } from "../../db/layoutEventRepository";
import { getTelemetryPushServer } from "../../daemon/telemetryPushSocketServer";
import { type DbWriteBarrier, getDbWriteBarrier } from "../../db/dbWriteBarrier";
import type { TelemetryEventBuffer } from "./TelemetryEventBuffer";

export type TelemetryCategory =
  | "network"
  | "log"
  | "os"
  | "navigation"
  | "crash"
  | "anr"
  | "nonfatal"
  | "storage"
  | "layout"
  | "performance"
  | "toolcall";

export interface TelemetryEvent {
  category: TelemetryCategory;
  timestamp: number;
  deviceId: string | null;
  /**
   * Stable device-session routing key for the epoch this event belongs to (epic
   * #5256, item 3). Stamped by the telemetry push server from `deviceId` at push
   * and backfill time; recorders leave it absent. `null` when no live epoch maps
   * to the serial (e.g. a backfilled event for a now-disconnected device).
   */
  deviceSessionUuid?: string | null;
  sessionId: string | null;
  data: unknown;
}

export interface TelemetryPushTarget {
  pushTelemetryEvent(event: TelemetryEvent): void;
}

export interface TelemetryRepository {
  recordNetworkEvent(input: RecordNetworkEventInput): Promise<number>;
  recordLogEvent(input: RecordLogEventInput): Promise<void>;
  recordOsEvent(input: RecordOsEventInput): Promise<void>;
  recordNavigationEvent(input: RecordNavigationEventInput): Promise<void>;
  recordStorageEvent(input: RecordStorageEventInput): Promise<void>;
  recordLayoutEvent(input: RecordLayoutEventInput): Promise<void>;
}

const defaultRepository: TelemetryRepository = {
  recordNetworkEvent: (input) => recordNetworkEvent(input),
  recordLogEvent: (input) => recordLogEvent(input),
  recordOsEvent: (input) => recordOsEvent(input),
  recordNavigationEvent: (input) => recordNavigationEvent(input),
  recordStorageEvent: (input) => recordStorageEvent(input),
  recordLayoutEvent: (input) => recordLayoutEvent(input),
};

/**
 * A repository whose persistence methods are no-ops. Used by the unit-test
 * preload (see {@link TelemetryRecorder.setDefaultRepositoryOverride}) so that a
 * fire-and-forget telemetry write can never resolve the real file-backed DB —
 * whose guard-throw would otherwise be SWALLOWED by each recorder method's own
 * try/catch (a silent log, not a failure) or, on a floating promise, surface as
 * a misattributed unhandled rejection (issue #3084 / #3067).
 */
const noOpRepository: TelemetryRepository = {
  recordNetworkEvent: async () => 0,
  recordLogEvent: async () => {},
  recordOsEvent: async () => {},
  recordNavigationEvent: async () => {},
  recordStorageEvent: async () => {},
  recordLayoutEvent: async () => {},
};

/** The no-op telemetry repository (test-infra neutralization, issue #3084). */
export function getNoOpTelemetryRepository(): TelemetryRepository {
  return noOpRepository;
}

export class TelemetryRecorder {
  private static instance: TelemetryRecorder | null = null;
  // A process-wide default repository override. When set (only the unit-test
  // preload does this), EVERY lazily-constructed recorder — including one created
  // after a test's `resetInstance()` in teardown — uses this repository instead of
  // `defaultRepository`. That durability is the point: a test that resets the
  // singleton and then floats a `recordNavigationEvent` would otherwise re-arm the
  // real-DB path; the override keeps the neutralization in force for the whole
  // suite without per-test cooperation (issue #3084).
  private static defaultRepositoryOverride: TelemetryRepository | null = null;
  private deviceId: string | null = null;
  private sessionId: string | null = null;
  private readonly repository: TelemetryRepository;
  private readonly getPushTarget: () => TelemetryPushTarget | null;
  private readonly getBarrier: () => DbWriteBarrier;
  // Optional batched ingestion sink (issue #3138). When present, the homogeneous
  // void-returning kinds (log/os/navigation/layout) are coalesced into multi-row
  // INSERTs instead of one auto-commit per row. Network keeps its per-row path
  // (needs the row id synchronously) and storage keeps its per-row path (per-key
  // previous-value lookup), so both are intentionally not routed through here.
  private readonly buffer: TelemetryEventBuffer | null;

  constructor(
    repository: TelemetryRepository = TelemetryRecorder.defaultRepositoryOverride ??
      defaultRepository,
    getPushTarget: () => TelemetryPushTarget | null = () => getTelemetryPushServer(),
    // Resolve the shared barrier per write, not once at construction: a
    // same-process DB reopen swaps in a fresh barrier via resetDbWriteBarrier(),
    // and a captured instance would keep the pinned drained one (issue #2912).
    getBarrier: () => DbWriteBarrier = getDbWriteBarrier,
    buffer: TelemetryEventBuffer | null = null,
  ) {
    this.repository = repository;
    this.getPushTarget = getPushTarget;
    this.getBarrier = getBarrier;
    this.buffer = buffer;
  }

  static getInstance(): TelemetryRecorder {
    if (!TelemetryRecorder.instance) {
      TelemetryRecorder.instance = new TelemetryRecorder();
    }
    return TelemetryRecorder.instance;
  }

  /**
   * Install a process-wide default repository used by every recorder built from
   * here on (including after {@link resetInstance}). Test-infra only: the
   * unit-test preload passes {@link getNoOpTelemetryRepository} so no test can
   * accidentally float a telemetry write against the real DB. Pass `null` to
   * clear. Also drops any already-built singleton so it is rebuilt with the
   * override on next {@link getInstance}.
   */
  static setDefaultRepositoryOverride(repository: TelemetryRepository | null): void {
    TelemetryRecorder.defaultRepositoryOverride = repository;
    TelemetryRecorder.instance = null;
  }

  /** Reset the singleton (for testing only). */
  static resetInstance(): void {
    TelemetryRecorder.instance = null;
  }

  /**
   * Flush any buffered telemetry. No-op when batching is disabled. Callers on the
   * shutdown path should await this before closeDatabase() so the last batch is
   * committed rather than lost with the process (issue #3138 durability caveat).
   */
  async flushBuffer(): Promise<void> {
    if (this.buffer) {
      await this.buffer.flush();
    }
  }

  setContext(deviceId: string | null, sessionId: string | null): void {
    this.deviceId = deviceId;
    this.sessionId = sessionId;
  }

  getContext(): { deviceId: string | null; sessionId: string | null } {
    return { deviceId: this.deviceId, sessionId: this.sessionId };
  }

  async recordNetworkEvent(event: {
    timestamp: number;
    applicationId: string | null;
    url: string;
    method: string;
    statusCode: number;
    durationMs: number;
    requestBodySize: number;
    responseBodySize: number;
    protocol: string | null;
    host: string | null;
    path: string | null;
    error: string | null;
    requestHeaders?: Record<string, string> | null;
    responseHeaders?: Record<string, string> | null;
    requestBody?: string | null;
    responseBody?: string | null;
    contentType?: string | null;
  }): Promise<void> {
    // Snapshot context before async work to avoid race with concurrent setContext() calls
    const { deviceId, sessionId } = this.snapshotContext();
    const input: RecordNetworkEventInput = { deviceId, sessionId, ...event };

    this.pushToSocket({
      category: "network",
      timestamp: event.timestamp,
      deviceId,
      sessionId,
      data: event,
    });

    // Only persist and notify when capture is enabled
    if (!NetworkState.getInstance().capturing) {
      return;
    }

    let recordId: number | null = null;
    try {
      // Route through the shutdown barrier so an in-flight write is drained
      // before closeDatabase(); returns undefined (skipped) once draining.
      recordId =
        (await this.getBarrier().track(() => this.repository.recordNetworkEvent(input))) ?? null;
    } catch (e) {
      logger.error(`[TelemetryRecorder] Failed to record network event: ${e}`);
    }

    // Notify NetworkState for resource subscription dispatch (only if we got the DB id)
    if (recordId !== null) {
      NetworkState.getInstance().onNetworkEvent({
        id: recordId,
        timestamp: event.timestamp,
        method: event.method,
        url: event.url,
        host: event.host,
        path: event.path,
        statusCode: event.statusCode,
        durationMs: event.durationMs,
        contentType: event.contentType ?? null,
        error: event.error,
      });
    }
  }

  async recordLogEvent(event: {
    timestamp: number;
    applicationId: string | null;
    level: number;
    tag: string;
    message: string;
    filterName: string;
  }): Promise<void> {
    const { deviceId, sessionId } = this.snapshotContext();
    const input: RecordLogEventInput = { deviceId, sessionId, ...event };

    if (this.buffer) {
      this.buffer.addLog(input);
    } else {
      try {
        await this.getBarrier().track(() => this.repository.recordLogEvent(input));
      } catch (e) {
        logger.error(`[TelemetryRecorder] Failed to record log event: ${e}`);
      }
    }

    this.pushToSocket({
      category: "log",
      timestamp: event.timestamp,
      deviceId,
      sessionId,
      data: event,
    });
  }

  async recordOsEvent(event: {
    timestamp: number;
    applicationId: string | null;
    category: string;
    kind: string;
    details: Record<string, string> | null;
  }): Promise<void> {
    const { deviceId, sessionId } = this.snapshotContext();
    const input: RecordOsEventInput = { deviceId, sessionId, ...event };

    if (this.buffer) {
      this.buffer.addOs(input);
    } else {
      try {
        await this.getBarrier().track(() => this.repository.recordOsEvent(input));
      } catch (e) {
        logger.error(`[TelemetryRecorder] Failed to record OS event: ${e}`);
      }
    }

    this.pushToSocket({
      category: "os",
      timestamp: event.timestamp,
      deviceId,
      sessionId,
      data: event,
    });
  }

  async recordNavigationEvent(event: {
    timestamp: number;
    applicationId: string | null;
    destination: string;
    source: string | null;
    arguments: Record<string, string> | null;
    metadata: Record<string, string> | null;
    triggeringInteraction?: {
      type: string;
      elementText?: string;
      elementResourceId?: string;
    } | null;
    screenshotUri?: string | null;
  }): Promise<void> {
    const { deviceId, sessionId } = this.snapshotContext();
    const input: RecordNavigationEventInput = { deviceId, sessionId, ...event };

    if (this.buffer) {
      this.buffer.addNavigation(input);
    } else {
      try {
        await this.getBarrier().track(() => this.repository.recordNavigationEvent(input));
      } catch (e) {
        logger.error(`[TelemetryRecorder] Failed to record navigation event: ${e}`);
      }
    }

    this.pushToSocket({
      category: "navigation",
      timestamp: event.timestamp,
      deviceId,
      sessionId,
      data: event,
    });
  }

  /**
   * Record a failure (crash/anr/nonfatal) as a telemetry event.
   * No separate DB write — failures are already stored in failure_occurrences.
   */
  recordFailureTelemetry(event: {
    type: "crash" | "anr" | "nonfatal";
    occurrenceId: string;
    groupId: string;
    severity: string;
    title: string;
    exceptionType?: string;
    screen?: string | null;
    timestamp: number;
    stackTrace?: Array<{
      className: string;
      methodName: string;
      fileName: string | null;
      lineNumber: number | null;
      isAppCode: boolean;
    }> | null;
    deviceId?: string | null;
  }): void {
    // Use explicit deviceId if provided, otherwise fall back to context
    const context = this.snapshotContext();
    const deviceId = event.deviceId ?? context.deviceId;
    const sessionId = context.sessionId;
    // Failures without deviceId will be filtered by the telemetry push server's matchesFilter
    this.pushToSocket({
      category: event.type,
      timestamp: event.timestamp,
      deviceId,
      sessionId,
      data: event,
    });
  }

  async recordStorageEvent(event: {
    timestamp: number;
    applicationId: string | null;
    fileName: string;
    key: string | null;
    value: string | null;
    valueType: string | null;
    changeType: string;
    // When the source already knows the prior value, thread it through to skip
    // the repository's per-insert previous-value lookup (#2798).
    previousValue?: string | null;
  }): Promise<void> {
    const { deviceId, sessionId } = this.snapshotContext();
    const input: RecordStorageEventInput = { deviceId, sessionId, ...event };

    try {
      await this.getBarrier().track(() => this.repository.recordStorageEvent(input));
    } catch (e) {
      logger.error(`[TelemetryRecorder] Failed to record storage event: ${e}`);
    }

    this.pushToSocket({
      category: "storage",
      timestamp: event.timestamp,
      deviceId,
      sessionId,
      data: event,
    });
  }

  async recordLayoutEvent(event: {
    timestamp: number;
    applicationId: string | null;
    subType: string;
    composableName: string | null;
    composableId: string | null;
    recompositionCount: number | null;
    durationMs: number | null;
    likelyCause: string | null;
    detailsJson: string | null;
    screenName?: string | null;
  }): Promise<void> {
    const { deviceId, sessionId } = this.snapshotContext();
    const input: RecordLayoutEventInput = { deviceId, sessionId, ...event };

    if (this.buffer) {
      this.buffer.addLayout(input);
    } else {
      try {
        await this.getBarrier().track(() => this.repository.recordLayoutEvent(input));
      } catch (e) {
        logger.error(`[TelemetryRecorder] Failed to record layout event: ${e}`);
      }
    }

    this.pushToSocket({
      category: "layout",
      timestamp: event.timestamp,
      deviceId,
      sessionId,
      data: event,
    });
  }

  /**
   * Record a performance metric change as a telemetry event.
   * Emitted when metrics cross health thresholds (healthy→warning→critical).
   * Push-only — no separate DB write (performance data is already stored in performance_audit_results).
   */
  recordPerformanceEvent(event: {
    timestamp: number;
    packageName: string | null;
    fps: number | null;
    frameTimeMs: number | null;
    jankFrames: number | null;
    touchLatencyMs: number | null;
    memoryUsageMb: number | null;
    cpuUsagePercent: number | null;
    health: string;
    changedMetrics: string[];
  }): void {
    const { deviceId, sessionId: perfSessionId } = this.snapshotContext();
    this.pushToSocket({
      category: "performance",
      timestamp: event.timestamp,
      deviceId,
      sessionId: perfSessionId,
      data: event,
    });
  }

  /** Record a tool call execution with timing and status. */
  recordToolCallEvent(event: {
    timestamp: number;
    toolName: string;
    durationMs: number;
    success: boolean;
    error?: string | null;
    args?: Record<string, unknown> | null;
  }): void {
    const { deviceId, sessionId } = this.snapshotContext();
    this.pushToSocket({
      category: "toolcall",
      timestamp: event.timestamp,
      deviceId,
      sessionId,
      data: event,
    });
  }

  private snapshotContext(): { deviceId: string | null; sessionId: string | null } {
    return { deviceId: this.deviceId, sessionId: this.sessionId };
  }

  private pushToSocket(event: TelemetryEvent): void {
    const server = this.getPushTarget();
    if (server) {
      server.pushTelemetryEvent(event);
    }
  }
}
