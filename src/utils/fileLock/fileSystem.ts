import { type LockFileStat, type LockFileSystem, nodeLockFileSystem } from "../lockFileSystem";
import {
  type Steps,
  OWN_TMP_SWEEP_INTERVAL_MS,
  OWN_TMP_SWEEP_DIRECTORY_LIMIT,
  OWN_TMP_SWEEP_CANDIDATE_LIMIT,
  type ExclusiveLockOptions,
  OWN_TMP_SWEEP_LIMIT,
  RECLAIM_GUARD_ABANDON_AGE_MS,
  type LockSample,
  sameSample,
  type LockStep,
  BACK_OUT_RETRY_LIMIT,
} from "./contracts";
import { ownTmpSweeps, lockState } from "./state";
import { logger } from "../logger";
import { errorMessage } from "../describeUnknownError";
import { dirname, basename } from "path";
import { defaultIdGenerator, type IdGenerator } from "../IdGenerator";
import { toActionableError } from "../../models/ActionableError";

// Parse from the end: a guard prefix's fractional mtime may itself contain dots.
const publicationName = /^.+\.(\d+)\.\d+\.[^.]+\.tmp$/;

function* ownPublicationTmpCandidates(
  directory: string,
  prefix: string,
  pid: string,
  fileSystem: LockFileSystem,
  now: number,
): Steps<string[]> {
  const key = `${pid}:${directory}`;
  let directories = ownTmpSweeps.get(fileSystem);
  if (!directories) {
    directories = new Map();
    ownTmpSweeps.set(fileSystem, directories);
  }
  let entry = directories.get(key);
  if (!entry || now - entry.listedAt >= OWN_TMP_SWEEP_INTERVAL_MS || now < entry.listedAt) {
    if (!entry && directories.size >= OWN_TMP_SWEEP_DIRECTORY_LIMIT) {
      const oldest = directories.keys().next().value;
      if (oldest !== undefined) {
        directories.delete(oldest);
      }
    }
    entry = { listedAt: now, candidates: [] };
    directories.set(key, entry);
    try {
      yield { op: "list", path: directory };
      const names = fileSystem
        .list(directory)
        .sort()
        .filter((name) => publicationName.exec(name)?.[1] === pid);
      entry.candidates = [
        ...names.filter((name) => name.startsWith(prefix)),
        ...names.filter((name) => !name.startsWith(prefix)),
      ].slice(0, OWN_TMP_SWEEP_CANDIDATE_LIMIT);
    } catch (error) {
      // Optional litter cleanup can be skipped safely when the directory is missing/unreadable.
      logger.debug(`Lock tmp listing unavailable at ${directory}: ${errorMessage(error)}`, error);
    }
  }
  return entry.candidates;
}

export function* sweepOwnPublicationTmps(path: string, options: ExclusiveLockOptions): Steps<void> {
  const fileSystem = options.fileSystem ?? nodeLockFileSystem;
  const directory = dirname(path);
  const pid = String(options.pid ?? process.pid);
  const prefix = `${basename(path)}.`;
  const candidates = yield* ownPublicationTmpCandidates(
    directory,
    prefix,
    pid,
    fileSystem,
    (options.now ?? Date.now)(),
  );
  let attempts = 0;
  // Walk a bounded snapshot so interleaved removals cannot skip a shifted candidate.
  for (const name of [...candidates]) {
    if (!name.startsWith(prefix) || publicationName.exec(name)?.[1] !== pid) {
      continue;
    }
    const tmp = path.slice(0, path.length - basename(path).length) + name;
    const abandoned = yield* isAbandonedPublicationTmp(tmp, options);
    if (abandoned === false) {
      continue;
    }
    const index = candidates.indexOf(name);
    if (index === -1) {
      continue;
    }
    candidates.splice(index, 1);
    if (abandoned === undefined) {
      continue;
    }
    yield* cleanupFile(tmp, fileSystem);
    if (++attempts === OWN_TMP_SWEEP_LIMIT) {
      break;
    }
  }
}

function* isAbandonedPublicationTmp(
  path: string,
  options: ExclusiveLockOptions,
): Steps<boolean | undefined> {
  try {
    yield { op: "stat", path };
    const { mtimeMs } = (options.fileSystem ?? nodeLockFileSystem).stat(path);
    return (options.now ?? Date.now)() - mtimeMs > RECLAIM_GUARD_ABANDON_AGE_MS;
  } catch (error) {
    // A vanished/unreadable tmp can be left safely; publication never depends on cleanup.
    logger.debug(`Lock tmp age unavailable at ${path}: ${errorMessage(error)}`, error);
    return undefined;
  }
}

export function* sampleLock(
  path: string,
  fileSystem: LockFileSystem,
): Steps<LockSample | undefined> {
  try {
    yield { op: "stat", path };
    const { ino, mtimeMs } = fileSystem.stat(path);
    yield { op: "readText", path };
    const raw = fileSystem.readText(path);
    return { ino, mtimeMs, raw };
  } catch (error) {
    // Missing/unreadable samples cannot prove staleness; backing off retains ownership.
    logger.debug(`Lock sample failed at ${path}: ${errorMessage(error)}`, error);
    return undefined;
  }
}

export function* readText(path: string, fileSystem: LockFileSystem): Steps<string | undefined> {
  try {
    yield { op: "readText", path };
    return fileSystem.readText(path);
  } catch (error) {
    // A vanished/unreadable file proves no ownership; callers conservatively back off.
    logger.debug(`Lock read failed at ${path}: ${errorMessage(error)}`, error);
    return undefined;
  }
}

export function* claimLockMarker(
  path: string,
  marker: string,
  fileSystem: LockFileSystem,
  warnOnFailure = false,
): Steps<boolean> {
  try {
    yield { op: "rename", path };
    fileSystem.rename(path, marker);
    return true;
  } catch (error) {
    if (warnOnFailure && (error as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.warn(`Lock rename failed at ${path}: ${errorMessage(error)}`, error);
    } else {
      // A concurrent release may have removed the instance; a failed claim means retrying.
      logger.debug(`Lock rename failed at ${path}: ${errorMessage(error)}`, error);
    }
    return false;
  }
}

export function* installGuard(
  path: string,
  content: string,
  options: ExclusiveLockOptions,
): Steps<boolean> {
  const fileSystem = options.fileSystem ?? nodeLockFileSystem;
  const pid = options.pid ?? process.pid;
  const idGenerator = options.idGenerator ?? defaultIdGenerator;
  const tmp = `${path}.${pid}.${++lockState.publicationCounter}.${idGenerator.next()}.tmp`;
  try {
    yield* cleanupFile(tmp, fileSystem);
    yield { op: "writeFile", path: tmp };
    fileSystem.writeFile(tmp, content);
    yield { op: "rename", path: tmp };
    fileSystem.rename(tmp, path);
    return true;
  } catch (error) {
    logger.warn(`Reclaim guard install failed at ${path}: ${errorMessage(error)}`, error);
    return false;
  } finally {
    yield* cleanupFile(tmp, fileSystem);
  }
}

/**
 * F = P.displaced remains authoritative until owner release or guarded reclaim.
 * COMPLETE only links F to P; it never removes F or copies sampled bytes.
 * R2 remains only while a lock is at a private in-flight marker: a third publisher
 * can win, or owner release can miss it before the displacer restores/retains it.
 */
export function* restoreDisplacedLock(
  path: string,
  marker: string,
  fileSystem: LockFileSystem,
): Steps<void> {
  // An exclusive hard link restores only into a free path, never over a fresh owner.
  try {
    yield { op: "link", path };
    fileSystem.link(marker, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      // EEXIST proves occupation even if the destination subsequently disappears.
      logger.debug(`Lock restore destination occupied at ${path}: ${errorMessage(error)}`);
    } else {
      logger.warn(`Displaced lock link restore failed at ${path}: ${errorMessage(error)}`, error);
      if (!(yield* copyDisplacedLock(path, marker, fileSystem))) {
        yield* retainDisplacedLock(path, marker, fileSystem);
        return;
      }
    }
  }
  yield* cleanupFile(marker, fileSystem);
}

function* copyDisplacedLock(
  path: string,
  marker: string,
  fileSystem: LockFileSystem,
): Steps<boolean> {
  const raw = yield* readText(marker, fileSystem);
  if (raw === undefined) {
    logger.warn(`Displaced lock exclusive copy could not read ${marker}`);
    return false;
  }
  const result = yield* createLegacyFile(path, raw, fileSystem, "Displaced lock exclusive copy");
  return result !== "failed";
}

export function* sampleRetainedLock(
  path: string,
  fileSystem: LockFileSystem,
): Steps<LockSample | "absent" | "unreadable"> {
  let identity: LockFileStat;
  try {
    yield { op: "stat", path };
    identity = fileSystem.stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      // Absence is the normal uncontended path; no retained owner needs arbitration.
      logger.debug(`Retained lock absent at ${path}: ${errorMessage(error)}`);
      return "absent";
    }
    logger.warn(`Retained lock stat failed at ${path}: ${errorMessage(error)}`, error);
    return "unreadable";
  }
  const raw = yield* readText(path, fileSystem);
  return raw === undefined ? "unreadable" : { ...identity, raw };
}

export function* retainDisplacedLock(
  path: string,
  marker: string,
  fileSystem: LockFileSystem,
): Steps<void> {
  const retained = `${path}.displaced`;
  const sample = yield* sampleRetainedLock(retained, fileSystem);
  if (sample === "absent") {
    try {
      yield { op: "rename", path: marker };
      fileSystem.rename(marker, retained);
      logger.warn(
        `Displaced lock restore failed at ${path}; retained at ${retained}; lock state is held-unknown`,
      );
    } catch (error) {
      logger.warn(
        `Displaced lock retention failed at ${path}; retaining ${marker}: ${errorMessage(error)}`,
        error,
      );
    }
    return;
  }
  if (sample !== "unreadable" && sameSample(yield* sampleLock(marker, fileSystem), sample)) {
    yield* cleanupFile(marker, fileSystem);
    return;
  }
  logger.warn(
    `Displaced lock retention blocked at ${retained}; retaining ${marker}; lock state is held-unknown`,
  );
}

export function* samplePublication(
  tmp: string,
  raw: string,
  fileSystem: LockFileSystem,
): Steps<LockSample | undefined> {
  try {
    yield { op: "stat", path: tmp };
    return { ...fileSystem.stat(tmp), raw };
  } catch (error) {
    // Without proof of this inode, F may be an older genuine hold and must be preserved.
    logger.debug(`Lock publication identity unavailable at ${tmp}: ${errorMessage(error)}`, error);
    return undefined;
  }
}

export function* completeRetainedLock(path: string, fileSystem: LockFileSystem): Steps<void> {
  try {
    yield { op: "link", path };
    fileSystem.link(`${path}.displaced`, path);
  } catch (error) {
    // Occupation, owner release or unavailable links safely leave F authoritative.
    logger.debug(`Retained lock completion skipped at ${path}: ${errorMessage(error)}`, error);
  }
}

export function* cleanupFile(path: string, fileSystem: LockFileSystem): Steps<void> {
  try {
    yield { op: "unlink", path };
    fileSystem.unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      // Missing tmp/guard/marker is already clean.
      logger.debug(`Lock cleanup already complete at ${path}: ${errorMessage(error)}`);
    } else {
      logger.warn(`Lock cleanup failed at ${path}: ${errorMessage(error)}`, error);
    }
  }
}

export function* removeStaleLockMarker(path: string, fileSystem: LockFileSystem): Steps<void> {
  try {
    yield { op: "unlink", path };
    fileSystem.unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw toActionableError(error, `Failed to remove stale lock marker at ${path}`);
    }
    // Another cleanup already removed this stale instance; exclusive publication still arbitrates.
    logger.debug(`Stale marker already removed at ${path}: ${errorMessage(error)}`);
  }
}

// Immediate retries share the back-out/release seam; ENOENT needs no retry or warning.
export function* retryLockStep<T>(
  step: LockStep,
  operation: () => T,
): Steps<{ value: T } | "missing" | "failed"> {
  for (let attempt = 0; attempt < BACK_OUT_RETRY_LIMIT; attempt++) {
    try {
      yield step;
      return { value: operation() };
    } catch (error) {
      // Missing is complete; other failures may be transient and are reported by the caller if exhausted.
      logger.debug(`Lock ${step.op} attempt failed at ${step.path}: ${errorMessage(error)}`, error);
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return "missing";
      }
    }
  }
  return "failed";
}

export function* readReleaseResult(path: string, fileSystem: LockFileSystem) {
  const result = yield* retryLockStep({ op: "readText", path }, () => fileSystem.readText(path));
  if (result === "failed") {
    logger.warn(`Lock release read failed at ${path}; lock left in place`, result);
  }
  return result;
}

export function* readReleasePath(
  path: string,
  fileSystem: LockFileSystem,
): Steps<string | undefined> {
  const result = yield* readReleaseResult(path, fileSystem);
  return typeof result === "string" ? undefined : result.value;
}

export function* claimReleasePath(
  path: string,
  marker: string,
  fileSystem: LockFileSystem,
): Steps<boolean> {
  const result = yield* retryLockStep({ op: "rename", path }, () =>
    fileSystem.rename(path, marker),
  );
  if (result === "failed") {
    logger.warn(`Lock release claim failed at ${path}; lock left in place`, result);
  }
  return typeof result !== "string";
}

type Publication = "created" | "contended" | { error: unknown };

/** One publication protocol for locks and guards: complete private bytes, then exclusive link. */
export function* publishFile(
  path: string,
  content: string,
  pid: number,
  fileSystem: LockFileSystem,
  options: {
    idGenerator?: IdGenerator;
    /** Runs after the exclusive link, while the private temp name still exists. */
    postPublish?: (tmp: string) => Steps<void>;
  } = {},
): Steps<Publication> {
  const { idGenerator = defaultIdGenerator, postPublish } = options;
  const tmp = `${path}.${pid}.${++lockState.publicationCounter}.${idGenerator.next()}.tmp`;
  let linking = false;
  try {
    try {
      // A recycled name may still alias a live lock inode; unlink before exclusive create.
      yield* cleanupFile(tmp, fileSystem);
      yield { op: "writeFile", path: tmp };
      fileSystem.writeFile(tmp, content);
      yield { op: "link", path };
      linking = true;
      fileSystem.link(tmp, path);
    } catch (error) {
      if (linking && (error as NodeJS.ErrnoException).code === "EEXIST") {
        // Exclusive link contention is expected and never overwrites an owner.
        logger.debug(`Lock publication contended at ${path}: ${errorMessage(error)}`);
        return "contended";
      }
      logger.warn(`Atomic lock publication failed at ${path}: ${errorMessage(error)}`, error);
      return { error };
    }
    if (postPublish) {
      yield* postPublish(tmp);
    }
    return "created";
  } finally {
    yield* cleanupFile(tmp, fileSystem);
  }
}

export function* publishReclaimGuard(
  path: string,
  content: string,
  pid: number,
  fileSystem: LockFileSystem,
  idGenerator: IdGenerator = defaultIdGenerator,
): Steps<"created" | "contended" | "failed"> {
  const publication = yield* publishFile(path, content, pid, fileSystem, { idGenerator });
  if (typeof publication === "string") {
    return publication;
  }
  return yield* createLegacyFile(path, content, fileSystem, "Reclaim guard");
}

function* createLegacyFile(
  path: string,
  content: string,
  fileSystem: LockFileSystem,
  context: string,
): Steps<"created" | "contended" | "failed"> {
  let fd: number | undefined;
  try {
    yield { op: "openExclusive", path };
    fd = fileSystem.openExclusive(path);
    try {
      yield { op: "write", path };
      fileSystem.write(fd, content);
    } finally {
      yield { op: "close", path };
      fileSystem.close(fd);
    }
    return "created";
  } catch (error) {
    if (fd === undefined && (error as NodeJS.ErrnoException).code === "EEXIST") {
      // Exclusive-open contention preserves the occupant, even if it later disappears.
      logger.debug(`${context} already held at ${path}: ${errorMessage(error)}`);
      return "contended";
    }
    logger.warn(`${context} creation failed at ${path}: ${errorMessage(error)}`, error);
    if (fd !== undefined) {
      // Only our successful exclusive open proves this partial file is ours to remove.
      yield* cleanupFile(path, fileSystem);
    }
    return "failed";
  }
}

export function* writeLegacyLock(
  path: string,
  content: string,
  fileSystem: LockFileSystem,
): Steps<boolean> {
  // R1: without hard links (or during upgrades), a wx creator stalled beyond the
  // ownerless grace age may be displaced. This legacy actor is outside the atomic invariant.
  let fd: number;
  try {
    yield { op: "openExclusive", path };
    fd = fileSystem.openExclusive(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw toActionableError(error, `Failed to create exclusive lock file at ${path}`);
    }
    // Expected legacy contention; the existing lock remains untouched.
    logger.debug(`Legacy lock already held at ${path}: ${errorMessage(error)}`);
    return false;
  }
  try {
    yield { op: "write", path };
    fileSystem.write(fd, content);
    return true;
  } finally {
    yield { op: "close", path };
    fileSystem.close(fd);
  }
}
