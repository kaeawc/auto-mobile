import {
  type ExclusiveLockOptions,
  finishLockSteps,
  type Steps,
  type LockAttemptOptions,
  captureLockOwnerGeneration,
  isReclaimable,
  type LockSample,
  sameSample,
  isProcessRunningWithDebug,
  parseLockContent,
  compareLockOwnerGeneration,
  type LockContent,
  isOwnLockContent,
  formatLockContent,
} from "./fileLock/contracts";
import {
  forgetInFlightPublications,
  forgetGenuineHolds,
  rememberInFlightPublication,
  lockState,
} from "./fileLock/state";
import { nodeLockFileSystem, type LockFileSystem } from "./lockFileSystem";
import {
  drainPendingBackOut,
  forgetClaimedBackOut,
  drainRetainedBeforePublication,
  checkRetainedLock,
  settleAcquiredBackOuts,
} from "./fileLock/retainedPublication";
import {
  sampleLock,
  sweepOwnPublicationTmps,
  claimLockMarker,
  restoreDisplacedLock,
  removeStaleLockMarker,
  cleanupFile,
  readText,
  readReleaseResult,
  claimReleasePath,
  readReleasePath,
  retainDisplacedLock,
  retryLockStep,
  publishFile,
  writeLegacyLock,
} from "./fileLock/fileSystem";
import { guardPrefix, claimReclaimGuard, releaseGuard } from "./fileLock/reclaimGuard";
import { type LockOwnerGenerationProbe } from "../models/LockOwnerGeneration";
import { logger } from "./logger";
import { errorMessage } from "./describeUnknownError";
import { dirname } from "path";
import { toActionableError } from "../models/ActionableError";
export {
  OWNERLESS_LOCK_RECLAIM_AGE_MS,
  RECLAIM_GUARD_ABANDON_AGE_MS,
  RECLAIM_GUARD_SLOT_LIMIT,
  OWN_TMP_SWEEP_LIMIT,
  OWN_TMP_SWEEP_INTERVAL_MS,
  OWN_TMP_SWEEP_CANDIDATE_LIMIT,
  OWN_TMP_SWEEP_DIRECTORY_LIMIT,
  type ExclusiveLockOptions,
  type LockContent,
  formatLockContent,
  parseLockContent,
  type LockStep,
  compareLockOwnerGeneration,
} from "./fileLock/contracts";
export { hasPendingBackOut } from "./fileLock/state";
export type { LockOwnerGenerationProbe, LockOwnerGenerationVerdict } from "./fileLock/contracts";

/**
 * One non-blocking attempt to acquire the exclusive lock. Returns true if the
 * lock is now held by `pid`, false if another live holder owns it.
 */
export function tryAcquireExclusiveLock(
  lockFilePath: string,
  options: ExclusiveLockOptions = {},
): boolean {
  return finishLockSteps(acquireExclusiveLockSteps(lockFilePath, options));
}

/** Test scheduling seam: yields BEFORE every fs operation. Production must drive it synchronously. */
export function* acquireExclusiveLockSteps(
  lockFilePath: string,
  options: ExclusiveLockOptions = {},
): Steps<boolean> {
  const attempt = { ...options, publications: new Set<string>() };
  try {
    return yield* acquireLockSteps(lockFilePath, attempt);
  } finally {
    forgetInFlightPublications(
      lockFilePath,
      options.fileSystem ?? nodeLockFileSystem,
      attempt.publications,
    );
  }
}

function* acquireLockSteps(lockFilePath: string, options: LockAttemptOptions): Steps<boolean> {
  const pid = options.pid ?? process.pid;
  const fileSystem = options.fileSystem ?? nodeLockFileSystem;
  yield* drainPendingBackOut(lockFilePath, pid, fileSystem);
  const initial = yield* sampleLock(lockFilePath, fileSystem);
  if (initial) {
    // Preserve the first attempt's generation capture, including live-lock probes;
    // the guard reuses it and the final publication still captures freshly.
    const generation = captureLockOwnerGeneration(options.ownerGeneration, pid);
    // This sample only avoids doomed publication. Exclusive link and the reclaim
    // guard arbitrate ownership; the single-holder invariant does not depend on it.
    if (!isReclaimable(initial, options)) {
      return false;
    }
    return yield* reclaimExclusiveLock(lockFilePath, options, initial, generation);
  }
  const first = yield* writeExclusiveLockFile(lockFilePath, pid, options);
  if (first.blocked) {
    return false;
  }
  if (first.acquired) {
    return true;
  }
  const observed = yield* sampleLock(lockFilePath, options.fileSystem ?? nodeLockFileSystem);
  if (!observed || !isReclaimable(observed, options)) {
    return false;
  }
  // Reuse the free path's sweep unless mkdir failed before it could run.
  return yield* reclaimExclusiveLock(
    lockFilePath,
    options,
    observed,
    first.generation,
    !first.swept,
  );
}

function* reclaimExclusiveLock(
  lockFilePath: string,
  options: LockAttemptOptions,
  observed: LockSample,
  generation: string | undefined,
  sweep = true,
): Steps<boolean> {
  const fileSystem = options.fileSystem ?? nodeLockFileSystem;
  const pid = options.pid ?? process.pid;
  const prefix = guardPrefix(lockFilePath, observed);
  if (sweep) {
    yield* sweepOwnPublicationTmps(lockFilePath, options);
  }
  const guard = yield* claimReclaimGuard(prefix, options, generation);
  if (guard === undefined) {
    return false;
  }
  try {
    // The guard excludes other removers of THIS instance; an outdated sample never renames a winner.
    if (!sameSample(yield* sampleLock(lockFilePath, fileSystem), observed)) {
      return false;
    }
    const marker = `${lockFilePath}.${pid}.reclaim`;
    if (!(yield* claimLockMarker(lockFilePath, marker, fileSystem))) {
      return false;
    }
    if (!sameSample(yield* sampleLock(marker, fileSystem), observed)) {
      // R1: legacy/fallback writers stalled beyond the ownerless age can still write
      // through an old fd. Restore without clobbering; atomic publishers exclude this actor.
      yield* restoreDisplacedLock(lockFilePath, marker, fileSystem);
      return false;
    }
    yield* removeStaleLockMarker(marker, fileSystem);
    for (let lower = guard.compacted ? 1 : 0; lower < guard.k; lower++) {
      // Once removed, this fingerprint cannot pass the path check again.
      yield* cleanupFile(`${prefix}.${lower}`, fileSystem);
    }
    return (yield* writeExclusiveLockFile(lockFilePath, pid, options, false, observed)).acquired;
  } finally {
    yield* releaseGuard(`${prefix}.${guard.k}`, guard.content, fileSystem);
    if (guard.compacted) {
      yield* releaseGuard(`${prefix}.0`, guard.content, fileSystem);
    }
  }
}

/**
 * Read the PID from P, falling back to its retained sibling when unreadable, without attempting to
 * acquire or reclaim it (issue #6260). Used by callers that need to name the
 * process currently holding a lease in an actionable error — e.g. "another
 * AutoMobile process (PID N) owns this resource" — rather than a bare
 * boolean. Returns `undefined` when the file is missing, unreadable, or
 * names a process that is not (or no longer) running.
 */
export function readLockOwnerPid(
  lockFilePath: string,
  isProcessRunning: (pid: number) => boolean = isProcessRunningWithDebug,
  ownerGeneration?: LockOwnerGenerationProbe,
  fileSystem: LockFileSystem = nodeLockFileSystem,
): number | undefined {
  const content = finishLockSteps(readLockOrRetained(lockFilePath, fileSystem))?.trim();
  if (content === undefined) {
    return undefined;
  }
  const { pid, generation } = parseLockContent(content);
  if (Number.isNaN(pid) || !isProcessRunning(pid)) {
    return undefined;
  }
  if (
    generation !== undefined &&
    ownerGeneration !== undefined &&
    compareLockOwnerGeneration(ownerGeneration, pid, generation) === "different"
  ) {
    return undefined;
  }
  return pid;
}

/**
 * Read and parse P, falling back to its retained sibling only when P is unreadable.
 * Returns `undefined` when the file is missing, unreadable, or empty.
 */
export function readExclusiveLockContent(
  lockFilePath: string,
  fileSystem: LockFileSystem = nodeLockFileSystem,
): LockContent | undefined {
  const content = finishLockSteps(readLockOrRetained(lockFilePath, fileSystem))?.trim();
  if (content === undefined || content.length === 0) {
    return undefined;
  }
  return parseLockContent(content);
}

function* readLockOrRetained(path: string, fileSystem: LockFileSystem): Steps<string | undefined> {
  const content = yield* readText(path, fileSystem);
  return content ?? (yield* readText(`${path}.displaced`, fileSystem));
}

/**
 * Take over a lock held by a LIVE owner the caller has judged stale by some
 * out-of-band evidence (issue #10497: the owner reported no live session, or
 * its control socket is unreachable). The takeover only succeeds when the lock
 * still holds exactly the observed owner's PID and token. Removal is guarded by
 * the sampled file identity just like dead-owner reclaim. R2: a live owner's own
 * release racing takeover retains the private-marker in-flight window below.
 * A lock only at F cannot be taken over. A taker crashing after publication but
 * before removing a live owner's linked F is undone by the next acquirer,
 * which restores that owner's lock to P as if the takeover never happened.
 */
export function takeOverExclusiveLock(
  lockFilePath: string,
  observedOwner: Pick<LockContent, "pid" | "token">,
  options: Pick<
    ExclusiveLockOptions,
    | "pid"
    | "ownerToken"
    | "metadata"
    | "ownerGeneration"
    | "fileSystem"
    | "isProcessRunning"
    | "idGenerator"
  > = {},
): boolean {
  return finishLockSteps(takeOverLockSteps(lockFilePath, observedOwner, options));
}

function* takeOverLockSteps(
  path: string,
  owner: Pick<LockContent, "pid" | "token">,
  options: ExclusiveLockOptions,
): Steps<boolean> {
  const attempt = { ...options, publications: new Set<string>() };
  try {
    return yield* takeOverAttemptSteps(path, owner, attempt);
  } finally {
    forgetInFlightPublications(
      path,
      options.fileSystem ?? nodeLockFileSystem,
      attempt.publications,
    );
  }
}

function* takeOverAttemptSteps(
  path: string,
  owner: Pick<LockContent, "pid" | "token">,
  options: LockAttemptOptions,
): Steps<boolean> {
  const fileSystem = options.fileSystem ?? nodeLockFileSystem;
  yield* drainPendingBackOut(path, options.pid ?? process.pid, fileSystem);
  const sample = yield* sampleLock(path, fileSystem);
  if (!sample) {
    return false;
  }
  const current = parseLockContent(sample.raw.trim());
  if (current.pid !== owner.pid || current.token !== owner.token) {
    return false;
  }
  const generation = captureLockOwnerGeneration(
    options.ownerGeneration,
    options.pid ?? process.pid,
  );
  return yield* reclaimExclusiveLock(path, options, sample, generation);
}

/**
 * Release a lock owned by `pid`. Compare-and-delete: the file is removed only if
 * it still holds `pid`, so a reclaim race can't delete a lock that a *different*
 * opener now owns (mirrors `shouldCleanupForExpectedPid` in `daemonFiles.ts`).
 *
 * When `ownerToken` is supplied, release is incarnation-aware: it unlinks only if
 * BOTH the PID and the token match, so it is symmetric with the reclaim decision
 * in {@link tryAcquireExclusiveLock}. This closes the recycled-PID window where a
 * process could delete a lock now held by a *different* incarnation that recycled
 * the same PID and wrote a different token (issue #3006, follow-up 1). A lock file
 * with NO token line (a pre-token incarnation) is treated as ours on a PID match,
 * preserving the legacy PID-only behavior. The daemon caller now passes its
 * per-instance startup-lock owner token too (issue #5904), so its release is
 * incarnation-aware rather than PID-only.
 */
export function releaseExclusiveLock(
  lockFilePath: string,
  pid: number = process.pid,
  ownerToken?: string,
  fileSystem: LockFileSystem = nodeLockFileSystem,
): void {
  finishLockSteps(releaseExclusiveLockSteps(lockFilePath, pid, ownerToken, fileSystem));
}

/** Test scheduling seam: yields BEFORE every fs operation. Production must drive it synchronously. */
export function* releaseExclusiveLockSteps(
  lockFilePath: string,
  pid: number = process.pid,
  ownerToken?: string,
  fileSystem: LockFileSystem = nodeLockFileSystem,
): Steps<void> {
  yield* drainPendingBackOut(lockFilePath, pid, fileSystem);
  const retainedGone = yield* releaseRetainedLock(lockFilePath, pid, ownerToken, fileSystem);
  const pathGone = yield* releaseLockPath(lockFilePath, pid, ownerToken, fileSystem);
  if (retainedGone && pathGone) {
    forgetGenuineHolds(lockFilePath, fileSystem, (raw) =>
      isOwnLockContent(parseLockContent(raw.trim()), pid, ownerToken),
    );
  }
}

function* releaseRetainedLock(
  path: string,
  pid: number,
  ownerToken: string | undefined,
  fileSystem: LockFileSystem,
): Steps<boolean> {
  const retained = `${path}.displaced`;
  const read = yield* readReleaseResult(retained, fileSystem);
  if (read === "missing") {
    return true;
  }
  const raw = typeof read === "string" ? undefined : read.value;
  if (raw === undefined || !isOwnLockContent(parseLockContent(raw.trim()), pid, ownerToken)) {
    return false;
  }
  const marker = `${path}.${pid}.release.${++lockState.releaseMarkerCounter}`;
  if (!(yield* claimReleasePath(retained, marker, fileSystem))) {
    return false;
  }
  const claimed = yield* readReleasePath(marker, fileSystem);
  if (
    claimed === undefined ||
    !isOwnLockContent(parseLockContent(claimed.trim()), pid, ownerToken)
  ) {
    yield* retainDisplacedLock(path, marker, fileSystem);
    return false;
  }
  yield* forgetClaimedBackOut(path, marker, claimed, fileSystem);
  if (yield* unlinkReleasedMarker(path, marker, fileSystem)) {
    forgetGenuineHolds(path, fileSystem, (raw) => raw === claimed);
  }
  return false;
}

function* releaseLockPath(
  lockFilePath: string,
  pid: number,
  ownerToken: string | undefined,
  fileSystem: LockFileSystem,
): Steps<boolean> {
  const read = yield* readReleaseResult(lockFilePath, fileSystem);
  if (read === "missing") {
    return true;
  }
  const content = typeof read === "string" ? undefined : read.value;
  if (content === undefined) {
    return false;
  }

  if (!isOwnLockContent(parseLockContent(content.trim()), pid, ownerToken)) {
    // The lock is no longer ours — do not delete another opener's file.
    return false;
  }

  // A live owner's lock can now be taken over (#10497), so the read above may
  // already be stale: a taker could replace the file between that read and an
  // unlink-by-path, which would delete the TAKER's lock. Claim the exact file
  // instance by renaming it to a unique marker, verify the marker is ours, and
  // only then delete it; a displaced foreign lock is restored instead.
  // R2 is the private-marker in-flight window described at restoreDisplacedLock.
  const releaseMarker = `${lockFilePath}.${pid}.release.${++lockState.releaseMarkerCounter}`;
  if (!(yield* claimReleasePath(lockFilePath, releaseMarker, fileSystem))) {
    return false;
  }
  const claimed = yield* readReleasePath(releaseMarker, fileSystem);
  if (
    claimed === undefined ||
    !isOwnLockContent(parseLockContent(claimed.trim()), pid, ownerToken)
  ) {
    yield* restoreDisplacedLock(lockFilePath, releaseMarker, fileSystem);
    return false;
  }
  yield* forgetClaimedBackOut(lockFilePath, releaseMarker, claimed, fileSystem);
  if (yield* unlinkReleasedMarker(lockFilePath, releaseMarker, fileSystem)) {
    forgetGenuineHolds(lockFilePath, fileSystem, (raw) => raw === claimed);
  }
  return false;
}

function* unlinkReleasedMarker(
  lockFilePath: string,
  releaseMarker: string,
  fileSystem: LockFileSystem,
): Steps<boolean> {
  const result = yield* retryLockStep({ op: "unlink", path: releaseMarker }, () =>
    fileSystem.unlink(releaseMarker),
  );
  if (result !== "failed") {
    return true;
  }
  logger.warn(`Failed to release exclusive lock at ${lockFilePath}; marker unlink exhausted`);
  // Linking restores an unreleased lock without clobbering a concurrent publication.
  try {
    yield { op: "link", path: lockFilePath };
    fileSystem.link(releaseMarker, lockFilePath);
  } catch (error) {
    logger.warn(
      `Could not restore unreleased lock at ${lockFilePath}: ${errorMessage(error)}`,
      error,
    );
  }
  return false;
}

function* writeExclusiveLockFile(
  path: string,
  pid: number,
  options: LockAttemptOptions,
  sweep = true,
  reclaimed?: LockSample,
): Steps<{ acquired: boolean; generation: string | undefined; swept: boolean; blocked?: boolean }> {
  const fileSystem = options.fileSystem ?? nodeLockFileSystem;
  try {
    yield { op: "mkdir", path: dirname(path) };
    fileSystem.mkdir(dirname(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      // A parent occupied by a non-directory reads as held for pre-#12086 parity.
      logger.debug(
        `Lock parent already occupied at ${dirname(path)}: ${errorMessage(error)}`,
        error,
      );
      return { acquired: false, generation: undefined, swept: false };
    }
    throw toActionableError(error, `Failed to create exclusive lock file at ${path}`);
  }
  if (sweep) {
    yield* sweepOwnPublicationTmps(path, options);
  }
  try {
    const generation = captureLockOwnerGeneration(options.ownerGeneration, pid);
    const content = formatLockContent(pid, options.ownerToken, options.metadata, generation);
    yield* drainRetainedBeforePublication(path, pid, fileSystem);
    rememberInFlightPublication(path, content, fileSystem, options.publications);
    let acquired = false;
    const publication = yield* publishFile(path, content, pid, fileSystem, {
      idGenerator: options.idGenerator,
      postPublish: function* (tmp): Steps<void> {
        acquired = yield* checkRetainedLock(path, options, generation, {
          reclaimed,
          publishedContent: content,
          tmp,
        });
        if (acquired) {
          yield* settleAcquiredBackOuts(path, content, fileSystem, tmp);
        }
      },
    });
    const published =
      typeof publication === "string"
        ? publication === "created"
        : yield* writeLegacyLock(path, content, fileSystem);
    if (!published) {
      return { acquired: false, generation, swept: sweep };
    }
    if (typeof publication !== "string") {
      acquired = yield* checkRetainedLock(path, options, generation, {
        reclaimed,
        publishedContent: content,
      });
      if (acquired) {
        yield* settleAcquiredBackOuts(path, content, fileSystem, path);
      }
    }
    return { acquired, generation, swept: sweep, blocked: !acquired };
  } catch (error) {
    // Genuine IO failures are not contention (#3623).
    throw toActionableError(error, `Failed to create exclusive lock file at ${path}`);
  }
}
