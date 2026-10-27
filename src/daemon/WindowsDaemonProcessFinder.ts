import { logger } from "../utils/logger";
import { isProcessRunning as isDaemonProcessRunning } from "./daemonFiles";
import {
  defaultProcessTableCommandRunner,
  boundedProcessTableScanTimeout,
  DAEMON_PROCESS_TABLE_MAX_BUFFER_BYTES,
  parseWindowsDaemonProcessTable,
  type DaemonProcessFinder,
  type DaemonProcessLivenessChecker,
  type DaemonProcessRecord,
  type ProcessTableCommandRunner,
} from "./processTable";

export class WindowsDaemonProcessFinder
  implements DaemonProcessFinder, DaemonProcessLivenessChecker
{
  constructor(
    private readonly runCommand: ProcessTableCommandRunner = defaultProcessTableCommandRunner,
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
