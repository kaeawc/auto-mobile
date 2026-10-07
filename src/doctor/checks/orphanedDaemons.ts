/**
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { PID_FILE_PATH, SOCKET_PATH } from "../../daemon/constants";
import { readPidFileDataSync } from "../../daemon/daemonFiles";
import {
  createDefaultDaemonProcessFinder,
  parseDaemonSocketPath,
  type DaemonProcessFinder,
  type DaemonProcessRecord,
} from "../../daemon/processTable";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import type { CheckResult } from "../types";
import type { DoctorProbeOptions } from "../types";

const CHECK_NAME = "Orphaned Daemons";

/** The daemon the host's PID record names as active, if any. */
export interface ActiveDaemonRecord {
  pid: number;
  socketPath: string;
}

export interface OrphanedDaemonDependencies {
  processFinder?: DaemonProcessFinder;
  /** Reads the active daemon's PID record; null when none is recorded. */
  readActiveDaemon?: () => ActiveDaemonRecord | null;
  timer?: Timer;
  platform?: NodeJS.Platform;
}

function defaultReadActiveDaemon(): ActiveDaemonRecord | null {
  const data = readPidFileDataSync(PID_FILE_PATH);
  return data ? { pid: data.pid, socketPath: data.socketPath ?? SOCKET_PATH } : null;
}

function describeOrphan(record: DaemonProcessRecord, now: number): string {
  const socketPath = record.socketPath ?? parseDaemonSocketPath(record.command);
  const age =
    record.startedAt === undefined
      ? "age unknown"
      : `running ${Math.max(0, Math.round((now - record.startedAt) / 1000))}s`;
  return `PID ${record.pid}, socket ${socketPath ?? "unmarked"}, ${age}`;
}

/**
 * Report AutoMobile daemons re-parented to PID 1 that are not the daemon the
 * PID record names (stale builds, private daemons whose parent died). Doctor is
 * report-only: it names the remedy and never signals a process.
 */
export async function checkOrphanedDaemons(
  dependencies: OrphanedDaemonDependencies = {},
  probe: DoctorProbeOptions = {},
): Promise<CheckResult> {
  const platform = dependencies.platform ?? process.platform;
  if (platform === "win32") {
    return {
      name: CHECK_NAME,
      status: "skip",
      message: "Orphan detection relies on PID 1 re-parenting (not available on Windows)",
    };
  }
  try {
    const finder = dependencies.processFinder ?? createDefaultDaemonProcessFinder(platform);
    const active = (dependencies.readActiveDaemon ?? defaultReadActiveDaemon)();
    const orphans = finder
      .findDaemonProcesses(probe.timeoutMs)
      .filter((record) => record.ppid === 1 && record.pid !== active?.pid);
    if (orphans.length === 0) {
      return { name: CHECK_NAME, status: "pass", message: "No orphaned AutoMobile daemons found" };
    }
    const now = (dependencies.timer ?? defaultTimer).now();
    return {
      name: CHECK_NAME,
      status: "warn",
      message: `${orphans.length} AutoMobile daemon(s) not matching the active daemon record`,
      value: orphans.length,
      detail: orphans.map((record) => `- ${describeOrphan(record, now)}`).join("\n"),
      recommendation:
        "If none of these daemons is in use (private or test daemons), stop them yourself with " +
        "`kill <PID>`; doctor never stops processes. The active daemon is unaffected.",
    };
  } catch (error) {
    logger.warn(`Orphaned daemon check failed: ${errorMessage(error)}`, error);
    return {
      name: CHECK_NAME,
      status: "warn",
      message: `Could not inspect the process table: ${errorMessage(error)}`,
    };
  }
}
