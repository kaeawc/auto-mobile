/**
 * Structured result of a bounded iOS device-log capture attached to a bug report.
 *
 * The payload is intentionally self-describing: it reports its own collection
 * status, the bounded window that was requested, whether app filtering was
 * applied, and the documented limits enforced on the retained entries. This lets
 * a bug report carry an iOS log tail without the collection ever failing the
 * caller's operation (issue #5641).
 */

/**
 * Collection status for an iOS device-log capture.
 * - `collected`: a bounded log tail was retrieved (the tail may be empty).
 * - `unavailable`: collection failed; see `diagnostic` for the underlying reason.
 */
export type IosDeviceLogStatus = "collected" | "unavailable";

/**
 * Whether app-identifier filtering was applied to the captured log. Present only
 * when an app identifier was requested.
 * - `applied`: the tail was filtered to the requested app.
 * - `unsupported`: filtering was requested but could not be applied; an
 *   unfiltered tail was returned instead.
 * - `unavailable`: collection failed, so filtering could not be evaluated.
 */
export type IosDeviceLogFilterStatus = "applied" | "unsupported" | "unavailable";

/** Reason a log tail was truncated to satisfy a documented limit. */
export type IosDeviceLogTruncationReason = "maxEntries" | "maxBytes";

/** Documented limits enforced on the retained log payload. */
export interface IosDeviceLogLimits {
  /** Maximum number of ordered entries retained in the payload. */
  maxEntries: number;
  /** Maximum total UTF-8 byte size of the retained entries. */
  maxBytes: number;
}

/** Bounded window that was requested for the log tail. */
export interface IosDeviceLogWindow {
  /** Time span passed to `log show --last`, e.g. "5m". */
  duration: string;
  /** Requested maximum entry count (line-count bound). */
  maxEntries: number;
}

/** App-identifier filter outcome, present only when an app id was supplied. */
export interface IosDeviceLogAppFilter {
  /** App identifier the caller requested filtering for. */
  appId: string;
  status: IosDeviceLogFilterStatus;
}

export interface IosDeviceLog {
  /** Whether a bounded tail was collected or collection was unavailable. */
  status: IosDeviceLogStatus;

  /** Ordered, timestamped, redacted device-log lines (oldest first). */
  entries: string[];

  /** Number of entries retained after applying limits. */
  entryCount: number;

  /** Total UTF-8 byte size of the retained entries. */
  byteSize: number;

  /** Whether entries were dropped to satisfy a documented limit. */
  truncated: boolean;

  /** Which limit forced truncation, when `truncated` is true. */
  truncationReason?: IosDeviceLogTruncationReason;

  /** Bounded window that was requested. */
  window: IosDeviceLogWindow;

  /** App-identifier filter outcome, present only when an app id was supplied. */
  appFilter?: IosDeviceLogAppFilter;

  /** Documented limits enforced on the payload. */
  limits: IosDeviceLogLimits;

  /** Human-readable failure detail when `status` is `unavailable`. */
  diagnostic?: string;
}
