import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { daemonOptionsSchema } from "./client";
import type { DaemonOptions } from "./types";
import { logger } from "../utils/logger";
import { errorMessage } from "../utils/describeUnknownError";

export type DaemonSelfExitReason =
  | "orphan-watchdog"
  | "database-health"
  | "startup-failure"
  | "unexpected-exit";

export interface DaemonExitRecord {
  reason: DaemonSelfExitReason;
  exitedAtMs: number;
  buildId: string;
  options: DaemonOptions;
}

export interface DaemonExitRecordFileSystem {
  readFileSync(path: string, encoding: "utf8"): string;
  writeFileSync(path: string, data: string): void;
  rmSync(path: string, options: { force: true }): void;
}

export const defaultDaemonExitRecordFileSystem: DaemonExitRecordFileSystem = {
  readFileSync,
  writeFileSync,
  rmSync,
};

/** An exit record older than this no longer describes the port's state (#11092). */
export const DAEMON_EXIT_RECORD_TTL_MS = 30 * 60 * 1000;

const exitRecordSchema = z.object({
  reason: z.enum(["orphan-watchdog", "database-health", "startup-failure", "unexpected-exit"]),
  exitedAtMs: z.number().finite(),
  buildId: z.string(),
  options: daemonOptionsSchema,
}) satisfies z.ZodType<DaemonExitRecord>;

export function daemonExitRecordPath(socketPath: string): string {
  return `${socketPath}.exit-record.json`;
}

export function writeDaemonExitRecord(
  socketPath: string,
  record: DaemonExitRecord,
  fileSystem: DaemonExitRecordFileSystem = defaultDaemonExitRecordFileSystem,
): void {
  try {
    fileSystem.writeFileSync(daemonExitRecordPath(socketPath), JSON.stringify(record));
  } catch (error) {
    logger.warn(`Failed to record daemon self-exit: ${errorMessage(error)}`, error);
  }
}

export function removeDaemonExitRecord(
  socketPath: string,
  fileSystem: DaemonExitRecordFileSystem = defaultDaemonExitRecordFileSystem,
): void {
  try {
    fileSystem.rmSync(daemonExitRecordPath(socketPath), { force: true });
  } catch (error) {
    logger.warn(`Failed to remove daemon exit record: ${errorMessage(error)}`, error);
  }
}

/** Consume before validating so malformed records cannot affect subsequent starts either. */
export function consumeDaemonExitRecord(
  socketPath: string,
  fileSystem: DaemonExitRecordFileSystem = defaultDaemonExitRecordFileSystem,
): DaemonExitRecord | undefined {
  const path = daemonExitRecordPath(socketPath);
  let raw: string;
  try {
    raw = fileSystem.readFileSync(path, "utf8");
  } catch (error) {
    // Most starts have no predecessor record and simply use the client's settings.
    logger.debug(`No daemon exit record at ${path}: ${errorMessage(error)}`);
    return undefined;
  }
  removeDaemonExitRecord(socketPath, fileSystem);
  try {
    const parsed: unknown = JSON.parse(raw);
    const result = exitRecordSchema.safeParse(parsed);
    if (result.success) {
      return result.data;
    }
    logger.warn(`Ignoring malformed daemon exit record ${path}: ${result.error.message}`);
  } catch (error) {
    logger.warn(`Ignoring malformed daemon exit record ${path}: ${errorMessage(error)}`, error);
  }
  return undefined;
}

export interface DaemonExitOptionsResolution {
  options: DaemonOptions;
  outcome: "inherited" | "stale" | "build-mismatch" | "none";
  inheritedPort: boolean;
}

/** Explicit tool choices override conflicts in an inherited opposite list. */
export function mergeDaemonStartupOptions(
  running: DaemonOptions,
  requested: DaemonOptions,
): DaemonOptions {
  const merged = { ...running, ...requested };
  if (
    requested.enabledTools !== undefined &&
    requested.disabledTools === undefined &&
    running.disabledTools !== undefined
  ) {
    merged.disabledTools = running.disabledTools.filter(
      (name) => !requested.enabledTools?.includes(name),
    );
  }
  if (
    requested.disabledTools !== undefined &&
    requested.enabledTools === undefined &&
    running.enabledTools !== undefined
  ) {
    merged.enabledTools = running.enabledTools.filter(
      (name) => !requested.disabledTools?.includes(name),
    );
  }
  return merged;
}

export function resolveDaemonExitOptions(
  requested: DaemonOptions,
  record: DaemonExitRecord | undefined,
  now: number,
  ttl: number,
  buildId: string,
): DaemonExitOptionsResolution {
  const options: DaemonOptions = Object.fromEntries(
    Object.entries(requested).filter(([, value]) => value !== undefined),
  );
  if (!record) {
    return { options, outcome: "none", inheritedPort: false };
  }
  if (now - record.exitedAtMs > ttl) {
    return { options, outcome: "stale", inheritedPort: false };
  }
  if (record.buildId !== buildId) {
    return { options, outcome: "build-mismatch", inheritedPort: false };
  }
  // Startup booleans are positive-only: a client's false default is omission.
  const explicitOptions: DaemonOptions = Object.fromEntries(
    Object.entries(options).filter(([, value]) => value !== false),
  );
  const inherited = { ...record.options };
  if (options.port !== undefined) {
    delete inherited.port;
    delete inherited.strictPort;
  }
  return {
    options: mergeDaemonStartupOptions(inherited, explicitOptions),
    outcome: "inherited",
    inheritedPort: options.port === undefined && inherited.port !== undefined,
  };
}

export interface DaemonSelfExitRecorderDeps {
  write(record: DaemonExitRecord): void;
  now(): number;
  buildId(): string;
  options(): DaemonOptions;
  /** Only an entered daemon with a committed bind or no live incumbent may publish. */
  canRecord(): boolean;
}

export class DaemonSelfExitRecorder {
  private cleanStop = false;
  private recorded = false;

  constructor(private readonly deps: DaemonSelfExitRecorderDeps) {}

  markCleanStop(): void {
    this.cleanStop = true;
  }

  record(reason: DaemonSelfExitReason): void {
    if (this.cleanStop || this.recorded) {
      return;
    }
    try {
      if (!this.deps.canRecord()) {
        return;
      }
      // The exit backstop must not overwrite the first reason, even if its writer failed.
      this.recorded = true;
      this.deps.write({
        reason,
        exitedAtMs: this.deps.now(),
        buildId: this.deps.buildId(),
        options: this.deps.options(),
      });
    } catch (error) {
      logger.warn(`Failed to record daemon self-exit: ${errorMessage(error)}`, error);
    }
  }
}
