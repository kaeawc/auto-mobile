import { posix, win32 } from "node:path";
import { execSync } from "node:child_process";
import { errorMessage } from "../utils/describeUnknownError";
import { logger } from "../utils/logger";
import { Timer, defaultTimer } from "../utils/SystemTimer";
import { DAEMON_PROCESS_TABLE_SCAN_TIMEOUT_MS } from "./constants";
import { isDaemonEntryScriptPath } from "./DaemonLauncher";
import { isProcessRunning as isDaemonProcessRunning } from "./daemonFiles";
import {
  darwinProcessGenerationToken,
  readDarwinProcessGenerationToken,
  readLinuxProcessGenerationToken,
} from "./processGeneration";

export interface DaemonProcessRecord {
  pid: number;
  ppid: number;
  command: string;
  /** Namespace marker decoded by lifecycle consumers; ps parsing stays unchanged. */
  socketPath?: string;
  /** Approximate process creation time from the OS process table, when available. */
  startedAt?: number;
  /** Stable OS-derived identity for this process generation, when available. */
  processGenerationToken?: string;
}

export const DAEMON_SOCKET_PATH_FLAG = "--daemon-socket-path";

/**
 * ps flattens argv without preserving spaces. Manager launches percent-encode the
 * path in one token; quoted raw values are accepted for manually marked launches.
 * Full-token parsing prevents /a.sock from matching /a.sock2. Ambiguous or duplicate
 * markers fail closed rather than granting ownership from a partial path.
 */
export function parseDaemonSocketPath(command: string): string | undefined {
  const matches = [...command.matchAll(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)];
  const tokens: string[] = [];
  let end = 0;
  for (const match of matches) {
    if (command.slice(end, match.index).trim()) {
      return undefined; // Unbalanced quotes make the flattened argv ambiguous.
    }
    tokens.push(
      match[0].replace(
        /"([^"]*)"|'([^']*)'/g,
        (_quoted, double: string | undefined, single: string | undefined) => double ?? single ?? "",
      ),
    );
    end = match.index + match[0].length;
  }
  if (command.slice(end).trim()) {
    return undefined;
  }
  const markers = tokens.flatMap((token, index) => {
    if (token === DAEMON_SOCKET_PATH_FLAG) {
      return [tokens[index + 1]];
    }
    return token.startsWith(`${DAEMON_SOCKET_PATH_FLAG}=`)
      ? [token.slice(DAEMON_SOCKET_PATH_FLAG.length + 1)]
      : [];
  });
  const value = markers[0];
  if (markers.length !== 1 || !value || value.startsWith("--")) {
    return undefined;
  }
  try {
    return posix.isAbsolute(value) || win32.isAbsolute(value) ? value : decodeURIComponent(value);
  } catch (error) {
    // Malformed marker text supplies no ownership evidence; never guess a path.
    logger.debug("Ignoring malformed daemon socket marker", error);
    return undefined;
  }
}

export interface DaemonProcessFinder {
  /**
   * @param timeoutMs Upper bound to apply to the underlying process-table scan, for a
   * caller with a tight remaining budget (issue #6140). Always clamped to
   * {@link DAEMON_PROCESS_TABLE_SCAN_TIMEOUT_MS} as well — this can only shorten the
   * scan, never lengthen it beyond that ceiling. Omit to use the ceiling itself.
   */
  findDaemonProcesses(timeoutMs?: number): DaemonProcessRecord[];
}
export const DAEMON_PROCESS_TABLE_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

/**
 * Floor the process-table scan timeout is clamped to (issue #6140 review). Node's
 * (and Bun's) `execSync` treats `timeout: 0` as "no timeout" — i.e. UNBOUNDED, the
 * opposite of "expire immediately" — not a short/immediate bound. A computed
 * remaining budget can legitimately be exactly `0`, so `boundedProcessTableScanTimeout`
 * must never forward that value as-is: doing so would silently remove the bound
 * this scan exists to enforce. Callers with zero budget remaining should skip the
 * scan entirely (as `tryJoinPeerDaemonAfterSpawnExit` already does); this floor is
 * defense-in-depth for any other caller of `findDaemonProcesses`/
 * `findLiveDaemonProcesses` that does not pre-check for a zero budget.
 */
const MIN_PROCESS_TABLE_SCAN_TIMEOUT_MS = 1;

type ProcessTableCommandRunner = (
  command: string,
  options: { encoding: "utf-8"; maxBuffer: number; timeout: number },
) => string;

function normalizeProcessCommand(command: string): string {
  return command.replace(/\\/g, "/").replace(/\/+/g, "/");
}

function invokedCommand(command: string): string {
  if (!isShellCommandWrapper(command)) {
    return command.trim();
  }

  const shellInvocation = command
    .trim()
    .match(/(?:^|\s)(?:-c|\/c|-(?:command|encodedcommand|c|ec))\s+["']?(.+)$/i);
  return shellInvocation?.[1].trim() ?? command.trim();
}

function isAutoMobileDaemonCommand(
  command: string,
  activeEntryScript: string | undefined = process.argv[1],
): boolean {
  const normalizedCommand = normalizeProcessCommand(command);
  const invocation = invokedCommand(normalizedCommand);
  if (!/(?:^|\s)--daemon-mode(?:\s|["']|$)/.test(invocation)) {
    return false;
  }

  // Runtime flags are allowed only in the contiguous run immediately after the
  // anchored executable. Bare separators, the daemon marker, and non-flag values
  // are not skipped, so the next token remains the sole entry-script candidate.
  const runtimeEntrypoint = invocation.match(
    /^(?:(?:"?(?:env|\/usr\/bin\/env)"?)\s+)?(?:"(?:[^"]*\/)?(?:bun|node)(?:\.exe)?"|(?:(?:[A-Za-z]:\/[^"']*\/|[^"'\s]*\/)?(?:bun|node)(?:\.exe)?))\s+(?:(?!--daemon-mode(?:\s|$))-{1,2}[A-Za-z0-9][^\s"']*\s+)*(?:"([^"]+)"|'([^']+)'|([^\s"']+))/i,
  );
  const runsBundledEntrypoint =
    runtimeEntrypoint !== null &&
    isDaemonEntryScriptPath(
      runtimeEntrypoint[1] ?? runtimeEntrypoint[2] ?? runtimeEntrypoint[3],
      activeEntryScript,
    );
  const runsPublishedPackage =
    /^(?:"?[^"'\s]*\/)?(?:bunx|npx)(?:\.exe)?\s+(?:(?:-y|--yes|--bun|--no-cache)\s+)*@kaeawc\/auto-mobile(?:@[^\s"']+)?(?:\s|["']|$)/.test(
      invocation,
    ) ||
    /^(?:"?[^"'\s]*\/)?bun(?:\.exe)?\s+x\s+(?:(?:-y|--yes|--bun|--no-cache)\s+)*@kaeawc\/auto-mobile(?:@[^\s"']+)?(?:\s|["']|$)/.test(
      invocation,
    );
  const runsStandaloneBinary = /^(?:"?[^"'\s]*\/)?auto-mobile(?:\.exe)?(?:\s|$)/i.test(invocation);

  return runsBundledEntrypoint || runsPublishedPackage || runsStandaloneBinary;
}

export function isShellCommandWrapper(command: string): boolean {
  const normalizedCommand = normalizeProcessCommand(command);
  const trimmedCommand = normalizedCommand.trim();
  const executable = trimmedCommand.startsWith('"')
    ? trimmedCommand.slice(1, trimmedCommand.indexOf('"', 1))
    : (trimmedCommand.split(/\s+/, 1)[0] ?? "");

  if (/(^|\/)(?:ba|da|z)?sh$/.test(executable) && normalizedCommand.includes(" -c ")) {
    return true;
  }

  if (/(^|\/)cmd(?:\.exe)?$/i.test(executable) && /(?:^|\s)\/c(?:\s|$)/i.test(normalizedCommand)) {
    return true;
  }

  return (
    /(^|\/)(?:powershell|pwsh)(?:\.exe)?$/i.test(executable) &&
    /(?:^|\s)-(?:command|encodedcommand|c|ec)(?:\s|$)/i.test(normalizedCommand)
  );
}

export function parseDaemonProcessTable(
  psOutput: string,
  now: number = Date.now(),
  activeEntryScript?: string,
): DaemonProcessRecord[] {
  const records: DaemonProcessRecord[] = [];

  for (const line of psOutput.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(?:(\d+)\s+)?(.+?)\s*$/);
    if (!match) {
      continue;
    }

    const pid = parseInt(match[1], 10);
    const ppid = parseInt(match[2], 10);
    const elapsedSeconds = match[3] === undefined ? undefined : parseInt(match[3], 10);
    const command = match[4];

    if (
      !Number.isFinite(pid) ||
      !Number.isFinite(ppid) ||
      !isAutoMobileDaemonCommand(command, activeEntryScript)
    ) {
      continue;
    }

    // This fallback derives birth time from wall-clock `now`; a clock step between
    // reconstruction and PID-record capture can shift it beyond identity tolerance.
    records.push({
      pid,
      ppid,
      command,
      ...(elapsedSeconds === undefined ? {} : { startedAt: now - elapsedSeconds * 1000 }),
    });
  }

  return records;
}

function parseBusyBoxElapsedSeconds(value: string): number | undefined {
  const match = value.match(/^(?:(\d+)-)?(?:(\d{1,2}):)?(\d{2}):(\d{2})$/);
  if (!match) {
    return undefined;
  }
  const days = match[1] === undefined ? 0 : parseInt(match[1], 10);
  const hours = match[2] === undefined ? 0 : parseInt(match[2], 10);
  const minutes = parseInt(match[3], 10);
  const seconds = parseInt(match[4], 10);
  if (
    ![days, hours, minutes, seconds].every(Number.isFinite) ||
    hours > 23 ||
    minutes > 59 ||
    seconds > 59
  ) {
    return undefined;
  }
  return ((days * 24 + hours) * 60 + minutes) * 60 + seconds;
}

/** Parse BusyBox `ps -o pid,ppid,etime,args` output. */
export function parseBusyBoxDaemonProcessTable(
  psOutput: string,
  now: number = Date.now(),
  activeEntryScript?: string,
): DaemonProcessRecord[] {
  const records: DaemonProcessRecord[] = [];

  for (const line of psOutput.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/);
    if (!match) {
      continue;
    }

    const pid = parseInt(match[1], 10);
    const ppid = parseInt(match[2], 10);
    const elapsedSeconds = parseBusyBoxElapsedSeconds(match[3]);
    const command = match[4];
    if (
      !Number.isFinite(pid) ||
      !Number.isFinite(ppid) ||
      elapsedSeconds === undefined ||
      !isAutoMobileDaemonCommand(command, activeEntryScript)
    ) {
      continue;
    }

    // This fallback derives birth time from wall-clock `now`; a clock step between
    // reconstruction and PID-record capture can shift it beyond identity tolerance.
    records.push({ pid, ppid, command, startedAt: now - elapsedSeconds * 1000 });
  }

  return records;
}

const LSTART_MONTHS = new Map([
  ["Jan", 0],
  ["Feb", 1],
  ["Mar", 2],
  ["Apr", 3],
  ["May", 4],
  ["Jun", 5],
  ["Jul", 6],
  ["Aug", 7],
  ["Sep", 8],
  ["Oct", 9],
  ["Nov", 10],
  ["Dec", 11],
]);

function parseLstart(value: string): number | undefined {
  const match = value.match(
    /^(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat)\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/,
  );
  if (!match) {
    return undefined;
  }

  const month = LSTART_MONTHS.get(match[1]);
  if (month === undefined) {
    return undefined;
  }
  const day = parseInt(match[2], 10);
  const hour = parseInt(match[3], 10);
  const minute = parseInt(match[4], 10);
  const second = parseInt(match[5], 10);
  const year = parseInt(match[6], 10);

  // `ps lstart` reports local wall-clock time. Constructing this date locally
  // keeps its epoch comparable to the Date.now() timestamp written to the PID
  // file, while the component check rejects JavaScript's overflow normalization.
  // During a fall-back repeated hour, this local time is ambiguous and Date applies its fixed offset rule.
  const startedAt = new Date(year, month, day, hour, minute, second);
  const hasComponentMismatch = [
    startedAt.getFullYear() !== year,
    startedAt.getMonth() !== month,
    startedAt.getDate() !== day,
    startedAt.getHours() !== hour,
    startedAt.getMinutes() !== minute,
    startedAt.getSeconds() !== second,
  ];
  if (hasComponentMismatch.some(Boolean)) {
    return undefined;
  }
  return startedAt.getTime();
}

/**
 * Parse Darwin's `ps lstart` table. `lstart` has second precision, matching the
 * existing Linux `etimes` identity precision used to fence PID reuse.
 */
export function parseDarwinDaemonProcessTable(
  psOutput: string,
  activeEntryScript?: string,
): DaemonProcessRecord[] {
  const records: DaemonProcessRecord[] = [];

  for (const line of psOutput.split("\n")) {
    const match = line.match(
      /^\s*(\d+)\s+(\d+)\s+((?:Sun|Mon|Tue|Wed|Thu|Fri|Sat)\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+?)\s*$/,
    );
    if (!match) {
      continue;
    }

    const pid = parseInt(match[1], 10);
    const ppid = parseInt(match[2], 10);
    const startedAt = parseLstart(match[3]);
    const command = match[4];
    if (
      !Number.isFinite(pid) ||
      !Number.isFinite(ppid) ||
      startedAt === undefined ||
      !isAutoMobileDaemonCommand(command, activeEntryScript)
    ) {
      continue;
    }

    const processGenerationToken = darwinProcessGenerationToken(match[3]);
    records.push({
      pid,
      ppid,
      command,
      startedAt,
      ...(processGenerationToken === undefined ? {} : { processGenerationToken }),
    });
  }

  return records;
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

export interface DaemonProcessLivenessChecker {
  isProcessRunning(pid: number): boolean;
  /**
   * Opaque OS generation token for the process currently holding `pid`
   * (issue #10108). Optional: a checker without it leaves a recorded PID
   * trusted as live, which is the safe default. Returns undefined when the
   * token cannot be read; callers must never read that as "the PID is free".
   */
  readProcessGenerationToken?(pid: number): string | undefined;
}

export interface DaemonProcessSignaler {
  signal(pid: number, signal: NodeJS.Signals): void;
}
function boundedProcessTableScanTimeout(timeoutMs: number | undefined): number {
  return Math.max(
    MIN_PROCESS_TABLE_SCAN_TIMEOUT_MS,
    Math.min(
      timeoutMs ?? DAEMON_PROCESS_TABLE_SCAN_TIMEOUT_MS,
      DAEMON_PROCESS_TABLE_SCAN_TIMEOUT_MS,
    ),
  );
}

function isUnsupportedGnuProcessTableFormat(error: unknown): boolean {
  return /(?:\betimes\b|\b(?:invalid|unrecognized|unknown|unsupported)\s+option\b|\bbad\s+-o\b)/i.test(
    errorMessage(error),
  );
}

export class PsDaemonProcessFinder implements DaemonProcessFinder, DaemonProcessLivenessChecker {
  constructor(
    private readonly runCommand: ProcessTableCommandRunner = execSync,
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly timer: Timer = defaultTimer,
    private readonly linuxProcessGenerationTokenForPid: (
      pid: number,
    ) => string | undefined = readLinuxProcessGenerationToken,
    private readonly activeEntryScript: string | undefined = process.argv[1],
  ) {}

  findDaemonProcesses(timeoutMs?: number): DaemonProcessRecord[] {
    const isDarwin = this.platform === "darwin";
    const scanTimeoutMs = boundedProcessTableScanTimeout(timeoutMs);
    const scanDeadline = this.timer.now() + scanTimeoutMs;
    const runScan = (command: string): { output: string; scannedAt: number } => {
      // Relative ages belong to the snapshot immediately before this scan, not
      // to the later time at which a loaded host returns the process table.
      const scannedAt = this.timer.now();
      const remaining = scanDeadline - scannedAt;
      if (remaining <= 0) {
        throw new Error("Process-table inspection ETIMEDOUT before scan could begin");
      }
      return {
        output: this.runCommand(command, {
          encoding: "utf-8",
          maxBuffer: DAEMON_PROCESS_TABLE_MAX_BUFFER_BYTES,
          timeout: Math.max(MIN_PROCESS_TABLE_SCAN_TIMEOUT_MS, remaining),
        }),
        scannedAt,
      };
    };

    if (isDarwin) {
      const { output } = runScan("LC_ALL=C ps -axo pid=,ppid=,lstart=,command=");
      return parseDarwinDaemonProcessTable(output, this.activeEntryScript);
    }

    try {
      const { output, scannedAt } = runScan("ps -eo pid=,ppid=,etimes=,command=");
      return this.withLinuxProcessGenerationTokens(
        parseDaemonProcessTable(output, scannedAt, this.activeEntryScript),
      );
    } catch (error) {
      if (!isUnsupportedGnuProcessTableFormat(error)) {
        throw error;
      }
      const { output, scannedAt } = runScan("ps -o pid,ppid,etime,args");
      return this.withLinuxProcessGenerationTokens(
        parseBusyBoxDaemonProcessTable(output, scannedAt, this.activeEntryScript),
      );
    }
  }

  private withLinuxProcessGenerationTokens(records: DaemonProcessRecord[]): DaemonProcessRecord[] {
    return records.map((record) => {
      const processGenerationToken = this.linuxProcessGenerationTokenForPid(record.pid);
      return processGenerationToken === undefined ? record : { ...record, processGenerationToken };
    });
  }

  isProcessRunning(pid: number): boolean {
    return isDaemonProcessRunning(pid, { debugLog: logger.debug });
  }

  readProcessGenerationToken(pid: number): string | undefined {
    if (this.platform === "darwin") {
      return readDarwinProcessGenerationToken(pid);
    }
    return this.platform === "linux" ? this.linuxProcessGenerationTokenForPid(pid) : undefined;
  }
}

export class WindowsDaemonProcessFinder
  implements DaemonProcessFinder, DaemonProcessLivenessChecker
{
  constructor(
    private readonly runCommand: ProcessTableCommandRunner = execSync,
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

export function createDefaultDaemonProcessFinder(
  platform: NodeJS.Platform = process.platform,
): DaemonProcessFinder & DaemonProcessLivenessChecker {
  return platform === "win32"
    ? new WindowsDaemonProcessFinder()
    : new PsDaemonProcessFinder(undefined, platform);
}
