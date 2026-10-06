import { OPERATION_CANCELLED_MESSAGE } from "../constants";
import type { AdbExecutor } from "./interfaces/AdbExecutor";
import { fixedBackoff } from "../Backoff";
import { DefaultRetryExecutor } from "../retry/RetryExecutor";
import { defaultTimer, type Timer } from "../SystemTimer";

const PROCESS_RECORD_PATTERN =
  /(?:^|\s)(\d+):([A-Za-z0-9_.:]+)\/(u(\d+)(?:a\d+(?:i\d+)?|i\d+)|\d+)(?=[\s}]|$)/gm;

export interface AndroidPackageProcess {
  pid: number;
  processName: string;
  userId: number;
}

/** Read the process table with one retry for a transient offline device. */
export async function readAndroidPackageProcesses(
  adb: AdbExecutor,
  packageName: string,
  options: { userId?: number; signal?: AbortSignal; timer?: Timer } = {},
): Promise<{ processes: AndroidPackageProcess[]; isRunning: boolean; stdout: string }> {
  const output = await new DefaultRetryExecutor(options.timer ?? defaultTimer).executeOrThrow(
    () =>
      adb.executeCommand(
        "shell dumpsys activity processes",
        5_000,
        undefined,
        true,
        options.signal,
      ),
    {
      maxAttempts: 2,
      expectedFailure: {
        reason: "Process-table reads propagate caller cancellation without a failure warning",
        matches: (error) =>
          error.name === "AbortError" || error.message === OPERATION_CANCELLED_MESSAGE,
      },
      delays: fixedBackoff(200),
      signal: options.signal,
      shouldRetry: (error) => /device offline/i.test(error.message),
    },
  );
  const processes = findAndroidPackageProcesses(output.stdout, packageName);
  return {
    stdout: output.stdout,
    processes,
    isRunning: processes.some(
      (process) => options.userId === undefined || process.userId === options.userId,
    ),
  };
}

/**
 * Lists every process owned by an Android package across users. The exact
 * process identities let destructive callers reject ambiguous user targeting
 * and account for package-owned secondary processes.
 */
export function findAndroidPackageProcesses(
  processesOutput: string,
  packageName: string,
): AndroidPackageProcess[] {
  PROCESS_RECORD_PATTERN.lastIndex = 0;
  const processes: AndroidPackageProcess[] = [];
  const records = Array.from(processesOutput.matchAll(PROCESS_RECORD_PATTERN));

  for (const [index, match] of records.entries()) {
    const processName = match[2];
    const recordStart = match.index ?? 0;
    const recordEnd = records[index + 1]?.index ?? processesOutput.length;
    const record = processesOutput.slice(recordStart, recordEnd);
    if (
      processName !== packageName &&
      !processName.startsWith(`${packageName}:`) &&
      !processRecordOwnsPackage(record, packageName)
    ) {
      continue;
    }

    const uid = match[3];
    const userId = uid.startsWith("u") ? Number(match[4]) : Math.floor(Number(uid) / 100_000);
    processes.push({
      pid: Number(match[1]),
      processName,
      userId,
    });
  }

  return processes;
}

function processRecordOwnsPackage(record: string, packageName: string): boolean {
  const packageList = record.match(/^\s*packageList=\{([^}]*)\}/m)?.[1];
  return packageList?.split(/[,\s]+/).some((candidate) => candidate === packageName) ?? false;
}

/**
 * Finds a process PID for an Android package in the selected user, preferring
 * the package's main process over a `package:suffix` secondary process.
 * Accepts raw output or the already filtered package records from the reader.
 */
export function findAndroidPackageProcessId(
  processesOutput: string | readonly AndroidPackageProcess[],
  packageName: string,
  userId: number,
): number | null {
  const records =
    typeof processesOutput === "string"
      ? findAndroidPackageProcesses(processesOutput, packageName)
      : processesOutput;
  const processes = records.filter((process) => process.userId === userId);
  return (
    processes.find((process) => process.processName === packageName)?.pid ??
    processes[0]?.pid ??
    null
  );
}

/**
 * Determines whether an Android package has a process for the selected user.
 * Package-owned secondary processes (`com.example:worker`) count as running.
 *
 * App UIDs identify the user as `u<userId>a<appId>`, while system and
 * privileged processes use a numeric UID such as `1000`. Numeric system UIDs
 * belong to user 0; multi-user numeric UIDs encode the user in the leading
 * digits.
 *
 * When the hierarchy was captured by an older CtrlProxy that did not report a
 * user id, an omitted `userId` intentionally accepts a matching process for
 * any user. Newer callers should supply the captured user id.
 */
export function isAndroidPackageRunning(
  processesOutput: string,
  packageName: string,
  userId?: number,
): boolean {
  return findAndroidPackageProcesses(processesOutput, packageName).some(
    (process) => userId === undefined || process.userId === userId,
  );
}

/** Select a sole running user, or disambiguate multiple users by foreground identity. */
export async function selectAndroidUserId(
  adb: Pick<AdbExecutor, "getForegroundApp">,
  appId: string,
  processes: readonly AndroidPackageProcess[],
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<number | null> {
  const userIds = new Set(processes.map((process) => process.userId));
  if (userIds.size === 1) {
    return userIds.values().next().value ?? null;
  }

  const foreground = await adb.getForegroundApp(options.signal, options.timeoutMs ?? 5_000);
  return foreground?.packageName === appId && userIds.has(foreground.userId)
    ? foreground.userId
    : null;
}
