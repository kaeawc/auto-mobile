import { logger } from "../utils/logger";
import { isAutoMobileDaemonCommand } from "./daemonCommandMatch";
import {
  DAEMON_PROCESS_TABLE_MAX_BUFFER_BYTES,
  boundedProcessTableScanTimeout,
} from "./processTableLimits";
import type {
  DaemonProcessFinder,
  DaemonProcessLivenessChecker,
  DaemonProcessRecord,
  ProcessTableCommandRunner,
} from "./processTable";
import { isProcessRunning as isDaemonProcessRunning } from "./daemonFiles";

export class WindowsDaemonProcessFinder
  implements DaemonProcessFinder, DaemonProcessLivenessChecker
{
  constructor(
    private readonly runCommand: ProcessTableCommandRunner,
    private readonly activeEntryScript: string | undefined = process.argv[1],
  ) {}

  findDaemonProcesses(timeoutMs?: number): DaemonProcessRecord[] {
    // CIM returns local DateTime values. Publish absolute UTC birth times so
    // neither the host time zone nor PowerShell startup/scan latency shifts them.
    const processTableJson = this.runCommand(
      "powershell.exe -NoProfile -NonInteractive -Command \"Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine,@{Name='StartedAt';Expression={([DateTimeOffset]$_.CreationDate.ToUniversalTime()).ToUnixTimeMilliseconds()}} | ConvertTo-Json -Compress\"",
      {
        encoding: "utf-8",
        maxBuffer: DAEMON_PROCESS_TABLE_MAX_BUFFER_BYTES,
        timeout: boundedProcessTableScanTimeout(timeoutMs),
      },
    );
    return parseWindowsDaemonProcessTable(processTableJson, this.activeEntryScript);
  }

  isProcessRunning(pid: number): boolean {
    return isDaemonProcessRunning(pid, { debugLog: logger.debug });
  }
}

interface WindowsProcessTableEntry {
  ProcessId?: unknown;
  ParentProcessId?: unknown;
  CommandLine?: unknown;
  StartedAt?: unknown;
}

function parseWindowsProcessId(value: unknown): number | undefined {
  if (typeof value !== "number" && typeof value !== "string") {
    return undefined;
  }

  const parsed = typeof value === "number" ? value : parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseWindowsProcessTableEntry(
  entry: WindowsProcessTableEntry,
  activeEntryScript?: string,
): DaemonProcessRecord | undefined {
  const pid = parseWindowsProcessId(entry.ProcessId);
  const ppid = parseWindowsProcessId(entry.ParentProcessId);
  const command = entry.CommandLine;

  if (
    pid === undefined ||
    ppid === undefined ||
    typeof command !== "string" ||
    !isAutoMobileDaemonCommand(command, activeEntryScript)
  ) {
    return undefined;
  }

  const startedAt =
    typeof entry.StartedAt === "number" && Number.isFinite(entry.StartedAt)
      ? entry.StartedAt
      : undefined;
  return {
    pid,
    ppid,
    command,
    ...(startedAt === undefined ? {} : { startedAt }),
  };
}

export function parseWindowsDaemonProcessTable(
  processTableJson: string,
  activeEntryScript?: string,
): DaemonProcessRecord[] {
  const parsed: unknown = JSON.parse(processTableJson);
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  const records: DaemonProcessRecord[] = [];

  for (const entry of entries) {
    if (!entry || typeof entry !== "object") {
      continue;
    }

    const record = parseWindowsProcessTableEntry(entry, activeEntryScript);
    if (record) {
      records.push(record);
    }
  }

  return records;
}
