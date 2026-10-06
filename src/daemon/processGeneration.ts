import { readFileSync } from "node:fs";
import { logger } from "../utils/logger";
import { runDaemonProcessCommand, type DaemonProcessCommandRunner } from "./DaemonLauncher";
import type { DaemonGenerationIdentity } from "./liveAcceptanceCapability";

const LINUX_BOOT_ID_PATH = "/proc/sys/kernel/random/boot_id";
/**
 * Darwin token prefix for `ps lstart` rendered with the time zone pinned to UTC.
 * The earlier `darwin:` prefix carried the reader's LOCAL wall time, so the same
 * live process printed a different string under a different `TZ`. Tokens from
 * the two schemes are never comparable (see `compareProcessGenerationTokens`).
 */
const DARWIN_PROCESS_GENERATION_PREFIX = "darwin-utc";
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
  return (
    LEGACY_DAEMON_GENERATION_FIELDS.every((field) => claimed[field] === expected[field]) &&
    (claimed.processGenerationToken === undefined ||
      claimed.processGenerationToken === expected.processGenerationToken)
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

/**
 * Reads only one Darwin process's `lstart` value, instead of scanning the
 * process table. The pinned C locale and UTC zone preserve the same canonical
 * format used by DaemonManager's full-table recovery scan, independent of the
 * reader's `TZ`.
 */
export function readDarwinProcessGenerationToken(
  pid: number,
  runCommand: DaemonProcessCommandRunner = runDaemonProcessCommand,
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

/** Direct, cached current-process capture used by Daemon construction. */
export const currentDaemonProcessGenerationToken = createCurrentProcessGenerationTokenProvider();
