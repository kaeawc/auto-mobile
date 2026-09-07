import os from "node:os";
import path from "node:path";
import { existsSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { PID_FILE_PATH, SOCKET_PATH } from "./constants";
import { getSocketPath, type SocketServerConfig } from "./socketServer/index";
import type { AuxiliaryDaemonSocketName, PidFileData } from "./types";
import { logger } from "../utils/logger";
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
 * Every daemon pid file that could share a log directory with `pidFilePath`'s
 * namespace: `pidFilePath` itself plus any sibling `auto-mobile-daemon-*.pid`
 * in the same directory (other isolated namespaces, issue #6140).
 *
 * When isolated daemons SHARE an `AUTOMOBILE_LOG_DIR`, a `daemon-launch-*.log`
 * in that dir may be held by a LIVE daemon from a namespace OTHER than the one
 * doing the pruning. Checking only the pruning process's own pid file would
 * miss that and unlink a live daemon's launch log (issue #6194). Enumerating
 * all co-located pid files lets the pruner retain a launch log while ANY
 * namespace's daemon is alive.
 *
 * Best-effort and deduplicated: an unreadable directory degrades to just
 * `pidFilePath`, so the caller never loses its own-namespace check. Errs toward
 * over-inclusion (an unrelated namespace's live daemon only causes a launch log
 * to be retained a little longer — the safe direction here).
 */
export function listDaemonPidFilesSync(pidFilePath: string = PID_FILE_PATH): string[] {
  const dir = path.dirname(pidFilePath);
  const found = new Set<string>([pidFilePath]);
  try {
    for (const entry of readdirSync(dir)) {
      if (entry.startsWith(DAEMON_PID_FILE_BASENAME_PREFIX) && entry.endsWith(".pid")) {
        found.add(path.join(dir, entry));
      }
    }
  } catch (error) {
    // An unreadable pidfile directory only narrows the scan to our own
    // namespace; retaining that single check is the safe degraded behavior.
    logger.debug(`src/daemon/daemonFiles.ts pidfile dir scan failed: ${error}`, error);
  }
  return [...found];
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
    logger.debug(`src/daemon/daemonFiles.ts pidfile parse failed: ${error}`, error);
    return null;
  }
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
    logger.debug(`src/daemon/daemonFiles.ts liveness check failed: ${error}`, error);
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
