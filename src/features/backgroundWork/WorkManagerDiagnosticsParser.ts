import type { WorkerInfo } from "./BackgroundWorkTypes";

/**
 * Parses the WorkManager `DiagnosticsWorker` log output (logcat tag `WM-DiagnosticsWrkr`, written
 * after the `androidx.work.diagnostics.REQUEST_DIAGNOSTICS` broadcast). After a header row
 * (` Id \t Class Name\t Job Id\t State\t Unique Name\t Tags\t`) each work spec is one tab-separated
 * row: id, worker class, JobScheduler job id (`null` without one), state, unique name, tags.
 */

const LOGCAT_BRIEF_PREFIX = /^[VDIWEF]\/[^(]*\(\s*\d+\):\s?/;
const WORK_ROW = /^\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s*\t(.*)$/i;

function nullable(text: string | undefined): string | undefined {
  const value = text?.trim();
  return value === undefined || value === "" || value === "null" ? undefined : value;
}

function rowToWorker(workSpecId: string, rest: string): WorkerInfo | null {
  const [workerClassName, systemId, state, uniqueName, tags] = rest
    .split("\t")
    .map((column) => column.trim());
  if (!workerClassName || !state) {
    return null;
  }
  const systemJobId = nullable(systemId);
  return {
    workSpecId,
    workerClassName,
    ...(systemJobId !== undefined && /^-?\d+$/.test(systemJobId)
      ? { systemJobId: Number(systemJobId) }
      : {}),
    state,
    ...(nullable(uniqueName) === undefined ? {} : { uniqueName: nullable(uniqueName) }),
    tags: (nullable(tags) ?? "")
      .split(",")
      .map((tag) => tag.trim())
      .filter((tag) => tag !== ""),
  };
}

/** Work specs in a logcat capture; a later row for the same work spec id replaces an earlier one. */
export function parseWorkManagerDiagnostics(output: string): WorkerInfo[] {
  const workers = new Map<string, WorkerInfo>();
  for (const rawLine of output.split(/\r?\n/)) {
    const row = WORK_ROW.exec(rawLine.replace(LOGCAT_BRIEF_PREFIX, ""));
    const worker = row ? rowToWorker(row[1], row[2]) : null;
    if (worker) {
      workers.set(worker.workSpecId, worker);
    }
  }
  return [...workers.values()];
}
