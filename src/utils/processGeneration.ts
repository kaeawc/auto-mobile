import { readFileSync } from "node:fs";
import { errorMessage } from "./describeUnknownError";
import { logger } from "./logger";
import { testOverrides } from "./testOverrides";
import { runDaemonProcessCommand, type DaemonProcessCommandRunner } from "./daemonProcessCommand";
import type { DaemonGenerationIdentity } from "./daemonGenerationIdentity";
import {
  DARWIN_UTC_PROCESS_GENERATION_PREFIX,
  recordedProcessGenerationToken,
} from "./processGenerationFields";

const LINUX_BOOT_ID_PATH = "/proc/sys/kernel/random/boot_id";
/**
 * Darwin token prefix for `ps lstart` rendered with the time zone pinned to UTC.
 * The earlier `darwin:` prefix carried the reader's LOCAL wall time, so the same
 * live process printed a different string under a different `TZ`. Tokens from
 * the two schemes are never comparable (see `compareProcessGenerationTokens`),
 * and the new scheme is published under its own record field
 * (`processGenerationFields.ts`) so builds that read the old one never see it.
 */
const DARWIN_PROCESS_GENERATION_PREFIX = DARWIN_UTC_PROCESS_GENERATION_PREFIX;
/** The retired, time-zone-dependent Darwin prefix: never proof of anything. */
const LEGACY_DARWIN_PROCESS_GENERATION_PREFIX = "darwin";
/**
 * Environment every Darwin `ps lstart` read must run under. `lstart` is local
 * wall time, so TZ is pinned for stability across daemon and CLI environments,
 * and LC_ALL pins the month/day names to the C locale.
 */
export const DARWIN_PS_LSTART_ENV = { LC_ALL: "C", TZ: "UTC" } as const;
const CURRENT_PROCESS_GENERATION_CAPTURE_TIMEOUT_MS = 1_000;
const LEGACY_DAEMON_GENERATION_FIELDS = [
  "pid",
  "startedAt",
  "version",
  "buildId",
  "entryScript",
] as const;

type FileReader = (path: string, encoding: BufferEncoding) => string;
export interface CurrentProcessGenerationTokenDependencies {
  platform?: NodeJS.Platform;
  pid?: number;
  readLinuxProcessGenerationToken?: (pid: number) => string | undefined;
  readDarwinProcessGenerationToken?: (pid: number) => string | undefined;
}

/**
 * Compares a claimed daemon generation with the authoritative one.
 *
 * Current callers must match the OS-derived token exactly. A caller that omits
 * the token is a legacy client, so retain the complete pre-token identity tuple
 * as its narrow fallback without weakening any of those existing fences.
 */
export function daemonGenerationMatches(
  expected: DaemonGenerationIdentity,
  claimed: Record<string, unknown>,
): boolean {
  // A client of a build that predates the zone-free Darwin field echoes no token
  // for such a daemon, which is the legacy-client case above.
  const claimedToken = recordedProcessGenerationToken(claimed);
  return (
    LEGACY_DAEMON_GENERATION_FIELDS.every((field) => claimed[field] === expected[field]) &&
    (claimedToken === undefined || claimedToken === expected.processGenerationToken)
  );
}

/**
 * Canonicalizes Darwin's `ps lstart` representation. The input MUST come from a
 * `ps` run under `DARWIN_PS_LSTART_ENV`; the token is only stable across
 * readers when the zone was pinned.
 */
export function darwinProcessGenerationToken(lstart: string): string | undefined {
  const normalized = lstart.trim().replace(/\s+/g, " ");
  return normalized.length > 0 ? `${DARWIN_PROCESS_GENERATION_PREFIX}:${normalized}` : undefined;
}

export type ProcessGenerationTokenComparison = "same" | "different" | "incomparable";

/** The scheme prefix (text before the first colon); an unprefixed token has "". */
function processGenerationTokenPrefix(token: string): string {
  const colon = token.indexOf(":");
  return colon < 0 ? "" : token.slice(0, colon);
}

/**
 * Whether two tokens name the same process generation. Equal strings are the
 * same. Unequal strings are only PROOF of different generations when both come
 * from one comparable scheme: tokens with different prefixes (including a
 * record written by an older build against a token read by this one) and the
 * retired time-zone-dependent `darwin:` scheme are "incomparable", which every
 * caller must treat as "cannot tell" and so keep trusting the recorded process.
 */
export function compareProcessGenerationTokens(
  recorded: string,
  current: string,
): ProcessGenerationTokenComparison {
  if (recorded === current) {
    return "same";
  }
  const prefix = processGenerationTokenPrefix(recorded);
  return prefix === processGenerationTokenPrefix(current) &&
    prefix !== LEGACY_DARWIN_PROCESS_GENERATION_PREFIX
    ? "different"
    : "incomparable";
}

/**
 * Linux's `/proc/<pid>/stat` field 22 is the process start tick since boot.
 * Pair it with the kernel boot ID so a stale PID record cannot match a process
 * from a later boot that happened to reuse both PID and start tick.
 */
export function linuxProcessGenerationToken(stat: string, bootId: string): string | undefined {
  const closingCommand = stat.lastIndexOf(")");
  if (closingCommand < 0) {
    return undefined;
  }
  const fields = stat
    .slice(closingCommand + 1)
    .trim()
    .split(/\s+/);
  // The suffix begins at stat field 3, so field 22 (starttime) is index 19.
  const startTicks = fields[19];
  const normalizedBootId = bootId.trim();
  if (!normalizedBootId || !startTicks || !/^\d+$/.test(startTicks)) {
    return undefined;
  }
  return `linux:${normalizedBootId}:${startTicks}`;
}

/**
 * Builds a Linux token reader that caches the boot ID while reading the
 * per-process start tick directly from procfs.
 */
export function createLinuxProcessGenerationTokenReader(
  readFile: FileReader = readFileSync,
): (pid: number) => string | undefined {
  let bootId: string | undefined;

  return (pid: number): string | undefined => {
    try {
      const stat = readFile(`/proc/${pid}/stat`, "utf-8");
      bootId ??= readFile(LINUX_BOOT_ID_PATH, "utf-8");
      return linuxProcessGenerationToken(stat, bootId);
    } catch (error) {
      logger.debug(`Unable to read Linux process generation token for PID ${pid}: ${error}`);
      return undefined;
    }
  };
}

/** Read a stable Linux process-generation token without reconstructing wall time. */
export const readLinuxProcessGenerationToken = createLinuxProcessGenerationTokenReader();

const DARWIN_LSTART_WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DARWIN_LSTART_MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** Render the C-locale ps lstart text in UTC, with whitespace already normalized. */
export function formatDarwinLstartUtc(startSeconds: number): string | undefined {
  if (!Number.isFinite(startSeconds) || !Number.isInteger(startSeconds) || startSeconds <= 0) {
    return undefined;
  }
  const start = new Date(startSeconds * 1_000);
  if (!Number.isFinite(start.getTime())) {
    return undefined;
  }
  const time = [start.getUTCHours(), start.getUTCMinutes(), start.getUTCSeconds()]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
  return `${DARWIN_LSTART_WEEKDAYS[start.getUTCDay()]} ${DARWIN_LSTART_MONTHS[start.getUTCMonth()]} ${start.getUTCDate()} ${time} ${String(start.getUTCFullYear()).padStart(4, "0")}`;
}

/** Darwin kinfo_proc begins with p_un.p_starttime: a little-endian timeval. */
export function decodeDarwinKinfoProcStartSeconds(
  buffer: Uint8Array,
  length: number,
): number | undefined {
  if (length < 16 || buffer.byteLength < 16) {
    return undefined;
  }
  const seconds = Number(new DataView(buffer.buffer, buffer.byteOffset, 16).getBigInt64(0, true));
  return seconds > 0 && Number.isSafeInteger(seconds) ? seconds : undefined;
}

export interface DarwinProcessStartReader {
  readStartSeconds(pid: number): number | undefined;
}

/** The native sysctl(3) argument list, in C order. */
type DarwinSysctlArgs = [
  mib: number,
  count: number,
  buffer: number,
  length: number,
  newValue: null,
  newLength: number,
];

/** Only the bun:ffi surface needed for sysctl; resolved lazily like bun:sqlite. */
interface DarwinSysctlFfi {
  FFIType: { ptr: number; u32: number; u64: number; i32: number };
  ptr(buffer: Int32Array | Uint8Array | BigUint64Array): number;
  dlopen(
    path: string,
    symbols: {
      sysctl: { args: number[]; returns: number };
    },
  ): {
    symbols: {
      sysctl: (...args: DarwinSysctlArgs) => number;
    };
  };
}

function loadDarwinProcessStartReader(): DarwinProcessStartReader {
  const { dlopen, ptr, FFIType } = require("bun:ffi") as DarwinSysctlFfi;
  const library = dlopen("/usr/lib/libSystem.B.dylib", {
    sysctl: {
      args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64],
      returns: FFIType.i32,
    },
  });
  // CTL_KERN, KERN_PROC, KERN_PROC_PID; one reader owns and reuses these buffers.
  const mib = new Int32Array([1, 14, 1, 0]);
  const buffer = new Uint8Array(648);
  const length = new BigUint64Array(1);
  return {
    readStartSeconds(pid) {
      try {
        mib[3] = pid;
        length[0] = BigInt(buffer.byteLength);
        const result = library.symbols.sysctl(
          ptr(mib),
          mib.length,
          ptr(buffer),
          ptr(length),
          null,
          0,
        );
        return result === 0
          ? decodeDarwinKinfoProcStartSeconds(buffer, Number(length[0]))
          : undefined;
      } catch (error) {
        // An unavailable sysctl identity is safe to swallow: the ps fallback follows.
        logger.debug(`Unable to read Darwin sysctl process start: ${errorMessage(error)}`);
        return undefined;
      }
    },
  };
}

let darwinStartReaderLoadAttempted = false;
let darwinStartReader: DarwinProcessStartReader | undefined;

function defaultDarwinProcessStartReader(): DarwinProcessStartReader | undefined {
  if (process.platform !== "darwin" || darwinStartReaderLoadAttempted) {
    return darwinStartReader;
  }
  darwinStartReaderLoadAttempted = true;
  try {
    darwinStartReader = loadDarwinProcessStartReader();
  } catch (error) {
    // A cached optional FFI load failure is safe to swallow: the ps fallback follows.
    logger.debug(`Unable to load Darwin sysctl process start reader: ${errorMessage(error)}`);
  }
  return darwinStartReader;
}

/** Procfs and an available Darwin sysctl reader permit an identity read on every check. */
export function processGenerationReadIsCheap(
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform === "linux") {
    return true;
  }
  return platform === "darwin" && defaultDarwinProcessStartReader() !== undefined;
}

/** Prefer a direct kernel start read, preserving the existing ps token and fallback. */
export function createDarwinProcessGenerationTokenReader(
  deps: {
    startReader?: DarwinProcessStartReader;
    runCommand?: DaemonProcessCommandRunner;
    captureDisabled?: () => boolean;
  } = {},
): (pid: number) => string | undefined {
  const {
    startReader = {
      readStartSeconds: (pid) => defaultDarwinProcessStartReader()?.readStartSeconds(pid),
    },
    runCommand = runDaemonProcessCommand,
    captureDisabled = () => testOverrides.processGenerationCaptureDisabled?.() ?? false,
  } = deps;
  return (pid) => {
    if (!captureDisabled()) {
      try {
        const seconds = startReader.readStartSeconds(pid);
        const lstart = seconds === undefined ? undefined : formatDarwinLstartUtc(seconds);
        if (lstart !== undefined) {
          return darwinProcessGenerationToken(lstart);
        }
      } catch (error) {
        // Optional start capture is safe to swallow: the ps fallback follows.
        logger.debug(`Unable to capture Darwin process start: ${errorMessage(error)}`);
      }
    }
    return readDarwinPsProcessGenerationToken(pid, runCommand);
  };
}

const defaultDarwinProcessGenerationTokenReader = createDarwinProcessGenerationTokenReader();

/** Explicit command runners retain the ps-only injection seam. */
export function readDarwinProcessGenerationToken(
  pid: number,
  runCommand?: DaemonProcessCommandRunner,
): string | undefined {
  return runCommand === undefined
    ? defaultDarwinProcessGenerationTokenReader(pid)
    : readDarwinPsProcessGenerationToken(pid, runCommand);
}

/**
 * Reads only one Darwin process's `lstart` value, instead of scanning the
 * process table. The pinned C locale and UTC zone preserve the same canonical
 * format used by DaemonManager's full-table recovery scan, independent of the
 * reader's `TZ`.
 */
function readDarwinPsProcessGenerationToken(
  pid: number,
  runCommand: DaemonProcessCommandRunner,
): string | undefined {
  try {
    return darwinProcessGenerationToken(
      runCommand("ps", ["-p", String(pid), "-o", "lstart="], {
        timeout: CURRENT_PROCESS_GENERATION_CAPTURE_TIMEOUT_MS,
        env: { ...process.env, ...DARWIN_PS_LSTART_ENV },
      }),
    );
  } catch (error) {
    logger.debug(`Unable to read Darwin process generation token for PID ${pid}: ${error}`);
    return undefined;
  }
}

/**
 * Creates a cached provider for the current process's stable generation token.
 * The current PID cannot change, so one direct OS read is enough for every
 * Daemon constructed in this process. Unsupported or unavailable inspection
 * intentionally omits the optional token so recovery retains legacy matching.
 */
export function createCurrentProcessGenerationTokenProvider(
  dependencies: CurrentProcessGenerationTokenDependencies = {},
): () => string | undefined {
  const {
    platform = process.platform,
    pid = process.pid,
    readLinuxProcessGenerationToken: readLinux = readLinuxProcessGenerationToken,
    readDarwinProcessGenerationToken: readDarwin = readDarwinProcessGenerationToken,
  } = dependencies;
  let wasCaptured = false;
  let token: string | undefined;

  return (): string | undefined => {
    if (wasCaptured) {
      return token;
    }
    wasCaptured = true;

    try {
      if (platform === "linux") {
        token = readLinux(pid);
      } else if (platform === "darwin") {
        token = readDarwin(pid);
      }
    } catch (error) {
      logger.debug(`Unable to read current daemon process generation token: ${error}`);
    }
    return token;
  };
}

const readCurrentDaemonProcessGenerationToken = createCurrentProcessGenerationTokenProvider();

/**
 * Direct, cached current-process capture used by Daemon construction. Unit tests construct
 * daemons in the test runner's own process, where the capture would launch `ps` from whichever
 * test file built the first one; the suite preload turns it off for them, and a daemon without a
 * token keeps legacy matching.
 */
export const currentDaemonProcessGenerationToken = (): string | undefined =>
  testOverrides.processGenerationCaptureDisabled?.()
    ? undefined
    : readCurrentDaemonProcessGenerationToken();

/** The platform-appropriate generation token for a live PID, or undefined where none can be read. */
export function readProcessGenerationTokenForPid(pid: number): string | undefined {
  if (process.platform === "darwin") {
    return readDarwinProcessGenerationToken(pid);
  }
  if (process.platform === "linux") {
    return readLinuxProcessGenerationToken(pid);
  }
  return undefined;
}
