import { defaultTimer, type Timer } from "../SystemTimer";
import { logger, type Logger } from "../logger";
import { errorMessage } from "../describeUnknownError";
import {
  FileNativeHelperRecordStore,
  type NativeHelperRecord,
  type NativeHelperRecordStore,
} from "./NativeHelperRecordStore";
import {
  DefaultNativeHelperProcessControl,
  type NativeHelperProcessControl,
} from "./NativeHelperProcessControl";

export interface NativeHelperCleanupSummary {
  reaped: number;
  skippedLiveOwner: number;
  staleRecordsRemoved: number;
  failed: number;
}

export interface NativeHelperSweepOptions {
  store?: NativeHelperRecordStore;
  control?: NativeHelperProcessControl;
  timer?: Timer;
  ownPid?: number;
  graceMs?: number;
  deadlineMs?: number;
  logger?: Logger;
}

export function emptyCleanupSummary(): NativeHelperCleanupSummary {
  return { reaped: 0, skippedLiveOwner: 0, staleRecordsRemoved: 0, failed: 0 };
}

export function helperIdentityMatches(
  record: NativeHelperRecord,
  control: NativeHelperProcessControl,
): boolean {
  return (
    control.isRunning(record.pid) && control.readStartIdentity(record.pid) === record.startIdentity
  );
}

/** Polling uses only the injected timer; deadline includes both graceful and forced exit waits. */
export async function waitForHelperExit(
  record: NativeHelperRecord,
  control: NativeHelperProcessControl,
  timer: Timer,
  endMs: number,
): Promise<void> {
  while (helperIdentityMatches(record, control) && cleanupNow(timer) < endMs) {
    await timer.sleep(Math.min(25, endMs - cleanupNow(timer)));
  }
}

export function cleanupNow(timer: Timer): number {
  return timer.monotonicNow?.() ?? timer.now();
}

/** After TERM, re-read identity immediately before escalation. Never signal a recycled pid. */
export async function finishHelperStop(
  record: NativeHelperRecord,
  options: Required<
    Pick<NativeHelperSweepOptions, "store" | "control" | "timer" | "graceMs" | "logger">
  > & { retainUnverifiableRecord?: boolean },
  deadline: number,
): Promise<"reaped" | "staleRecordsRemoved" | "failed"> {
  const { control, timer, store, graceMs, logger: log } = options;
  await waitForHelperExit(record, control, timer, Math.min(deadline, cleanupNow(timer) + graceMs));
  if (helperIdentityMatches(record, control) && cleanupNow(timer) < deadline) {
    control.signal(record.pid, "SIGKILL", { group: record.processGroup });
    await waitForHelperExit(
      record,
      control,
      timer,
      Math.min(deadline, cleanupNow(timer) + graceMs),
    );
  }
  if (!control.isRunning(record.pid)) {
    store.remove(record.pid, record.startIdentity);
    return "reaped";
  }
  const identity = control.readStartIdentity(record.pid);
  if (
    (identity === undefined && !options.retainUnverifiableRecord) ||
    (identity !== undefined &&
      control.compareStartIdentity(record.startIdentity, identity) === "different")
  ) {
    store.remove(record.pid, record.startIdentity);
    return "staleRecordsRemoved";
  }
  log.warn(
    `[NATIVE_HELPERS] Helper ${record.pid} still alive after bounded cleanup; retaining record`,
  );
  return "failed";
}

export async function sweepNativeHelperOrphans(
  options: NativeHelperSweepOptions = {},
): Promise<NativeHelperCleanupSummary> {
  const resolved = resolveSweepOptions(options);
  const { logger: log, store, timer } = resolved;
  const summary = emptyCleanupSummary();
  const deadline = cleanupNow(timer) + Math.max(0, resolved.deadlineMs);
  let records: NativeHelperRecord[];
  try {
    records = store.list();
  } catch (error) {
    log.warn(`[NATIVE_HELPERS] Cannot list helper records: ${errorMessage(error)}`, error);
    summary.failed++;
    return summary;
  }
  for (const record of records) {
    if (cleanupNow(timer) >= deadline) {
      break;
    }
    try {
      const result = await sweepRecord(record, resolved, deadline);
      if (result !== undefined) {
        summary[result]++;
      }
    } catch (error) {
      log.warn(
        `[NATIVE_HELPERS] Cleanup failed for helper ${record.pid}: ${errorMessage(error)}`,
        error,
      );
      summary.failed++;
    }
  }
  return summary;
}

function ownerIsAlive(record: NativeHelperRecord, control: NativeHelperProcessControl): boolean {
  if (!control.isRunning(record.ownerPid)) {
    return false;
  }
  const identity = control.readStartIdentity(record.ownerPid);
  return (
    identity === undefined ||
    control.compareStartIdentity(record.ownerStartIdentity, identity) !== "different"
  );
}

function resolveSweepOptions(
  options: NativeHelperSweepOptions,
): Required<NativeHelperSweepOptions> {
  const log = options.logger ?? logger;
  return {
    logger: log,
    store: options.store ?? new FileNativeHelperRecordStore(log),
    control: options.control ?? new DefaultNativeHelperProcessControl(),
    timer: options.timer ?? defaultTimer,
    ownPid: options.ownPid ?? process.pid,
    graceMs: Math.max(0, options.graceMs ?? 500),
    deadlineMs: options.deadlineMs ?? 4_000,
  };
}

async function sweepRecord(
  record: NativeHelperRecord,
  options: Required<NativeHelperSweepOptions>,
  deadline: number,
): Promise<keyof NativeHelperCleanupSummary | undefined> {
  const { control, store, timer, ownPid } = options;
  if (!Number.isSafeInteger(record.pid) || record.pid <= 1 || record.pid === ownPid) {
    return undefined;
  }
  if (ownerIsAlive(record, control)) {
    return "skippedLiveOwner";
  }
  const running = control.isRunning(record.pid);
  const identity = running ? control.readStartIdentity(record.pid) : undefined;
  if (
    !running ||
    (identity !== undefined &&
      control.compareStartIdentity(record.startIdentity, identity) === "different")
  ) {
    store.remove(record.pid, record.startIdentity);
    return "staleRecordsRemoved";
  }
  if (identity !== record.startIdentity) {
    options.logger.warn(
      `[NATIVE_HELPERS] Cannot verify helper ${record.pid} identity; retaining record`,
    );
    return "failed";
  }
  if (cleanupNow(timer) >= deadline) {
    return undefined;
  }
  control.signal(record.pid, "SIGTERM", { group: record.processGroup });
  return finishHelperStop(record, { ...options, retainUnverifiableRecord: true }, deadline);
}
