import { logger } from "../../utils/logger";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import type { RecordLogEventInput } from "../../db/logEventRepository";
import type { RecordOsEventInput } from "../../db/osEventRepository";
import type { RecordNavigationEventInput } from "../../db/navigationEventRepository";
import type { RecordLayoutEventInput } from "../../db/layoutEventRepository";
import {
  recordLogEvents as defaultRecordLogEvents,
  recordOsEvents as defaultRecordOsEvents,
  recordNavigationEvents as defaultRecordNavigationEvents,
  recordLayoutEvents as defaultRecordLayoutEvents,
} from "./batchTelemetryRepository";

/**
 * Multi-row batch INSERT sink for the homogeneous, void-returning telemetry
 * event kinds (issue #3138). Network events keep their per-row path because the
 * caller needs the row id synchronously for resource-subscription dispatch, and
 * storage events keep theirs because each row may trigger a per-key previous-
 * value lookup — neither batches cleanly, so they are deliberately excluded.
 */
export interface BatchTelemetryRepository {
  recordLogEvents(inputs: RecordLogEventInput[]): Promise<void>;
  recordOsEvents(inputs: RecordOsEventInput[]): Promise<void>;
  recordNavigationEvents(inputs: RecordNavigationEventInput[]): Promise<void>;
  recordLayoutEvents(inputs: RecordLayoutEventInput[]): Promise<void>;
}

export const defaultBatchTelemetryRepository: BatchTelemetryRepository = {
  recordLogEvents: (inputs) => defaultRecordLogEvents(inputs),
  recordOsEvents: (inputs) => defaultRecordOsEvents(inputs),
  recordNavigationEvents: (inputs) => defaultRecordNavigationEvents(inputs),
  recordLayoutEvents: (inputs) => defaultRecordLayoutEvents(inputs),
};

export interface TelemetryEventBufferOptions {
  /** Flush cadence for coalesced events. */
  flushIntervalMs?: number;
  /**
   * Force an immediate flush once the total buffered row count reaches this cap,
   * bounding both memory and crash-loss window between ticks.
   */
  maxBufferedRows?: number;
}

const DEFAULT_FLUSH_INTERVAL_MS = 250;
const DEFAULT_MAX_BUFFERED_ROWS = 512;

/**
 * Coalesces inbound telemetry and flushes it as one multi-row INSERT per kind on
 * a short interval (mirrors performanceAuditRepository.startPeriodicPruning's
 * unref'd interval), collapsing N single-row auto-commits into one commit.
 *
 * Durability caveat (accepted for best-effort telemetry, issue #3138): a crash
 * loses the unflushed buffer. maxBufferedRows bounds that window.
 */
export class TelemetryEventBuffer {
  private readonly repository: BatchTelemetryRepository;
  private readonly timer: Timer;
  private readonly flushIntervalMs: number;
  private readonly maxBufferedRows: number;

  private logs: RecordLogEventInput[] = [];
  private os: RecordOsEventInput[] = [];
  private navigation: RecordNavigationEventInput[] = [];
  private layout: RecordLayoutEventInput[] = [];

  private intervalHandle: NodeJS.Timeout | null = null;
  // Chain flushes so a slow flush can never overlap the next tick's flush and
  // interleave batches on the single mutex-guarded connection.
  private flushChain: Promise<void> = Promise.resolve();

  constructor(
    repository: BatchTelemetryRepository = defaultBatchTelemetryRepository,
    timer: Timer = defaultTimer,
    options: TelemetryEventBufferOptions = {},
  ) {
    this.repository = repository;
    this.timer = timer;
    this.flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.maxBufferedRows = options.maxBufferedRows ?? DEFAULT_MAX_BUFFERED_ROWS;
  }

  /** Begin the periodic flush timer. Idempotent. */
  start(): void {
    if (this.intervalHandle) {
      return;
    }
    this.intervalHandle = this.timer.setInterval(() => {
      void this.flush();
    }, this.flushIntervalMs);
    // Do not keep the process alive for telemetry flushing.
    this.intervalHandle.unref?.();
  }

  /** Stop the periodic flush timer and flush whatever remains. */
  async stop(): Promise<void> {
    if (this.intervalHandle) {
      this.timer.clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    await this.flush();
  }

  private bufferedRowCount(): number {
    return this.logs.length + this.os.length + this.navigation.length + this.layout.length;
  }

  private maybeFlushOnCap(): void {
    if (this.bufferedRowCount() >= this.maxBufferedRows) {
      void this.flush();
    }
  }

  addLog(input: RecordLogEventInput): void {
    this.logs.push(input);
    this.maybeFlushOnCap();
  }

  addOs(input: RecordOsEventInput): void {
    this.os.push(input);
    this.maybeFlushOnCap();
  }

  addNavigation(input: RecordNavigationEventInput): void {
    this.navigation.push(input);
    this.maybeFlushOnCap();
  }

  addLayout(input: RecordLayoutEventInput): void {
    this.layout.push(input);
    this.maybeFlushOnCap();
  }

  /**
   * Drain all buffered events as multi-row INSERTs. Serialized via flushChain so
   * concurrent callers (interval tick, cap trip, shutdown) never interleave.
   */
  flush(): Promise<void> {
    this.flushChain = this.flushChain.then(() => this.doFlush());
    return this.flushChain;
  }

  private async doFlush(): Promise<void> {
    // Snapshot-and-clear each buffer up front so events arriving during the
    // awaits below land in the next batch instead of being dropped.
    const logs = this.logs;
    const os = this.os;
    const navigation = this.navigation;
    const layout = this.layout;
    if (logs.length === 0 && os.length === 0 && navigation.length === 0 && layout.length === 0) {
      return;
    }
    this.logs = [];
    this.os = [];
    this.navigation = [];
    this.layout = [];

    // Best-effort telemetry: log and continue on failure so one failing kind
    // does not strand the others or throw into the flush timer (CLAUDE.md
    // strategy 3 — the dropped batch is acceptable loss for telemetry).
    try {
      if (logs.length > 0) {
        await this.repository.recordLogEvents(logs);
      }
    } catch (error) {
      logger.warn(
        `[TelemetryEventBuffer] log batch flush failed (${logs.length} rows): ${error}`,
        error,
      );
    }
    try {
      if (os.length > 0) {
        await this.repository.recordOsEvents(os);
      }
    } catch (error) {
      logger.warn(
        `[TelemetryEventBuffer] os batch flush failed (${os.length} rows): ${error}`,
        error,
      );
    }
    try {
      if (navigation.length > 0) {
        await this.repository.recordNavigationEvents(navigation);
      }
    } catch (error) {
      logger.warn(
        `[TelemetryEventBuffer] navigation batch flush failed (${navigation.length} rows): ${error}`,
        error,
      );
    }
    try {
      if (layout.length > 0) {
        await this.repository.recordLayoutEvents(layout);
      }
    } catch (error) {
      logger.warn(
        `[TelemetryEventBuffer] layout batch flush failed (${layout.length} rows): ${error}`,
        error,
      );
    }
  }
}
