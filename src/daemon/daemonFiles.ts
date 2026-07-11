import os from "node:os";
import path from "node:path";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { PID_FILE_PATH, SOCKET_PATH } from "./constants";
import { getSocketPath, type SocketServerConfig } from "./socketServer/index";
import type { PidFileData } from "./types";
import { logger } from "../utils/logger";

export const VIDEO_RECORDING_SOCKET_CONFIG: SocketServerConfig = {
  defaultPath: path.join(os.homedir(), ".auto-mobile", "video-recording.sock"),
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
  defaultPath: path.join(os.homedir(), ".auto-mobile", "webrtc-stream.sock"),
};

const AUXILIARY_SOCKET_CONFIGS: SocketServerConfig[] = [
  VIDEO_RECORDING_SOCKET_CONFIG,
  TEST_RECORDING_SOCKET_CONFIG,
  DEVICE_SNAPSHOT_SOCKET_CONFIG,
  APPEARANCE_SOCKET_CONFIG,
  PERFORMANCE_STREAM_SOCKET_CONFIG,
  PERFORMANCE_PUSH_SOCKET_CONFIG,
  DEVICE_DATA_STREAM_SOCKET_CONFIG,
  FAILURES_STREAM_SOCKET_CONFIG,
  FAILURES_PUSH_SOCKET_CONFIG,
  TELEMETRY_PUSH_SOCKET_CONFIG,
  WEBRTC_STREAM_SOCKET_CONFIG,
];

export interface DaemonFileCleanupOptions {
  pidFilePath?: string;
  socketPaths?: string[];
  expectedPid?: number;
}

export interface StaleDaemonFileCleanupOptions extends DaemonFileCleanupOptions {
  isProcessRunning?: (pid: number) => boolean;
}

export function getDaemonSocketPaths(): string[] {
  return [
    SOCKET_PATH,
    ...AUXILIARY_SOCKET_CONFIGS.map(config => getSocketPath(config)),
  ];
}

export async function cleanupDaemonFiles(options: DaemonFileCleanupOptions = {}): Promise<boolean> {
  const pidFilePath = options.pidFilePath ?? PID_FILE_PATH;
  const socketPaths = options.socketPaths ?? getDaemonSocketPaths();

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
  const socketPaths = options.socketPaths ?? getDaemonSocketPaths();

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

export function readPidFileDataSync(pidFilePath: string = PID_FILE_PATH): PidFileData | null {
  if (!existsSync(pidFilePath)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(pidFilePath, "utf-8")) as PidFileData;
  } catch (error) {
    // This probe is best-effort; callers can safely use the fallback value.
    logger.debug(`src/daemon/daemonFiles.ts fallback failed: ${error}`, error);
    return null;
  }
}

export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // This probe is best-effort; callers can safely use the fallback value.
    logger.debug(`src/daemon/daemonFiles.ts fallback failed: ${error}`, error);
    return false;
  }
}

function shouldCleanupForExpectedPid(pidFilePath: string, expectedPid: number | undefined): boolean {
  if (expectedPid === undefined) {
    return true;
  }
  const pidData = readPidFileDataSync(pidFilePath);
  return pidData?.pid === expectedPid;
}

export function cleanupStaleDaemonFilesForDeadPidSync(
  options: StaleDaemonFileCleanupOptions = {}
): boolean {
  const pidFilePath = options.pidFilePath ?? PID_FILE_PATH;
  const pidData = readPidFileDataSync(pidFilePath);
  if (!pidData || typeof pidData.pid !== "number") {
    return false;
  }

  const processRunning = options.isProcessRunning ?? isProcessRunning;
  if (processRunning(pidData.pid)) {
    return false;
  }

  return cleanupDaemonFilesSync({
    pidFilePath,
    socketPaths: options.socketPaths,
    expectedPid: pidData.pid,
  });
}
