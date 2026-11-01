import {
  availableDaemonSockets,
  degradeAuxiliarySocket,
  markAuxiliarySocketAvailable,
} from "../auxiliarySocketAvailability";
import type { DaemonCoreServices, DaemonIdentityState } from "./DaemonCoreState";
import { AuxiliarySocketHeldError } from "../AuxiliarySocketHeldError";
import { errorMessage } from "../../utils/describeUnknownError";
import { writeSync } from "node:fs";
import { republishOwnedIdentity } from "../identityRecovery";
import { logger } from "../../utils/logger";
import { SOCKET_PATH } from "../wire/constants";
import { ENV, readEnvRaw } from "../../config/env";
import { PidFileData, type AuxiliaryDaemonSocketName } from "../types";
import { statFileIdentity, type SocketFileIdentity } from "../socketFileIdentity";
import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import {
  PID_FILE_PATH,
  DAEMON_VERSION,
  resolveDaemonVersion,
  syncSettledDaemonVersion,
} from "../wire/constants";
import { getCurrentBuildIdentity } from "../wire/buildIdentity";
import {
  cleanupDaemonFiles,
  readPidFileDataSync,
  isProcessRunning,
  writePidFileDataAtomic,
  type DaemonCleanupFileSystem,
} from "../daemonFiles";
import { processGenerationRecordFields } from "../processGenerationFields";
import { getDatabasePath } from "../../db";
import { getDaemonSocketPathsByName } from "../socketPaths";
import { resolveAssetVersion, resolvePinnedVersion } from "../../constants/release";

export interface DaemonIdentityHost {
  pidFileWritten: () => boolean;
  setPidFileWritten: (value: boolean) => void;
  services: Pick<DaemonCoreServices, "options">;
  identity: Pick<
    DaemonIdentityState,
    | "port"
    | "completeIdentityPublished"
    | "socketBindCommitted"
    | "incumbentOwnerGuard"
    | "daemonSessionId"
    | "generationStartedAt"
    | "processStartedAt"
    | "processGenerationToken"
  >;
  cleanupDaemonFilesForShutdown: DaemonIdentity["cleanupDaemonFilesForShutdown"];
  writeEarlyOwnerRecord: DaemonIdentity["writeEarlyOwnerRecord"];
  persistPidFileData: DaemonIdentity["persistPidFileData"];
}

/** Publishes PID identity and records precisely which socket paths this daemon owns. */
export class DaemonIdentity {
  private readonly boundSocketIdentities = new Map<string, SocketFileIdentity>();
  private readonly host: DaemonIdentityHost;
  private readonly files: Pick<DaemonCleanupFileSystem, "stat">;
  private readonly platform: NodeJS.Platform;
  private readonly databasePath: () => string;
  private readonly reportStartupFailure: (message: string) => void;

  /**
   * @param host - Daemon identity state and PID-file callbacks
   * @param files - Socket-file identity reader
   * @param platform - Host platform
   * @param options.databasePath - Resolves the daemon database path
   * @param options.reportStartupFailure - Reports a startup failure (defaults to stderr)
   */
  constructor(
    host: DaemonIdentityHost,
    files: Pick<DaemonCleanupFileSystem, "stat"> = { stat: statFileIdentity },
    platform: NodeJS.Platform = process.platform,
    {
      databasePath = getDatabasePath,
      reportStartupFailure = (message) => {
        writeSync(2, `${message}\n`);
      },
    }: {
      databasePath?: () => string;
      reportStartupFailure?: (message: string) => void;
    } = {},
  ) {
    this.host = host;
    this.files = files;
    this.platform = platform;
    this.databasePath = databasePath;
    this.reportStartupFailure = reportStartupFailure;
  }

  /**
   * Persist a PID-file record to disk (creating the directory as needed).
   * Shared by the early owner record and the final complete write.
   */
  async persistPidFileData(pidData: PidFileData, signal?: AbortSignal): Promise<void> {
    await mkdir(dirname(PID_FILE_PATH), { recursive: true });
    signal?.throwIfAborted();
    await writePidFileDataAtomic(PID_FILE_PATH, pidData, signal);
    this.host.setPidFileWritten(true);
  }

  /**
   * Publish this daemon's owned DB path in the PID file BEFORE the DB is opened.
   *
   * `Daemon.start()` opens and migrates the shared SQLite file (via
   * {@link initializeDatabase}) seconds before the full PID file is written (that
   * only happens after port selection and device discovery). Between those points
   * the daemon is live and visible to `ps`, but its `dbPath` is not yet recorded —
   * so the direct-mode DB-ownership guard (see {@link import("./directModeGuard")})
   * would see an owner with an unknown path and fail CLOSED, transiently refusing a
   * concurrent direct-mode launch even when it targets an ISOLATED `AUTOMOBILE_DB_PATH`.
   *
   * Recording the resolved `dbPath` (knowable via {@link getDatabasePath} WITHOUT
   * opening the DB) before {@link initializeDatabase} closes that window: any daemon
   * that has opened the DB now always exposes a resolvable `dbPath`, so a same-file
   * launch is still refused while an isolated-path launch is allowed. The remaining
   * TOCTOU (a daemon opening the DB immediately after the guard's check) is covered
   * by the migration cross-process lock (#2794). Issue #2871.
   *
   * The record is minimal by design (pid, daemonSessionId, dbPath, socketPath,
   * startedAt, processStartedAt, version).
   * Consumers that gate on daemon readiness — `status()`/`waitForReady()` — key on
   * the socket file plus `verifyDaemonConnection`, not on the PID file's `port`, so
   * a partial record written before the socket exists cannot make the daemon look
   * ready early. {@link writePidFile} overwrites it with the complete record.
   */
  async writeEarlyOwnerRecord(): Promise<void> {
    if (!syncSettledDaemonVersion()) {
      await resolveDaemonVersion();
    }
    // Snapshot any live incumbent BEFORE this overwrite clobbers its PID record,
    // so the lock-less bind guard can still see the live sibling and restore its
    // record on refusal instead of unlinking/orphaning it (issue #6232).
    this.host.identity.incumbentOwnerGuard().captureIncumbentBeforeOverwrite();
    // A DEAD committed owner is carried on this record: if this start dies before
    // binding, the next start still has proof the leftover socket is reclaimable
    // (issue #10107).
    const supersededOwner = this.host.identity
      .incumbentOwnerGuard()
      .supersededOwnerForEarlyRecord();
    const pidData: PidFileData = {
      pid: process.pid,
      launchNonce: readEnvRaw(ENV.DAEMON_LAUNCH_NONCE),
      daemonSessionId: this.host.identity.daemonSessionId(),
      socketPath: SOCKET_PATH,
      port: this.host.identity.port(),
      dbPath: this.databasePath(),
      startedAt: this.host.identity.generationStartedAt(),
      processStartedAt: this.host.identity.processStartedAt(),
      ...processGenerationRecordFields(this.host.identity.processGenerationToken()),
      version: DAEMON_VERSION,
      launchLogPath: this.launchLogPath(),
      assetVersion: resolveAssetVersion(resolvePinnedVersion()),
      options: this.host.services.options(),
      ...(supersededOwner === undefined ? {} : { supersededOwner }),
    };
    await this.host.persistPidFileData(pidData);
    this.host.identity.incumbentOwnerGuard().recordContenderEarlyOwner(pidData);
    logger.info(`Early daemon owner record written to ${PID_FILE_PATH} (dbPath ${pidData.dbPath})`);
  }

  /**
   * Write PID file with daemon metadata
   */
  async writePidFile(signal?: AbortSignal): Promise<void> {
    if (!syncSettledDaemonVersion()) {
      await resolveDaemonVersion();
    }
    signal?.throwIfAborted();
    const buildIdentity = getCurrentBuildIdentity();
    const pidData: PidFileData = {
      pid: process.pid,
      launchNonce: readEnvRaw(ENV.DAEMON_LAUNCH_NONCE),
      daemonSessionId: this.host.identity.daemonSessionId(),
      socketPath: SOCKET_PATH,
      sockets: availableDaemonSockets(getDaemonSocketPathsByName()),
      port: this.host.identity.port(),
      dbPath: this.databasePath(),
      startedAt: this.host.identity.generationStartedAt(),
      processStartedAt: this.host.identity.processStartedAt(),
      ...processGenerationRecordFields(this.host.identity.processGenerationToken()),
      version: DAEMON_VERSION,
      launchLogPath: this.launchLogPath(),
      assetVersion: resolveAssetVersion(resolvePinnedVersion()),
      entryScript: buildIdentity.entryScript,
      buildId: buildIdentity.buildId,
      options: this.host.services.options(),
    };

    await this.host.persistPidFileData(pidData, signal);
    signal?.throwIfAborted();
    logger.info(`PID file written to ${PID_FILE_PATH}`);
  }

  republishIdentity(): Promise<boolean> {
    return republishOwnedIdentity(
      this.host.identity.completeIdentityPublished(),
      {
        pid: process.pid,
        startedAt: this.host.identity.generationStartedAt(),
        processGenerationToken: this.host.identity.processGenerationToken(),
      },
      {
        readRecord: () => readPidFileDataSync(),
        writeRecord: () => this.writePidFile(),
        isProcessRunning: (pid) => isProcessRunning(pid, { debugLog: logger.debug }),
      },
      availableDaemonSockets(getDaemonSocketPathsByName()),
    );
  }

  private launchLogPath(): string | null {
    const logPath = readEnvRaw(ENV.DAEMON_LAUNCH_LOG_PATH);
    return logPath && isAbsolute(logPath) ? logPath : null;
  }

  async cleanupDaemonFilesForShutdown(): Promise<void> {
    // A signal during a contended start stops us before the socket bind: exit
    // cleanup is suppressed then, so put the live incumbent's record back here or
    // the PID file keeps naming this exiting contender (#11156).
    if (!this.host.identity.socketBindCommitted()) {
      this.restoreIncumbentOwnerRecord();
    }
    await cleanupDaemonFiles(this.getDaemonFileCleanupOptions());
  }

  /** Put a displaced live incumbent's PID record back after this contender gave up (#6232). */
  restoreIncumbentOwnerRecord(): void {
    try {
      this.host.identity.incumbentOwnerGuard().restoreIncumbentAfterRefusal();
    } catch (restoreError) {
      // Repairing a displaced PID record is best effort. The startup failure or
      // shutdown remains the actionable diagnostic for the operator.
      logger.warn(
        `Failed to restore the incumbent daemon owner record after a refused start: ${restoreError}`,
      );
    }
  }

  recordControlSocketIdentity(): void {
    this.recordSocketIdentity(SOCKET_PATH);
  }

  private recordSocketIdentity(socketPath: string): void {
    try {
      const { dev, ino } = this.files.stat(socketPath);
      this.boundSocketIdentities.set(socketPath, { dev, ino });
    } catch (error) {
      // An unidentified bound path must never join destructive exit cleanup.
      // Named pipes have no filesystem inode on Windows; this is expected.
      const log = this.platform === "win32" ? logger.debug : logger.warn;
      log(`[Daemon] Cannot record ownership of socket ${socketPath}: ${error}`);
    }
  }

  async startAuxiliarySocket(
    name: AuxiliaryDaemonSocketName,
    start: () => Promise<unknown>,
  ): Promise<void> {
    try {
      await start();
    } catch (error) {
      const warning = degradeAuxiliarySocket(name, error);
      if (!warning) {
        if (error instanceof AuxiliarySocketHeldError) {
          this.reportHeldSocketFailure(error);
        }
        throw error;
      }
      logger.warn(`[Daemon] ${warning.code}: ${name} disabled at ${warning.socketPath}`, error);
      return;
    }
    markAuxiliarySocketAvailable(name);
    this.recordSocketIdentity(getDaemonSocketPathsByName()[name]);
  }

  private reportHeldSocketFailure(error: AuxiliarySocketHeldError): void {
    try {
      // Synchronous stderr reaches the launcher capture even if teardown exits immediately.
      this.reportStartupFailure(error.message);
    } catch (reportError) {
      // Diagnostic output must never mask the original startup error.
      logger.debug(`Unable to report startup failure: ${errorMessage(reportError)}`, reportError);
    }
  }

  getDaemonFileCleanupOptions(): {
    expectedPid?: number;
    socketBindCommitted: boolean;
    socketPaths: string[];
    socketFileIdentities: ReadonlyMap<string, SocketFileIdentity>;
  } {
    // Gate destructive cleanup on actually holding the socket bind. A lock-less
    // contender refused over a live sibling (issue #6232) has written its early
    // owner record (issue #2871) — so `pidFileWritten` is already true and the
    // `expectedPid` self-check would authorize deletion — yet it never bound the
    // socket. Threading `socketBindCommitted` through makes the cleanup a no-op
    // for that loser, so the live winner's socket/PID files survive its exit
    // (the #6140 brick, prevented here rather than reached). An aux bind can
    // still be refused after this control bind, so only recorded aux paths join
    // the cleanup list.
    const socketBindCommitted = this.host.identity.socketBindCommitted();
    const socketPaths = socketBindCommitted ? [...this.boundSocketIdentities.keys()] : [];
    const socketFileIdentities = this.boundSocketIdentities;
    if (this.host.pidFileWritten()) {
      return { expectedPid: process.pid, socketBindCommitted, socketPaths, socketFileIdentities };
    }
    const pidData = readPidFileDataSync();
    return pidData && pidData.pid !== process.pid
      ? { expectedPid: process.pid, socketBindCommitted, socketPaths, socketFileIdentities }
      : { socketBindCommitted, socketPaths, socketFileIdentities };
  }
}
