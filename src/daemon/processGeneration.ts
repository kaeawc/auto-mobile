import { readFileSync } from "node:fs";
import { logger } from "../utils/logger";
import { runDaemonProcessCommand, type DaemonProcessCommandRunner } from "./DaemonLauncher";
import type { DaemonGenerationIdentity } from "./liveAcceptanceCapability";

const LINUX_BOOT_ID_PATH = "/proc/sys/kernel/random/boot_id";
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

/** Canonicalizes Darwin's locale-independent `ps lstart` representation. */
export function darwinProcessGenerationToken(lstart: string): string | undefined {
  const normalized = lstart.trim().replace(/\s+/g, " ");
  return normalized.length > 0 ? `darwin:${normalized}` : undefined;
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
 * Reads only the current Darwin process's `lstart` value, instead of scanning
 * the process table. The C locale preserves the same canonical format used by
 * DaemonManager's full-table recovery scan.
 */
export function readDarwinProcessGenerationToken(
  pid: number,
  runCommand: DaemonProcessCommandRunner = runDaemonProcessCommand,
): string | undefined {
  try {
    return darwinProcessGenerationToken(
      runCommand("ps", ["-p", String(pid), "-o", "lstart="], {
        timeout: CURRENT_PROCESS_GENERATION_CAPTURE_TIMEOUT_MS,
        env: { ...process.env, LC_ALL: "C" },
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
