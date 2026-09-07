import os from "node:os";
import path from "node:path";
import { existsSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { DEFAULT_PID_FILE_PATH, PID_FILE_PATH, SOCKET_PATH } from "./constants";
import { getSocketPath, type SocketServerConfig } from "./socketServer/index";
import type { AuxiliaryDaemonSocketName, PidFileData } from "./types";
import { logger } from "../utils/logger";
import type { DaemonPidFileEnumeration } from "../utils/logPruner";
import { resolvePathFromDaemonLaunchWorkingDirectory } from "../utils/workingDirectory";

export const VIDEO_RECORDING_SOCKET_CONFIG: SocketServerConfig = {
  defaultPath: path.join(os.homedir(), ".auto-mobile", "video-recording.sock"),
};

export const VIDEO_STREAM_SOCKET_CONFIG: SocketServerConfig = {
  defaultPath: path.join(os.homedir(), ".auto-mobile", "video-stream.sock"),
};

export const TEST_RECORDING_SOCKET_CONFIG: SocketServerConfig = {
  defaultPath: path.join(os.homedir(), ".auto-mobile", "test-recording.sock"),
};

export const DEVICE_SNAPSHOT_SOCKET_CONFIG: SocketServerConfig = {
  defaultPath: path.join(os.homedir(), ".auto-mobile", "device-snapshot.sock"),
};

export const APPEARANCE_SOCKET_CONFIG: SocketServerConfig = {
  defaultPath: path.join(os.homedir(), ".auto-mobile", "appearance.sock"),
};

export const PERFORMANCE_STREAM_SOCKET_CONFIG: SocketServerConfig = {
  defaultPath: path.join(os.homedir(), ".auto-mobile", "performance-stream.sock"),
};

export const PERFORMANCE_PUSH_SOCKET_CONFIG: SocketServerConfig = {
  defaultPath: path.join(os.homedir(), ".auto-mobile", "performance-push.sock"),
};

export const DEVICE_DATA_STREAM_SOCKET_CONFIG: SocketServerConfig = {
  defaultPath: path.join(os.homedir(), ".auto-mobile", "observation-stream.sock"),
};

export const FAILURES_STREAM_SOCKET_CONFIG: SocketServerConfig = {
  defaultPath: path.join(os.homedir(), ".auto-mobile", "failures-stream.sock"),
};

export const FAILURES_PUSH_SOCKET_CONFIG: SocketServerConfig = {
  defaultPath: path.join(os.homedir(), ".auto-mobile", "failures-push.sock"),
};

export const TELEMETRY_PUSH_SOCKET_CONFIG: SocketServerConfig = {
  defaultPath: path.join(os.homedir(), ".auto-mobile", "telemetry-push.sock"),
};

export const WEBRTC_STREAM_SOCKET_CONFIG: SocketServerConfig = {
  defaultPath: resolveWebRtcStreamSocketPath(),
};

function resolveWebRtcStreamSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  const override =
    env.AUTOMOBILE_WEBRTC_STREAM_SOCKET_PATH ?? env.AUTO_MOBILE_WEBRTC_STREAM_SOCKET_PATH;
  return override
    ? resolvePathFromDaemonLaunchWorkingDirectory(override)
    : path.join(os.homedir(), ".auto-mobile", "webrtc-stream.sock");
}

/**
 * Canonical registry of every auxiliary daemon socket, keyed by its published
 * name. This is the single source of truth: `getDaemonSocketPathList()` (cleanup)
 * and `getDaemonSocketPathsByName()` (publication, `socketPaths.ts`) both derive
 * from it, and the exhaustive `Record` type means adding a member to
 * `AuxiliaryDaemonSocketName` without registering it here is a compile error.
 */
export const AUXILIARY_SOCKET_CONFIGS_BY_NAME: Record<
  AuxiliaryDaemonSocketName,
  SocketServerConfig
> = {
  appearance: APPEARANCE_SOCKET_CONFIG,
  "device-snapshot": DEVICE_SNAPSHOT_SOCKET_CONFIG,
  "failures-push": FAILURES_PUSH_SOCKET_CONFIG,
  "failures-stream": FAILURES_STREAM_SOCKET_CONFIG,
  "observation-stream": DEVICE_DATA_STREAM_SOCKET_CONFIG,
  "performance-push": PERFORMANCE_PUSH_SOCKET_CONFIG,
  "performance-stream": PERFORMANCE_STREAM_SOCKET_CONFIG,
  "telemetry-push": TELEMETRY_PUSH_SOCKET_CONFIG,
  "test-recording": TEST_RECORDING_SOCKET_CONFIG,
  "video-recording": VIDEO_RECORDING_SOCKET_CONFIG,
  "video-stream": VIDEO_STREAM_SOCKET_CONFIG,
  "webrtc-stream": WEBRTC_STREAM_SOCKET_CONFIG,
};

export interface DaemonFileCleanupOptions {
  pidFilePath?: string;
  socketPaths?: string[];
  expectedPid?: number;
}

/**
 * Default on-disk paths of every daemon socket, for unlink-on-cleanup.
 *
 * Named apart from `getDaemonSocketPathsByName()` in `socketPaths.ts` (which
 * returns the keyed map of live paths for publication) so the two cannot be
 * confused at an import site — the shared-name/divergent-shape pair is what let
 * `video-stream.sock` escape both registries (issue #4195).
 */
export function getDaemonSocketPathList(): string[] {
  return [
    SOCKET_PATH,
    ...Object.values(AUXILIARY_SOCKET_CONFIGS_BY_NAME).map((config) => getSocketPath(config)),
  ];
}

export async function cleanupDaemonFiles(options: DaemonFileCleanupOptions = {}): Promise<boolean> {
  const pidFilePath = options.pidFilePath ?? PID_FILE_PATH;
  const socketPaths = options.socketPaths ?? getDaemonSocketPathList();

  if (!shouldCleanupForExpectedPid(pidFilePath, options.expectedPid)) {
    return false;
  }

  for (const socketPath of socketPaths) {
    if (!existsSync(socketPath)) {
      continue;
    }
    try {
      await unlink(socketPath);
    } catch {
      // Best-effort cleanup; callers should not fail shutdown/startup on stale files.
    }
  }

  if (existsSync(pidFilePath)) {
    try {
      await unlink(pidFilePath);
    } catch {
      // Best-effort cleanup.
    }
  }
  return true;
}

export function cleanupDaemonFilesSync(options: DaemonFileCleanupOptions = {}): boolean {
  const pidFilePath = options.pidFilePath ?? PID_FILE_PATH;
  const socketPaths = options.socketPaths ?? getDaemonSocketPathList();

  if (!shouldCleanupForExpectedPid(pidFilePath, options.expectedPid)) {
    return false;
  }

  for (const socketPath of socketPaths) {
    if (!existsSync(socketPath)) {
      continue;
    }
    try {
      unlinkSync(socketPath);
    } catch {
      // Best-effort cleanup.
    }
  }

  if (existsSync(pidFilePath)) {
    try {
      unlinkSync(pidFilePath);
    } catch {
      // Best-effort cleanup.
    }
  }
  return true;
}

/**
 * Basename prefix shared by every default/benchmark daemon pid file
 * (`auto-mobile-daemon-<uid>.pid`, `auto-mobile-daemon-bench-<token>.pid`, ...).
 * Isolated daemon namespaces (issue #6140) place their pid files alongside the
 * default one under the same directory, so this prefix is what lets one process
 * discover the OTHER namespaces that might share its log dir.
 */
const DAEMON_PID_FILE_BASENAME_PREFIX = "auto-mobile-daemon-";

/**
 * Best-effort debug log that tolerates the `logger`↔`daemonFiles` import cycle.
 *
 * `logger.ts` imports this module while it is still initializing (its startup
 * log-prune sweep reaches here), during which the `logger` const is in its TDZ
 * and merely touching it throws `ReferenceError: Cannot access 'logger' before
 * initialization`. These sync helpers can run inside that window, so route their
 * diagnostics through this wrapper: it drops the line if the logger is not yet
 * initialized rather than crashing the import (issue #6194).
 */
function logSafeDebug(message: string, error: unknown): void {
  try {
    logger.debug(message, error);
  } catch (loggerNotReady) {
    // `logger` still in its TDZ during the cyclic import; drop the diagnostic
    // rather than relocate the crash into a best-effort log line.
    void loggerNotReady;
  }
}

/**
 * Enumerate every daemon pid file that could share a log directory with
 * `pidFilePath`'s namespace — `pidFilePath` itself plus any sibling
 * `auto-mobile-daemon-*.pid` in the same directory (other isolated namespaces,
 * issue #6140) — and report whether that enumeration is COMPLETE
 * ({@link DaemonPidFileEnumeration}).
 *
 * When isolated daemons SHARE an `AUTOMOBILE_LOG_DIR`, a `daemon-launch-*.log`
 * in that dir may be held by a LIVE daemon from a namespace OTHER than the one
 * doing the pruning. Checking only the pruning process's own pid file would
 * miss that and unlink a live daemon's launch log (issue #6194). Enumerating
 * all co-located pid files lets the pruner retain a launch log while ANY
 * namespace's daemon is alive.
 *
 * A single-directory scan cannot discover namespaces whose pid files live
 * OUTSIDE the scanned directory. Two cases make discovery incomplete, and both
 * set `uncertain` so the pruner fails closed (retains launch logs):
 *   - a CUSTOM pid-file namespace (`pidFilePath` is not the default location):
 *     peers sharing this log dir may keep their pid files in other directories
 *     (e.g. `/state/a/daemon.pid`, `/state/b/daemon.pid`) that this scan can't
 *     see; and
 *   - an unreadable pid-file directory: the scan could not enumerate even the
 *     co-located siblings.
 *
 * In the DEFAULT namespace every daemon (default + bench + isolated) co-locates
 * its pid file in the same directory, so the scan is exhaustive and `uncertain`
 * stays false — launch logs there are still pruned once no daemon is alive.
 * Deduplicated, and always includes `pidFilePath` so the caller never loses its
 * own-namespace check.
 */
export function listDaemonPidFilesSync(
  pidFilePath: string = PID_FILE_PATH,
): DaemonPidFileEnumeration {
  const dir = path.dirname(pidFilePath);
  const found = new Set<string>([pidFilePath]);
  let uncertain = false;
  try {
    for (const entry of readdirSync(dir)) {
      if (entry.startsWith(DAEMON_PID_FILE_BASENAME_PREFIX) && entry.endsWith(".pid")) {
        found.add(path.join(dir, entry));
      }
    }
  } catch (error) {
    // The pid-file directory could not be read, so co-located sibling namespaces
    // could not be enumerated — carry uncertainty so the pruner retains launch
    // logs (a live daemon may exist in a namespace we failed to discover).
    uncertain = true;
    logSafeDebug(`src/daemon/daemonFiles.ts pidfile dir scan failed: ${error}`, error);
  }
  // A custom pid namespace may be shared, by other custom namespaces, through a
  // common AUTOMOBILE_LOG_DIR while its peers keep pid files in directories this
  // scan never visits. That is undiscoverable here, so mark it uncertain and let
  // the pruner fail closed (issue #6194). The default namespace co-locates every
  // pid file in one directory and stays certain.
  if (path.resolve(pidFilePath) !== path.resolve(DEFAULT_PID_FILE_PATH)) {
    uncertain = true;
  }
  return { pidFiles: [...found], uncertain };
}

export function readPidFileDataSync(pidFilePath: string = PID_FILE_PATH): PidFileData | null {
  if (!existsSync(pidFilePath)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(pidFilePath, "utf-8")) as PidFileData;
  } catch (error) {
    // A missing/malformed pidfile is expected when the daemon is stale or hasn't
    // written it yet; treating it as "no daemon" is the correct degraded behavior.
    logSafeDebug(`src/daemon/daemonFiles.ts pidfile parse failed: ${error}`, error);
    return null;
  }
}

/**
 * Read the owning daemon PID for a launch-log RETENTION decision, distinguishing
 * a CONFIDENTLY-absent pid file (returns `undefined` — no daemon recorded in that
 * namespace) from a present-but-unreadable/malformed one (THROWS — ambiguous).
 *
 * The pruner treats a throw as "a live daemon may still own this launch log" and
 * retains it, so an unreadable pid file must NOT be swallowed to `undefined` the
 * way {@link readPidFileDataSync} does — that would let a stale launch log be
 * pruned while a live daemon still holds the inherited fd (issue #6194). No
 * logger reference, so it is safe to call during the cyclic logger import.
 */
export function readDaemonPidForRetentionSync(
  pidFilePath: string = PID_FILE_PATH,
): number | undefined {
  if (!existsSync(pidFilePath)) {
    return undefined;
  }
  // A read/parse failure propagates on purpose: an existing but unreadable pid
  // file is ambiguous, and the pruner must fail closed (retain) on ambiguity.
  const data = JSON.parse(readFileSync(pidFilePath, "utf-8")) as PidFileData;
  return data.pid;
}

export function isProcessRunning(pid: number): boolean {
  // `process.kill(pid, 0)` treats non-positive PIDs specially rather than
  // naming a single process: pid 0 signals the CURRENT process group and
  // pid -1 signals EVERY process this user can signal — both "succeed" even
  // though no single real process named `0`/`-1` exists. A corrupt or stale
  // lock containing such a PID must never be reported as a live owner (issue
  // #6260) — that footgun would surface a `kill 0` / `kill -1` suggestion.
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH (no such process) or EPERM both mean the pid is not a live process
    // we own; reporting "not running" is the safe, correct answer here.
    logSafeDebug(`src/daemon/daemonFiles.ts liveness check failed: ${error}`, error);
    return false;
  }
}

function shouldCleanupForExpectedPid(
  pidFilePath: string,
  expectedPid: number | undefined,
): boolean {
  if (expectedPid === undefined) {
    return true;
  }
  const pidData = readPidFileDataSync(pidFilePath);
  return pidData?.pid === expectedPid;
}
