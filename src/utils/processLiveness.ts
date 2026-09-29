import { readFileSync } from "node:fs";

/** A diagnostic sink must never change the result of a liveness probe. */
function logSafeDebug(
  debugLog: ProcessLivenessOptions["debugLog"],
  message: string,
  error: unknown,
): void {
  try {
    debugLog?.(message, error);
  } catch (logError) {
    // Diagnostics are best-effort; a failing sink cannot decide process liveness.
    void logError;
  }
}

interface ProcessLivenessOptions {
  platform?: NodeJS.Platform;
  signalProcess?: (pid: number) => void;
  readProcStat?: (pid: number) => string;
  debugLog?: (message: string, error?: unknown) => void;
}

const LINUX_PROC_STAT_FIELDS_AFTER_COMM = 50;

function linuxProcessState(pid: number, stat: string): string | undefined {
  const processNamePrefix = `${pid} (`;
  const closingParen = stat.lastIndexOf(")");
  if (!stat.startsWith(processNamePrefix) || closingParen < processNamePrefix.length) {
    return undefined;
  }

  const fieldsSuffix = stat.slice(closingParen + 1);
  if (!/^\s/.test(fieldsSuffix)) {
    return undefined;
  }
  const fields = fieldsSuffix.trim().split(/\s+/);
  const [state, ...numericFields] = fields;
  if (
    fields.length < LINUX_PROC_STAT_FIELDS_AFTER_COMM ||
    state?.length !== 1 ||
    numericFields.some((field) => !/^-?\d+$/.test(field))
  ) {
    return undefined;
  }
  return state;
}

function isConfirmedNoSuchProcessError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ESRCH";
}

export function isProcessRunning(pid: number, options: ProcessLivenessOptions = {}): boolean {
  // `process.kill(pid, 0)` treats non-positive PIDs specially rather than
  // naming a single process: pid 0 signals the CURRENT process group and
  // pid -1 signals EVERY process this user can signal — both "succeed" even
  // though no single real process named `0`/`-1` exists. A corrupt or stale
  // lock containing such a PID must never be reported as a live owner (issue
  // #6260) — that footgun would surface a `kill 0` / `kill -1` suggestion.
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  const signalProcess =
    options.signalProcess ??
    ((ownerPid: number): void => {
      process.kill(ownerPid, 0);
    });
  try {
    signalProcess(pid);
  } catch (error) {
    // Keep this aligned with logPruner.ts's defaultIsProcessAlive: ESRCH is the
    // only probe result that proves absence. Everything else is alive or uncertain.
    logSafeDebug(
      options.debugLog,
      `src/daemon/daemonFiles.ts liveness check failed: ${error}`,
      error,
    );
    return !isConfirmedNoSuchProcessError(error);
  }

  if ((options.platform ?? process.platform) !== "linux") {
    return true;
  }

  let stat: string;
  try {
    const readProcStat =
      options.readProcStat ??
      ((ownerPid: number) => readFileSync(`/proc/${ownerPid}/stat`, "utf-8"));
    stat = readProcStat(pid);
  } catch (error) {
    // A successful signal probe still identifies a possible owner when procfs is
    // unavailable, so retaining the lock is safer than reclaiming it.
    logSafeDebug(
      options.debugLog,
      `src/daemon/daemonFiles.ts procfs liveness check failed: ${error}`,
      error,
    );
    return true;
  }

  const state = linuxProcessState(pid, stat);
  if (state === undefined) {
    logSafeDebug(
      options.debugLog,
      `src/daemon/daemonFiles.ts could not parse /proc/${pid}/stat`,
      stat,
    );
    return true;
  }
  return state !== "Z" && state !== "X";
}
