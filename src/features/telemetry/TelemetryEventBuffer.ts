import { logger } from "../../utils/logger";
import { errorMessage } from "../../utils/describeUnknownError";
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

/** Settles one buffered layout row's write receipt (issue #14625). */
type LayoutReceipt = (persisted: boolean) => void;

/**
 * Coalesces inbound telemetry and flushes it as one multi-row INSERT per kind on
 * a short interval (mirrors performanceAuditRepository.startPeriodicPruning's
 * unref'd interval), collapsing N single-row auto-commits into one commit.
 *
 * Durability caveat (accepted for best-effort telemetry, issue #3138): a crash
 * loses the unflushed buffer. maxBufferedRows bounds that window.
 *
 * Layout rows carry a write receipt (issue #14625): {@link addLayout} returns a
 * promise that resolves `true` only once the batch holding that row committed,
 * and `false` when that batch failed or the row was refused by a stopped buffer.
 * It never rejects, and {@link stop} settles every outstanding receipt, so no
 * receipt can stay pending past shutdown.
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
  // One receipt per buffered layout row, snapshotted and cleared with `layout`.
  private layoutReceipts: LayoutReceipt[] = [];

  private intervalHandle: NodeJS.Timeout | null = null;
  // Set by stop(): with no timer left to drain it, a row accepted afterwards
  // could strand forever (and its receipt with it), so new rows are refused.
  private stopped = false;
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

  /** Begin (or, after stop(), resume) the periodic flush timer. Idempotent. */
  start(): void {
    this.stopped = false;
    if (this.intervalHandle) {
      return;
    }
    this.intervalHandle = this.timer.setInterval(() => {
      void this.flush();
    }, this.flushIntervalMs);
    // Do not keep the process alive for telemetry flushing.
    this.intervalHandle.unref?.();
  }

  /**
   * Stop the periodic flush timer and flush whatever remains. Rows added from
   * here on are dropped (a layout receipt resolves `false`) until start() is
   * called again; every receipt issued before stop() is settled by the final
   * flush, which the flush chain orders after any in-flight one.
   */
  async stop(): Promise<void> {
    this.stopped = true;
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

  private accepts(kind: string): boolean {
    if (this.stopped) {
      // Expected during shutdown: telemetry arriving after the final flush is
      // best-effort loss, the same as a crash losing the unflushed buffer.
      logger.debug(`[TelemetryEventBuffer] dropped ${kind} row added after stop()`);
      return false;
    }
    return true;
  }

  addLog(input: RecordLogEventInput): void {
    if (this.accepts("log")) {
      this.logs.push(input);
      this.maybeFlushOnCap();
    }
  }

  addOs(input: RecordOsEventInput): void {
    if (this.accepts("os")) {
      this.os.push(input);
      this.maybeFlushOnCap();
    }
  }

  addNavigation(input: RecordNavigationEventInput): void {
    if (this.accepts("navigation")) {
      this.navigation.push(input);
      this.maybeFlushOnCap();
    }
  }

  /**
   * Buffer a layout row and return its write receipt: `true` once the batch
   * holding it committed, `false` if that batch failed or the buffer is stopped.
   * The receipt settles on the next flush (interval tick, cap trip, explicit
   * flush() or stop()), so callers must not await it inline on a hot path.
   */
  addLayout(input: RecordLayoutEventInput): Promise<boolean> {
    if (!this.accepts("layout")) {
      return Promise.resolve(false);
    }
    const receipt = Promise.withResolvers<boolean>();
    this.layout.push(input);
    this.layoutReceipts.push(receipt.resolve);
    this.maybeFlushOnCap();
    return receipt.promise;
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
    if (this.bufferedRowCount() === 0) {
      return;
    }
    // Snapshot-and-clear each buffer up front so events arriving during the
    // awaits below land in the next batch instead of being dropped.
    const { logs, os, navigation, layout, layoutReceipts } = this;
    this.logs = [];
    this.os = [];
    this.navigation = [];
    this.layout = [];
    this.layoutReceipts = [];

    // Each kind is written independently so one failing kind does not strand
    // the others; writeBatch never throws, so the chain and timer stay healthy.
    await this.writeBatch("log", logs, (rows) => this.repository.recordLogEvents(rows));
    await this.writeBatch("os", os, (rows) => this.repository.recordOsEvents(rows));
    await this.writeBatch("navigation", navigation, (rows) =>
      this.repository.recordNavigationEvents(rows),
    );
    const layoutPersisted = await this.writeBatch("layout", layout, (rows) =>
      this.repository.recordLayoutEvents(rows),
    );
    for (const settle of layoutReceipts) {
      settle(layoutPersisted);
    }
  }

  /** Write one kind's batch; `true` only when the INSERT resolved. */
  private async writeBatch<Row>(
    kind: string,
    rows: Row[],
    write: (rows: Row[]) => Promise<void>,
  ): Promise<boolean> {
    if (rows.length === 0) {
      return true;
    }
    try {
      await write(rows);
      return true;
    } catch (error) {
      // Best-effort telemetry (CLAUDE.md strategy 2): the dropped batch is
      // accepted loss, reported to receipt holders as `false`, never retried.
      logger.warn(
        `[TelemetryEventBuffer] ${kind} batch flush failed (${rows.length} rows): ${errorMessage(error)}`,
        error,
      );
      return false;
    }
  }
}
