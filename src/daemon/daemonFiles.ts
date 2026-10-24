import {
  createPidFileTemporaryPath,
  defaultAtomicPidFileWriteSyncDependencies,
  writeJsonFileAtomicSync,
  type AtomicPidFileWriteSyncDependencies,
} from "./atomicJsonFile";
export { writeJsonFileAtomicSync, type AtomicPidFileWriteSyncDependencies } from "./atomicJsonFile";
import path from "node:path";
import {
  constants as fsConstants,
  copyFileSync,
  existsSync,
  linkSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { rename, unlink, writeFile } from "node:fs/promises";
import { DEFAULT_PID_FILE_PATH, PID_FILE_PATH, SOCKET_PATH } from "./wire/constants";
import { sameFileIdentity, statFileIdentity, type SocketFileIdentity } from "./socketFileIdentity";
import {
  compareProcessGenerationTokens,
  readProcessGenerationTokenForPid,
} from "./processGeneration";
import { recordedProcessGenerationToken } from "./processGenerationFields";
import {
  getSocketPath,
  resolveAuxSocketDir,
  type SocketServerConfig,
} from "./socketServer/SocketServerTypes";
import type { AuxiliaryDaemonSocketName, PidFileData } from "./types";
import { compareStrictNumericVersions } from "../utils/deviceMatcher";
import { logger, registerLogRetentionNamespaceSource } from "../utils/logger";
import type { DaemonLaunchLogOwner, DaemonPidFileEnumeration } from "../utils/logPruner";
import { releaseVersion } from "../utils/mcpVersion";
import { isProcessRunning } from "../utils/processLiveness";
import { resolvePathFromDaemonLaunchWorkingDirectory } from "../utils/workingDirectory";
import { sortedReaddirSync } from "../utils/io";
import { ENV, readEnvRaw } from "../config/env";
import type { IdGenerator } from "../utils/IdGenerator";
import { OwnedRecordRestoreError, removeOwnedFileSync } from "./ownedFileRemoval";

export {
  compareProcessGenerationTokens,
  readProcessGenerationTokenForPid,
  type ProcessGenerationTokenComparison,
} from "./processGeneration";

// Register hoisted functions only: no discovery/read or logger access at module
// initialization. CLI/MCP/doctor and daemon imports all share this wiring. A
// logger-only path retains launch logs conservatively until this module loads.
registerLogRetentionNamespaceSource({
  listDaemonPidFilesSync,
  readPidFileDataSync,
  readDaemonOwnerForRetentionSync,
  readDaemonLaunchLogOwnerTombstoneSync,
});

export const VIDEO_RECORDING_SOCKET_CONFIG: SocketServerConfig = {
  get defaultPath() {
    return path.join(resolveAuxSocketDir(), "video-recording.sock");
  },
};

export const VIDEO_STREAM_SOCKET_CONFIG: SocketServerConfig = {
  get defaultPath() {
    return path.join(resolveAuxSocketDir(), "video-stream.sock");
  },
};

export const DEVICE_GESTURE_RECORDING_SOCKET_CONFIG: SocketServerConfig = {
  get defaultPath() {
    return path.join(resolveAuxSocketDir(), "device-gesture-recording.sock");
  },
};

export const DEVICE_SNAPSHOT_SOCKET_CONFIG: SocketServerConfig = {
  get defaultPath() {
    return path.join(resolveAuxSocketDir(), "device-snapshot.sock");
  },
};

export const APPEARANCE_SOCKET_CONFIG: SocketServerConfig = {
  get defaultPath() {
    return path.join(resolveAuxSocketDir(), "appearance.sock");
  },
};

export const PERFORMANCE_STREAM_SOCKET_CONFIG: SocketServerConfig = {
  get defaultPath() {
    return path.join(resolveAuxSocketDir(), "performance-stream.sock");
  },
};

export const PERFORMANCE_PUSH_SOCKET_CONFIG: SocketServerConfig = {
  get defaultPath() {
    return path.join(resolveAuxSocketDir(), "performance-push.sock");
  },
};

export const DEVICE_DATA_STREAM_SOCKET_CONFIG: SocketServerConfig = {
  get defaultPath() {
    return path.join(resolveAuxSocketDir(), "observation-stream.sock");
  },
};

export const FAILURES_STREAM_SOCKET_CONFIG: SocketServerConfig = {
  get defaultPath() {
    return path.join(resolveAuxSocketDir(), "failures-stream.sock");
  },
};

export const FAILURES_PUSH_SOCKET_CONFIG: SocketServerConfig = {
  get defaultPath() {
    return path.join(resolveAuxSocketDir(), "failures-push.sock");
  },
};

export const TELEMETRY_PUSH_SOCKET_CONFIG: SocketServerConfig = {
  get defaultPath() {
    return path.join(resolveAuxSocketDir(), "telemetry-push.sock");
  },
};

export const WEBRTC_STREAM_SOCKET_CONFIG: SocketServerConfig = {
  get defaultPath() {
    return resolveWebRtcStreamSocketPath();
  },
};

export function resolveWebRtcStreamSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = readEnvRaw(ENV.WEBRTC_STREAM_SOCKET_PATH, env);
  return override
    ? resolvePathFromDaemonLaunchWorkingDirectory(override)
    : path.join(resolveAuxSocketDir(env), "webrtc-stream.sock");
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
  "device-gesture-recording": DEVICE_GESTURE_RECORDING_SOCKET_CONFIG,
  "video-recording": VIDEO_RECORDING_SOCKET_CONFIG,
  "video-stream": VIDEO_STREAM_SOCKET_CONFIG,
  "webrtc-stream": WEBRTC_STREAM_SOCKET_CONFIG,
};

export interface DaemonFileCleanupOptions {
  idGenerator?: IdGenerator;
  pidFilePath?: string;
  socketPaths?: string[];
  /** Bound socket identities, used to avoid unlinking a successor's replacement path. */
  socketFileIdentities?: ReadonlyMap<string, SocketFileIdentity>;
  controlSocketPath?: string;
  expectedPid?: number;
  /**
   * Whether this process actually acquired the daemon socket bind. When
   * explicitly `false`, ALL deletion is suppressed: the process holds an early
   * owner PID record (issue #2871) — so its own pid passes the `expectedPid`
   * self-check — yet it never owned the socket. A lock-less contender refused
   * over a live sibling (issue #6232) is exactly this case; letting its exit
   * cleanup unlink the shared socket/PID files would brick the live winner (the
   * #6140 failure mode, new variant). `undefined` preserves the legacy behavior
   * for callers that do not track socket ownership.
   */
  socketBindCommitted?: boolean;
}

export interface AtomicPidFileWriteDependencies {
  createTemporaryPath: (pidFilePath: string) => string;
  writeTemporaryFile: (
    temporaryPath: string,
    contents: string,
    signal?: AbortSignal,
  ) => Promise<void>;
  replaceFile: (temporaryPath: string, pidFilePath: string) => Promise<void>;
  removeTemporaryFile: (temporaryPath: string) => Promise<void>;
}

const defaultAtomicPidFileWriteDependencies: AtomicPidFileWriteDependencies = {
  createTemporaryPath: createPidFileTemporaryPath,
  writeTemporaryFile: async (temporaryPath, contents, signal) => {
    await writeFile(temporaryPath, contents, {
      encoding: "utf-8",
      mode: 0o600,
      signal,
    });
  },
  replaceFile: rename,
  removeTemporaryFile: unlink,
};

/**
 * Publish a complete PID record with a same-directory atomic replacement.
 * A per-process sequence prevents concurrent writes in this process from
 * sharing a temporary path; the PID prevents collisions with other processes.
 */
export async function writePidFileDataAtomic(
  pidFilePath: string,
  data: PidFileData,
  signal?: AbortSignal,
  dependencies: AtomicPidFileWriteDependencies = defaultAtomicPidFileWriteDependencies,
): Promise<void> {
  const temporaryPath = dependencies.createTemporaryPath(pidFilePath);
  try {
    await dependencies.writeTemporaryFile(temporaryPath, JSON.stringify(data, null, 2), signal);
    await dependencies.replaceFile(temporaryPath, pidFilePath);
  } catch (writeError) {
    try {
      await dependencies.removeTemporaryFile(temporaryPath);
    } catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new AggregateError(
          [writeError, cleanupError],
          `Failed to publish PID file ${pidFilePath} and remove its temporary file`,
        );
      }
    }
    throw writeError;
  }
}

/** Synchronous counterpart used by the lock-less incumbent restore path. */
export function writePidFileDataAtomicSync(
  pidFilePath: string,
  data: PidFileData,
  dependencies: AtomicPidFileWriteSyncDependencies = defaultAtomicPidFileWriteSyncDependencies,
): void {
  writeJsonFileAtomicSync(pidFilePath, data, dependencies);
}

/** Durable companion to a manager's launch-capture log. */
export function daemonLaunchLogOwnerTombstonePath(launchLogPath: string): string {
  return `${launchLogPath}.owner`;
}

/**
 * A launch log is a new file generation whenever its manager opens it with
 * truncation. Remove the previous generation's owner evidence first so a PID
 * reuse cannot make a later sweep treat that stale tombstone as an exact claim
 * for the newly-created file.
 */
export function clearDaemonLaunchLogOwnerTombstoneSync(launchLogPath: string): void {
  try {
    unlinkSync(daemonLaunchLogOwnerTombstonePath(launchLogPath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

/**
 * Preserve the exact launch-log association before deleting the PID record.
 * The PID record is deliberately transient liveness state, but its association
 * is also the conclusive evidence a later prune needs once shutdown has
 * completed. The write is replace-atomic so a concurrent sweep sees either the
 * old complete tombstone or the new complete tombstone, never partial JSON.
 */
function persistDaemonLaunchLogOwnerTombstoneSync(record: PidFileData | null): void {
  try {
    const owner = record && { pid: record.pid, launchLogPath: record.launchLogPath };
    if (
      !owner ||
      !Number.isInteger(owner.pid) ||
      owner.pid <= 0 ||
      typeof owner.launchLogPath !== "string" ||
      !path.isAbsolute(owner.launchLogPath)
    ) {
      return;
    }
    const tombstonePath = daemonLaunchLogOwnerTombstonePath(owner.launchLogPath);
    const temporaryPath = `${tombstonePath}.${process.pid}.tmp`;
    writeFileSync(temporaryPath, JSON.stringify(owner), { encoding: "utf-8", mode: 0o600 });
    renameSync(temporaryPath, tombstonePath);
  } catch (error) {
    // Cleanup still must remove a dead daemon's sockets/PID record. A failed
    // tombstone write only makes the next pruning sweep retain the launch log.
    logSafeDebug(`daemon launch-log owner tombstone write failed: ${error}`, error);
  }
}

/**
 * Read a durable exact owner declaration written at daemon shutdown. Absence
 * is conclusive only for this sidecar; malformed data is ambiguity and throws
 * so the log pruner fails closed.
 */
export function readDaemonLaunchLogOwnerTombstoneSync(
  launchLogPath: string,
): DaemonLaunchLogOwner | undefined {
  const tombstonePath = daemonLaunchLogOwnerTombstonePath(launchLogPath);
  if (!existsSync(tombstonePath)) {
    return undefined;
  }
  const owner = JSON.parse(readFileSync(tombstonePath, "utf-8")) as DaemonLaunchLogOwner;
  if (
    typeof owner?.pid !== "number" ||
    !Number.isInteger(owner.pid) ||
    owner.pid <= 0 ||
    typeof owner.launchLogPath !== "string" ||
    !path.isAbsolute(owner.launchLogPath) ||
    path.resolve(owner.launchLogPath) !== path.resolve(launchLogPath)
  ) {
    throw new Error(`Launch-log owner tombstone at ${tombstonePath} is invalid`);
  }
  return owner;
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

export interface DaemonCleanupFileSystem {
  exists: (path: string) => boolean;
  stat: (path: string) => SocketFileIdentity;
  unlink: (path: string) => Promise<void>;
  unlinkSync: (path: string) => void;
  renameSync: (from: string, to: string) => void;
  linkSync: (from: string, to: string) => void;
  copyFileExclusiveSync: (from: string, to: string) => void;
  readPid: typeof readPidFileDataSync;
  persistOwner: typeof persistDaemonLaunchLogOwnerTombstoneSync;
}

const cleanupFileSystem: DaemonCleanupFileSystem = {
  exists: existsSync,
  stat: statFileIdentity,
  unlink: (path) => unlink(path),
  unlinkSync: (path) => unlinkSync(path),
  renameSync,
  linkSync,
  copyFileExclusiveSync: (from, to) => copyFileSync(from, to, fsConstants.COPYFILE_EXCL),
  readPid: readPidFileDataSync,
  persistOwner: persistDaemonLaunchLogOwnerTombstoneSync,
};

function stillOwnsSocketFile(
  socketPath: string,
  identities: DaemonFileCleanupOptions["socketFileIdentities"],
  files: DaemonCleanupFileSystem,
): boolean {
  const identity = identities?.get(socketPath);
  if (!identity) {
    return true;
  }
  try {
    return sameFileIdentity(files.stat(socketPath), identity);
  } catch (error) {
    // A vanished or unreadable path is not safe to unlink during shutdown.
    logger.warn(`daemon socket ownership check failed for ${socketPath}: ${error}`, error);
    return false;
  }
}

function ownedSocketExists(
  socketPath: string,
  options: DaemonFileCleanupOptions,
  files: DaemonCleanupFileSystem,
): boolean {
  return (
    files.exists(socketPath) && stillOwnsSocketFile(socketPath, options.socketFileIdentities, files)
  );
}

function retainedControlSocket(
  socketPath: string,
  options: DaemonFileCleanupOptions,
  files: DaemonCleanupFileSystem,
): boolean {
  const retained =
    socketPath === (options.controlSocketPath ?? SOCKET_PATH) &&
    ownedSocketExists(socketPath, options, files);
  if (retained) {
    logger.warn(`Keeping daemon PID file because control socket remains at ${socketPath}`);
  }
  return retained;
}

async function cleanupSocketFiles(
  socketPaths: string[],
  options: DaemonFileCleanupOptions,
  files: DaemonCleanupFileSystem,
): Promise<boolean> {
  let controlUnlinkFailed = false;
  for (const socketPath of socketPaths) {
    if (!ownedSocketExists(socketPath, options, files)) {
      continue;
    }
    try {
      await files.unlink(socketPath);
    } catch (error) {
      controlUnlinkFailed =
        retainedControlSocket(socketPath, options, files) || controlUnlinkFailed;
      // Cleanup is best effort so a stale path cannot abort shutdown/startup.
      logger.warn(`Could not remove daemon socket ${socketPath}: ${error}`, error);
    }
  }

  return !controlUnlinkFailed;
}

function cleanupSocketFilesSync(
  socketPaths: string[],
  options: DaemonFileCleanupOptions,
  files: DaemonCleanupFileSystem,
): boolean {
  let controlUnlinkFailed = false;
  for (const socketPath of socketPaths) {
    if (!ownedSocketExists(socketPath, options, files)) {
      continue;
    }
    try {
      files.unlinkSync(socketPath);
    } catch (error) {
      controlUnlinkFailed =
        retainedControlSocket(socketPath, options, files) || controlUnlinkFailed;
      // Cleanup is best effort so a stale path cannot abort shutdown/startup.
      logger.warn(`Could not remove daemon socket ${socketPath}: ${error}`, error);
    }
  }

  return !controlUnlinkFailed;
}

function prepareOwnedPidUnlink(
  pidFilePath: string,
  expectedPid: number | undefined,
  files: DaemonCleanupFileSystem,
): PidFileData | null | false {
  const owner = files.readPid(pidFilePath);
  if (expectedPid !== undefined && owner?.pid !== expectedPid) {
    return false;
  }
  files.persistOwner(owner);
  return shouldCleanupForExpectedPid(pidFilePath, expectedPid, files.readPid) ? owner : false;
}

function cleanupPidFile(
  pidFilePath: string,
  options: DaemonFileCleanupOptions,
  files: DaemonCleanupFileSystem,
): boolean {
  if (!files.exists(pidFilePath)) {
    return true;
  }
  try {
    const owner = prepareOwnedPidUnlink(pidFilePath, options.expectedPid, files);
    if (owner === false) {
      return false;
    }
    // PID metadata is small and already read synchronously. Share the complete
    // claim/verify/restore sequence between async shutdown and synchronous exit.
    return removeOwnedFileSync(
      pidFilePath,
      (claimedPath) => JSON.stringify(files.readPid(claimedPath)) === JSON.stringify(owner),
      {
        rename: (from, to) => files.renameSync(from, to),
        link: (from, to) => files.linkSync(from, to),
        copyExclusive: (from, to) => files.copyFileExclusiveSync(from, to),
        remove: (path) => files.unlinkSync(path),
      },
      options.idGenerator,
    );
  } catch (error) {
    if (error instanceof OwnedRecordRestoreError) {
      logger.warn(`Could not restore successor daemon PID file ${pidFilePath}`, error);
      return false;
    }
    // Preserve the existing best-effort cleanup return contract on I/O failure.
    logger.warn(`Could not remove daemon PID file ${pidFilePath}`, error);
    return true;
  }
}

export async function cleanupDaemonFiles(
  options: DaemonFileCleanupOptions = {},
  files: DaemonCleanupFileSystem = cleanupFileSystem,
): Promise<boolean> {
  const pidFilePath = options.pidFilePath ?? PID_FILE_PATH;
  const socketPaths = options.socketPaths ?? getDaemonSocketPathList();

  if (options.socketBindCommitted === false) {
    return false;
  }

  if (!shouldCleanupForExpectedPid(pidFilePath, options.expectedPid, files.readPid)) {
    return false;
  }

  const controlRemoved = await cleanupSocketFiles(socketPaths, options, files);

  if (!controlRemoved) {
    return false;
  }
  return cleanupPidFile(pidFilePath, options, files);
}

export function cleanupDaemonFilesSync(
  options: DaemonFileCleanupOptions = {},
  files: DaemonCleanupFileSystem = cleanupFileSystem,
): boolean {
  const pidFilePath = options.pidFilePath ?? PID_FILE_PATH;
  const socketPaths = options.socketPaths ?? getDaemonSocketPathList();

  if (options.socketBindCommitted === false) {
    return false;
  }

  if (!shouldCleanupForExpectedPid(pidFilePath, options.expectedPid, files.readPid)) {
    return false;
  }

  const controlRemoved = cleanupSocketFilesSync(socketPaths, options, files);

  if (!controlRemoved) {
    return false;
  }
  return cleanupPidFile(pidFilePath, options, files);
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
 * A single-directory scan can NEVER prove it discovered every namespace that
 * could share this log directory — `AUTOMOBILE_LOG_DIR` and
 * `AUTOMOBILE_DAEMON_PID_FILE_PATH` are independent overrides
 * (`src/daemon/wire/constants.ts:119-123`), so a peer can leave the log directory at
 * its default (making it discoverable-looking) while relocating ONLY its pid
 * file to an arbitrary directory this scan never visits (e.g. `/state/a/daemon.pid`).
 * That combination is invisible to a directory listing regardless of whether
 * `pidFilePath` itself is the default location or a custom one — an
 * unreadable pid-file directory is a second, narrower way discovery can fail.
 * `uncertain` is therefore ALWAYS set so every caller — default namespace
 * included — fails closed (retains launch logs) rather than assuming
 * exhaustiveness it cannot prove (issue #6194). `pidFiles` is still returned
 * and still checked for liveness first: a genuinely discovered live peer is
 * caught immediately, and `uncertain` only decides the residual "found nothing
 * alive" case.
 *
 * Deduplicated, and always includes `pidFilePath` so the caller never loses its
 * own-namespace check.
 */
export function listDaemonPidFilesSync(
  pidFilePath: string = PID_FILE_PATH,
): DaemonPidFileEnumeration {
  const dir = path.dirname(pidFilePath);
  const found = new Set<string>([pidFilePath]);
  // A directory-listing scan can never prove it enumerated every namespace
  // sharing this log directory (see docstring) — always uncertain, regardless
  // of whether `pidFilePath` is the default location or a custom one.
  const uncertain = true;
  try {
    for (const entry of sortedReaddirSync(dir)) {
      if (entry.startsWith(DAEMON_PID_FILE_BASENAME_PREFIX) && entry.endsWith(".pid")) {
        found.add(path.join(dir, entry));
      }
    }
  } catch (error) {
    // The pid-file directory could not be read either, so not even the
    // co-located siblings could be enumerated this time.
    logSafeDebug(`src/daemon/daemonFiles.ts pidfile dir scan failed: ${error}`, error);
  }
  return { pidFiles: [...found], uncertain };
}

/**
 * Enumerate daemon PID files for the startup peer-liveness gate from both the
 * current namespace's directory and the built-in/default namespace directory.
 *
 * PID-path isolation and DB-path isolation are independent: `constants.ts`
 * resolves `AUTOMOBILE_DAEMON_PID_FILE_PATH`, while
 * `database.ts#resolveDatabasePathFromEnvironment` separately resolves
 * `AUTOMOBILE_DB_PATH`/`AUTOMOBILE_DB_DIR`. `scripts/benchmark-startup.sh` is a
 * shipped example that changes the PID/socket paths without changing the DB.
 * Including `defaultPidFilePath` therefore prevents a custom-location daemon
 * from losing a default-location peer (and preserves the existing co-located
 * scan of the caller's own directory).
 *
 * The default PID directory (`/tmp`) is world-shared on a multi-user host, so
 * it is NEVER wildcard-scanned here: a prefix-only filename match there would
 * enumerate (and then attempt to read) another uid's
 * `auto-mobile-daemon-<otheruid>.pid` (mode 0o600). That file legitimately
 * throws `EACCES` on read, and `collectLiveDaemonSessionIds` now (correctly)
 * treats a non-ENOENT read failure on a discovered path as ambiguous-but-live
 * and throws -- so a wildcard scan here would make every daemon startup on a
 * shared host fatal because of a stale FOREIGN pid file it has no business
 * reading. `defaultPidFilePath` is already computed as this uid's own exact
 * filename (`DEFAULT_PID_FILE_PATH` in `constants.ts`), so simply including
 * that literal path below is the entire extent of default-directory discovery:
 * no directory listing of `/tmp` is ever performed.
 *
 * The caller's own explicitly-configured PID directory (`pidFilePath`'s
 * directory) IS scanned in full by prefix, as before: it is a location this
 * same principal chose, not a directory shared with other login users. When
 * that directory IS the default directory (an `AUTOMOBILE_AUX_SOCKET_DIR`
 * daemon's suffixed PID file, #10881), the scan is narrowed to this uid's own
 * filenames so the invariant above still holds (#10906).
 *
 * This deliberately does not claim to enumerate arbitrary third directories:
 * no process-local filesystem scan can discover an unconstrained custom path.
 * Supporting that topology completely requires a central namespace registry or
 * an explicit configured directory list; recursively scanning the filesystem is
 * neither bounded nor reliable. Unlike log retention, startup cannot simply
 * fail on that ever-present theoretical uncertainty without making every daemon
 * startup fatal, so this is the bounded mitigation for known/default peers.
 *
 * An unreadable existing directory throws rather than degrading to "no live
 * peers". An absent directory is confidently empty and is safe to skip.
 */
export function listDaemonPidFilePathsOrThrow(
  pidFilePath: string = PID_FILE_PATH,
  defaultPidFilePath: string = DEFAULT_PID_FILE_PATH,
  listDirectory: (dir: string) => string[] = readPidDirectoryEntriesOrThrow,
): string[] {
  const found = new Set<string>([pidFilePath, defaultPidFilePath]);
  const customDir = path.dirname(pidFilePath);
  const isPeerEntry =
    path.resolve(customDir) === path.resolve(path.dirname(defaultPidFilePath))
      ? ownUidDefaultDirPidEntryMatcher(path.basename(defaultPidFilePath))
      : isDaemonPidFileEntry;
  for (const entry of listDirectory(customDir)) {
    if (isPeerEntry(entry)) {
      found.add(path.join(customDir, entry));
    }
  }
  return [...found];
}

function isDaemonPidFileEntry(entry: string): boolean {
  return entry.startsWith(DAEMON_PID_FILE_BASENAME_PREFIX) && entry.endsWith(".pid");
}

/**
 * The isolated PID file of an `AUTOMOBILE_AUX_SOCKET_DIR` daemon lives in the
 * shared default directory (`/tmp/auto-mobile-daemon-<uid>-<hash>.pid`, #10881),
 * so its "own directory" scan would otherwise be the forbidden wildcard scan of
 * `/tmp` described above (#10906). There, only this uid's own names match: the
 * exact default basename or `<default stem>-*.pid`. The `-` separator keeps uid
 * 50 from matching uid 501's `auto-mobile-daemon-501.pid`.
 */
function ownUidDefaultDirPidEntryMatcher(defaultBasename: string): (entry: string) => boolean {
  const ownSuffixedPrefix = `${defaultBasename.replace(/\.pid$/, "")}-`;
  return (entry) =>
    entry === defaultBasename || (entry.startsWith(ownSuffixedPrefix) && entry.endsWith(".pid"));
}

function readPidDirectoryEntriesOrThrow(dir: string): string[] {
  let entries: string[] = [];
  try {
    entries = sortedReaddirSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    // An absent directory is expected before this namespace has ever started.
    logSafeDebug(`src/daemon/daemonFiles.ts pidfile dir does not exist: ${error}`, error);
  }
  return entries;
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

export interface LiveDaemonSessionIdProvider {
  collectLiveDaemonSessionIds(): ReadonlySet<string>;
}

export type LiveDaemonPidFileRead = { status: "absent" } | { status: "present"; data: unknown };

/**
 * Read a PID record for the startup liveness gate without collapsing a present
 * but unreadable/malformed record into absence. Only ENOENT is a confident
 * absence; every other read/parse failure propagates so startup fails closed.
 */
export function readLiveDaemonPidFileSync(
  pidFilePath: string = PID_FILE_PATH,
): LiveDaemonPidFileRead {
  let contents: string | undefined;
  try {
    contents = readFileSync(pidFilePath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    // PID files legitimately disappear during peer shutdown; ENOENT proves
    // there is no record at this path to protect.
    logSafeDebug(`src/daemon/daemonFiles.ts live pidfile does not exist: ${error}`, error);
  }
  return contents === undefined
    ? { status: "absent" }
    : { status: "present", data: JSON.parse(contents) as unknown };
}

export interface PidFileLiveDaemonSessionIdProviderDependencies {
  listDaemonPidFiles?: (pidFilePath?: string) => string[];
  readPidFile?: (pidFilePath?: string) => LiveDaemonPidFileRead;
  isProcessRunning?: (pid: number) => boolean;
  readProcessGenerationToken?: (pid: number) => string | undefined;
}

/**
 * Whether a PID record names a process generation that has DEFINITELY exited
 * while its PID is now held by another process. Only a recorded
 * process generation token (either record field) that differs from a token actually read from the live
 * PID is proof. Every uncertain input (no recorded token, no readable live
 * token, a reader failure, a record carrying only a wall-clock birth time)
 * returns false so the caller keeps treating the PID as the recorded process;
 * this never decides "dead" on a guess. Tokens from different schemes (for
 * example a record written by an older build) are not comparable and so are
 * never proof either. Shared by peer-liveness discovery, the
 * daemon manager's start/stop bookkeeping and the bind guard's incumbent check
 * (issue #10108).
 */
export function isConfirmedRecycledProcess(
  pid: number,
  record: { processGenerationToken?: unknown; processGenerationTokenUtc?: unknown },
  readProcessGenerationToken: (pid: number) => string | undefined,
  source: string,
): boolean {
  const recordedToken = recordedProcessGenerationToken(record);
  if (recordedToken === undefined) {
    // Fully legacy or birth-time-only records have no opaque token to compare
    // (the direct cross-platform PID probes expose only opaque tokens), so
    // uncertainty must preserve the recorded process as live.
    return false;
  }
  try {
    const currentToken = readProcessGenerationToken(pid);
    return (
      typeof currentToken === "string" &&
      compareProcessGenerationTokens(recordedToken, currentToken) === "different"
    );
  } catch (error) {
    logger.warn(
      `Failed to read process generation token for live PID ${pid} from ${source}: ${error}`,
      error,
    );
    // The reader failure leaves ownership uncertain, so preserve the process.
    return false;
  }
}

/**
 * A live peer is safe to preempt only when its release is confidently older.
 * Missing or non-numeric versions fail closed to preserving the peer.
 */
export function shouldProtectLiveDaemonVersion(
  peerVersion: unknown,
  currentDaemonVersion: string,
): boolean {
  if (typeof peerVersion !== "string") {
    return true;
  }
  const comparison = compareStrictNumericVersions(
    releaseVersion(peerVersion.trim()),
    releaseVersion(currentDaemonVersion.trim()),
  );
  return !Number.isFinite(comparison) || comparison >= 0;
}

/**
 * Discovers daemon-session owners whose PID records still name a live process.
 *
 * The current daemon is intentionally included when its record is discovered;
 * the repository independently excludes its session ID from stale-session
 * cleanup. Every live peer WITH a `daemonSessionId` is protected unless its
 * current OS birth identity definitely differs from the recorded identity.
 * A live peer WITHOUT one is a pre-PA2 legacy record (see
 * `daemonSessionId`'s doc comment in `types.ts`) -- there is no session id to
 * protect, so it is logged and skipped rather than treated as ambiguous.
 * Directory discovery and any other read/parse failure on this uid's own
 * pid file still throw on ambiguity, so startup cannot mistake genuine local
 * damage (an unreadable peer namespace, corrupt JSON) for an empty live set.
 */
export class PidFileLiveDaemonSessionIdProvider implements LiveDaemonSessionIdProvider {
  private readonly listDaemonPidFiles: (pidFilePath?: string) => string[];
  private readonly readPidFile: (pidFilePath?: string) => LiveDaemonPidFileRead;
  private readonly processIsRunning: (pid: number) => boolean;
  private readonly readProcessGenerationToken: (pid: number) => string | undefined;

  constructor(dependencies: PidFileLiveDaemonSessionIdProviderDependencies = {}) {
    this.listDaemonPidFiles = dependencies.listDaemonPidFiles ?? listDaemonPidFilePathsOrThrow;
    this.readPidFile = dependencies.readPidFile ?? readLiveDaemonPidFileSync;
    this.processIsRunning =
      dependencies.isProcessRunning ?? ((pid) => isProcessRunning(pid, { debugLog: logSafeDebug }));
    this.readProcessGenerationToken =
      dependencies.readProcessGenerationToken ?? readProcessGenerationTokenForPid;
  }

  private isConfirmedRecycledProcess(
    pid: number,
    pidData: Record<string, unknown>,
    pidFile: string,
  ): boolean {
    return isConfirmedRecycledProcess(pid, pidData, this.readProcessGenerationToken, pidFile);
  }

  collectLiveDaemonSessionIds(): ReadonlySet<string> {
    const liveDaemonSessionIds = new Set<string>();
    const pidFiles = this.listDaemonPidFiles();
    for (const pidFile of pidFiles) {
      const read = this.readPidFile(pidFile);
      if (read.status === "absent") {
        continue;
      }
      if (typeof read.data !== "object" || read.data === null) {
        throw new Error(`Pid file at ${pidFile} is present but is not a JSON object`);
      }
      const pidData = read.data as Record<string, unknown>;
      const pid = pidData.pid;
      if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
        throw new Error(`Pid file at ${pidFile} is present but does not contain a valid pid`);
      }
      if (!this.processIsRunning(pid)) {
        continue;
      }
      const daemonSessionId = pidData.daemonSessionId;
      if (typeof daemonSessionId !== "string" || daemonSessionId.length === 0) {
        // `daemonSessionId` is documented optional (`types.ts`) for PID files
        // written before peer-liveness discovery shipped. A pre-PA2 live
        // daemon has no session id to add to the protected set either way, so
        // throwing here protects nothing while making a newer daemon
        // unstartable alongside a legacy one it should be able to supersede
        // -- log and skip this record instead of failing startup closed.
        logger.warn(
          `Pid file at ${pidFile} names live process ${pid} but has no daemon session id; ` +
            "treating it as a pre-liveness-discovery legacy record",
        );
        continue;
      }
      if (this.isConfirmedRecycledProcess(pid, pidData, pidFile)) {
        continue;
      }
      liveDaemonSessionIds.add(daemonSessionId);
    }
    return liveDaemonSessionIds;
  }
}

/**
 * Read the daemon owner declaration for a launch-log RETENTION decision, distinguishing
 * a CONFIDENTLY-absent pid file (returns `undefined` — no daemon recorded in that
 * namespace) from a present-but-unreadable/malformed/schema-invalid one (THROWS
 * — ambiguous).
 *
 * The pruner treats a throw as "a live daemon may still own this launch log" and
 * retains it, so an unreadable OR schema-invalid pid file must NOT be swallowed
 * to `undefined`/an unusable value the way {@link readPidFileDataSync} does —
 * that would let a stale launch log be pruned while a live daemon still holds
 * the inherited fd (issue #6194). A present record whose `pid` field is not a
 * positive integer (missing, non-numeric, `0`, negative, or non-finite) is just
 * as ambiguous as a JSON syntax error: it is neither a confidently-absent file
 * nor a usable pid, so it throws rather than returning it as-is. No logger
 * reference, so it is safe to call during the cyclic logger import.
 */
export function readDaemonOwnerForRetentionSync(
  pidFilePath: string = PID_FILE_PATH,
): DaemonLaunchLogOwner | undefined {
  if (!existsSync(pidFilePath)) {
    return undefined;
  }
  // A read/parse failure propagates on purpose: an existing but unreadable pid
  // file is ambiguous, and the pruner must fail closed (retain) on ambiguity.
  const data = JSON.parse(readFileSync(pidFilePath, "utf-8")) as PidFileData;
  const pid = data?.pid;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    // A present but schema-invalid record (e.g. `{}`, `{"pid":"123"}`) is
    // ambiguous, not confidently absent — throw so the caller retains rather
    // than silently treating this namespace as dead.
    throw new Error(`Pid file at ${pidFilePath} is present but does not contain a valid pid`);
  }
  return { pid, launchLogPath: data.launchLogPath };
}

export { isProcessRunning } from "../utils/processLiveness";

function shouldCleanupForExpectedPid(
  pidFilePath: string,
  expectedPid: number | undefined,
  readPid: typeof readPidFileDataSync,
): boolean {
  if (expectedPid === undefined) {
    return true;
  }
  const pidData = readPid(pidFilePath);
  return pidData?.pid === expectedPid;
}
