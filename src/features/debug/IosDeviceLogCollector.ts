import type {
  BootedDevice,
  ExecResult,
  IosDeviceLog,
  IosDeviceLogAppFilter,
  IosDeviceLogTruncationReason,
} from "../../models";
import { logger } from "../../utils/logger";
import { errorMessage } from "../../utils/describeUnknownError";
import { redactAndroidCommandOutput } from "../../utils/android-cmdline-tools/redactAndroidCommandOutput";

/** Default number of ordered entries retained when the caller does not override it. */
export const IOS_DEVICE_LOG_DEFAULT_MAX_ENTRIES = 1000;

/** Documented byte ceiling for the retained entries (256 KiB). */
export const IOS_DEVICE_LOG_MAX_BYTES = 256 * 1024;

/** Default bounded time window passed to `log show --last`. */
export const IOS_DEVICE_LOG_DEFAULT_WINDOW = "5m";

/** Hard entry ceiling regardless of caller request, to bound worst-case payloads. */
export const IOS_DEVICE_LOG_MAX_ENTRIES = 10000;

// An unfiltered `log show --last 5m` can dump the entire system log for the
// window, which is slow on a busy simulator; keep the timeout generous so a
// large-but-valid capture is not misreported as `unavailable`.
const IOS_DEVICE_LOG_TIMEOUT_MS = 30000;

/**
 * Best-effort `log show` predicate matching an app identifier. The value is a
 * single argv element (no shell), but double quotes and backslashes are stripped
 * so a hostile or malformed app id cannot break predicate parsing.
 *
 * This is intentionally broad: `process`/`processImagePath` hold the executable
 * name/path (usually the product name, not the bundle id), so only `subsystem`
 * reliably matches a bundle-id-style app id, and only for apps that adopt that
 * os_log convention. A predicate that runs cleanly but matches nothing still
 * reports `appFilter.status: "applied"` — "applied" means the filter was
 * accepted, not that it matched rows. Empty-but-applied is a genuine outcome
 * (the app may simply have been silent), not a defect.
 */
export function buildIosLogPredicate(appId: string): string {
  const safe = appId.replace(/["\\]/g, "");
  return `process CONTAINS[c] "${safe}" OR subsystem CONTAINS[c] "${safe}" OR processImagePath CONTAINS[c] "${safe}"`;
}

/**
 * Narrow exec seam the collector needs. Satisfied by the real `SimCtlClient` and
 * by `FakeSimCtlClient` in tests — we only ever run `simctl spawn <udid> log …`.
 */
export interface IosLogExecutor {
  executeCommandArgs(args: string[], timeoutMs?: number, signal?: AbortSignal): Promise<ExecResult>;
}

export interface IosDeviceLogOptions {
  /** App identifier to filter the log tail for, when supported. */
  appId?: string;
  /** Requested maximum entry count (line-count bound). */
  maxEntries?: number;
  /** Time span for `log show --last`, e.g. "5m". */
  window?: string;
}

type LogShowOutcome = { ok: true; stdout: string } | { ok: false; diagnostic: string };

/**
 * Collects a bounded, timestamped iOS device-log tail via `simctl spawn log show`.
 * Never throws: every failure path is reported as structured status so a bug
 * report can attach diagnostics without failing the caller's operation (#5641).
 */
export class IosDeviceLogCollector {
  constructor(
    private readonly exec: IosLogExecutor,
    private readonly device: BootedDevice,
  ) {}

  async collect(options: IosDeviceLogOptions = {}): Promise<IosDeviceLog> {
    const maxEntries = normalizeMaxEntries(options.maxEntries);
    const duration = options.window?.trim() ? options.window.trim() : IOS_DEVICE_LOG_DEFAULT_WINDOW;
    const appId = options.appId?.trim() ? options.appId.trim() : undefined;

    const window = { duration, maxEntries };
    const limits = { maxEntries, maxBytes: IOS_DEVICE_LOG_MAX_BYTES };

    if (appId) {
      const filtered = await this.runLogShow(duration, appId);
      if (filtered.ok) {
        return this.buildCollected(filtered.stdout, window, limits, {
          appId,
          status: "applied",
        });
      }

      // Predicate rejected (or the filtered query otherwise failed): fall back to
      // an unfiltered tail so the report still carries logs, marked unsupported.
      const unfiltered = await this.runLogShow(duration, undefined);
      if (unfiltered.ok) {
        return this.buildCollected(unfiltered.stdout, window, limits, {
          appId,
          status: "unsupported",
        });
      }

      return buildUnavailable(window, limits, unfiltered.diagnostic, {
        appId,
        status: "unavailable",
      });
    }

    const result = await this.runLogShow(duration, undefined);
    if (result.ok) {
      return this.buildCollected(result.stdout, window, limits, undefined);
    }
    return buildUnavailable(window, limits, result.diagnostic, undefined);
  }

  private async runLogShow(duration: string, appId?: string): Promise<LogShowOutcome> {
    const args = [
      "spawn",
      this.device.deviceId,
      "log",
      "show",
      "--style",
      "syslog",
      "--last",
      duration,
    ];
    if (appId) {
      args.push("--predicate", buildIosLogPredicate(appId));
    }

    try {
      const result = await this.exec.executeCommandArgs(args, IOS_DEVICE_LOG_TIMEOUT_MS);
      if (result.error) {
        return { ok: false, diagnostic: result.error };
      }
      return { ok: true, stdout: result.stdout };
    } catch (error) {
      // Expected on an offline/unavailable simulator or a rejected predicate;
      // reported as structured status rather than thrown (#5641).
      const diagnostic = errorMessage(error);
      logger.warn(`[IosDeviceLogCollector] log show failed: ${diagnostic}`, error);
      return { ok: false, diagnostic };
    }
  }

  private buildCollected(
    stdout: string,
    window: { duration: string; maxEntries: number },
    limits: { maxEntries: number; maxBytes: number },
    appFilter: IosDeviceLogAppFilter | undefined,
  ): IosDeviceLog {
    const parsed = parseEntries(stdout);
    const bounded = boundEntries(parsed, limits.maxEntries, limits.maxBytes);
    return {
      status: "collected",
      entries: bounded.entries,
      entryCount: bounded.entries.length,
      byteSize: bounded.byteSize,
      truncated: bounded.truncated,
      ...(bounded.truncationReason ? { truncationReason: bounded.truncationReason } : {}),
      window,
      ...(appFilter ? { appFilter } : {}),
      limits,
    };
  }
}

function normalizeMaxEntries(requested?: number): number {
  if (requested === undefined || !Number.isFinite(requested)) {
    return IOS_DEVICE_LOG_DEFAULT_MAX_ENTRIES;
  }
  const floored = Math.floor(requested);
  if (floored <= 0) {
    return 0;
  }
  return Math.min(floored, IOS_DEVICE_LOG_MAX_ENTRIES);
}

/** Split raw `log show` output into ordered, redacted, non-empty entries. */
function parseEntries(stdout: string): string[] {
  return redactAndroidCommandOutput(stdout)
    .split("\n")
    .map((entry) => entry.replace(/\r$/, ""))
    .filter((entry) => entry.trim().length > 0);
}

interface BoundedEntries {
  entries: string[];
  byteSize: number;
  truncated: boolean;
  truncationReason?: IosDeviceLogTruncationReason;
}

/**
 * Retain the most-recent entries within both the entry-count and byte ceilings,
 * preserving oldest-first order. The entry cap is applied first; the byte cap
 * then drops further from the oldest end until the payload fits.
 */
function boundEntries(entries: string[], maxEntries: number, maxBytes: number): BoundedEntries {
  let truncated = false;
  let truncationReason: IosDeviceLogTruncationReason | undefined;

  let kept = entries;
  if (kept.length > maxEntries) {
    kept = kept.slice(kept.length - maxEntries);
    truncated = true;
    truncationReason = "maxEntries";
  }

  let byteSize = utf8Size(kept);
  if (byteSize > maxBytes) {
    // Drop from the oldest end (front) until the retained payload fits.
    let start = 0;
    while (start < kept.length && byteSize > maxBytes) {
      byteSize -= utf8Size([kept[start]]);
      // Account for the newline separator removed with the dropped entry.
      if (start < kept.length - 1) {
        byteSize -= 1;
      }
      start += 1;
    }
    kept = kept.slice(start);
    byteSize = utf8Size(kept);
    truncated = true;
    truncationReason = "maxBytes";
  }

  return { entries: kept, byteSize, truncated, truncationReason };
}

function utf8Size(entries: string[]): number {
  return Buffer.byteLength(entries.join("\n"), "utf8");
}

function buildUnavailable(
  window: { duration: string; maxEntries: number },
  limits: { maxEntries: number; maxBytes: number },
  diagnostic: string,
  appFilter: IosDeviceLogAppFilter | undefined,
): IosDeviceLog {
  return {
    status: "unavailable",
    entries: [],
    entryCount: 0,
    byteSize: 0,
    truncated: false,
    window,
    ...(appFilter ? { appFilter } : {}),
    limits,
    diagnostic,
  };
}
