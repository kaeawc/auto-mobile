import { readFile } from "node:fs/promises";
import { toActionableError } from "../../models/ActionableError";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { sortedReaddir } from "../../utils/io";

/** Only the fields Android capacity needs; iOS retains its CPU-bearing row. */
export interface AndroidProcessRow {
  pid: number;
  ppid: number;
  rssBytes: number;
  command: string;
}

/** Async procfs seam; the daemon's private synchronous stat reader does not fit. */
export interface ProcFs {
  listEntries(): Promise<string[]>;
  readText(path: string): Promise<string>;
}

export const nodeProcFs: ProcFs = {
  listEntries: () => sortedReaddir("/proc"),
  readText: (path) => readFile(path, "utf8"),
};

const PROC_BATCH_SIZE = 32;

function statusFields(status: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const line of status.split("\n")) {
    const colon = line.indexOf(":");
    if (colon >= 0) {
      fields.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
    }
  }
  return fields;
}

function nonnegativeInteger(text: string | undefined): number | undefined {
  if (text === undefined || !/^\d+$/.test(text)) {
    return undefined;
  }
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : undefined;
}

function rssBytes(value: string | undefined): number | undefined {
  if (value === undefined) {
    return 0;
  } // Kernel threads and zombies have no VmRSS.
  const [amount, unit, extra] = value.split(/\s+/);
  const kb = nonnegativeInteger(amount);
  if (kb === undefined || unit !== "kB" || extra !== undefined) {
    return undefined;
  }
  const bytes = kb * 1024;
  return Number.isSafeInteger(bytes) ? bytes : undefined;
}

function parseRow(pid: number, status: string, cmdline: string): AndroidProcessRow | undefined {
  const fields = statusFields(status);
  const ppid = nonnegativeInteger(fields.get("PPid"));
  const rss = rssBytes(fields.get("VmRSS"));
  if (ppid === undefined || rss === undefined) {
    return undefined;
  }
  const argv = cmdline.split("\0");
  if (argv.at(-1) === "") {
    argv.pop();
  }
  return {
    pid,
    ppid,
    rssBytes: rss,
    command: cmdline === "" ? `[${fields.get("Name") ?? ""}]` : argv.join(" "),
  };
}

function processExited(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ESRCH")
  );
}

interface PidReadResult {
  row?: AndroidProcessRow;
  deniedError?: unknown;
}

function processReadDenied(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "EACCES" || error.code === "EPERM")
  );
}

async function readPid(procFs: ProcFs, entry: string): Promise<PidReadResult> {
  try {
    const status = await procFs.readText(`/proc/${entry}/status`);
    const cmdline = await procFs.readText(`/proc/${entry}/cmdline`);
    return { row: parseRow(Number(entry), status, cmdline) };
  } catch (error) {
    if (processReadDenied(error)) {
      // Restricted pid reads are expected on hidepid mounts; readable rows still give a count floor.
      logger.debug(`[BootAdmission] skipping denied /proc/${entry}: ${errorMessage(error)}`);
      return { deniedError: error };
    }
    if (!processExited(error)) {
      throw toActionableError(error, `Reading /proc/${entry}`);
    }
    // A process exiting between directory enumeration and file reads is expected.
    logger.debug(`[BootAdmission] skipping exited /proc/${entry}: ${errorMessage(error)}`);
    return {};
  }
}

/** Read in bounded batches, checking cancellation before opening the next batch. */
export async function readProcProcessTable(
  procFs: ProcFs,
  { signal }: { signal?: AbortSignal } = {},
): Promise<AndroidProcessRow[]> {
  signal?.throwIfAborted();
  const entries = (await procFs.listEntries()).filter((entry) => /^\d+$/.test(entry));
  const rows: AndroidProcessRow[] = [];
  let skipped = 0;
  let deniedError: unknown;
  for (let offset = 0; offset < entries.length; offset += PROC_BATCH_SIZE) {
    signal?.throwIfAborted();
    const batch = await Promise.all(
      entries.slice(offset, offset + PROC_BATCH_SIZE).map((entry) => readPid(procFs, entry)),
    );
    const parsed = batch.flatMap(({ row }) => (row ? [row] : []));
    rows.push(...parsed);
    skipped += batch.length - parsed.length;
    deniedError ??= batch.find((result) => result.deniedError !== undefined)?.deniedError;
  }
  signal?.throwIfAborted();
  if (skipped > 0) {
    logger.debug(`[BootAdmission] /proc skipped ${skipped} exited, denied or unparseable rows`);
  }
  if (rows.length === 0) {
    if (deniedError !== undefined) {
      throw toActionableError(deniedError, "Reading /proc: no readable processes");
    }
    throw new Error(`/proc returned no parseable processes (${skipped} unparseable rows)`);
  }
  return rows;
}
