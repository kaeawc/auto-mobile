import {
  type LockSample,
  type ExclusiveLockOptions,
  type Steps,
  sameSample,
  type DoomedPublication,
  hasIdentity,
  isSamePublication,
  isReclaimable,
  toSample,
} from "./contracts";
import { nodeLockFileSystem, type LockFileSystem } from "../lockFileSystem";
import {
  sampleLock,
  claimLockMarker,
  retainDisplacedLock,
  cleanupFile,
  sampleRetainedLock,
  samplePublication,
  completeRetainedLock,
  readText,
  claimReleasePath,
  readReleasePath,
  restoreDisplacedLock,
  retryLockStep,
} from "./fileSystem";
import { guardPrefix, claimReclaimGuard, releaseGuard } from "./reclaimGuard";
import {
  forgetBackOuts,
  rememberBackOut,
  pendingBackOuts,
  hasProtectedPublication,
  hasInFlightPublication,
  rememberGenuineHold,
  lockState,
} from "./state";
import { logger } from "../logger";
import { errorMessage } from "../describeUnknownError";

/** Caller holds the guard for observed; verify both sides of the rename before deleting. */
function* removeRetainedInstance(
  path: string,
  observed: LockSample,
  options: ExclusiveLockOptions,
): Steps<void> {
  const fileSystem = options.fileSystem ?? nodeLockFileSystem;
  const retained = `${path}.displaced`;
  if (!sameSample(yield* sampleLock(retained, fileSystem), observed)) {
    return;
  }
  const marker = `${path}.${options.pid ?? process.pid}.reclaim`;
  if (!(yield* claimLockMarker(retained, marker, fileSystem))) {
    return;
  }
  if (!sameSample(yield* sampleLock(marker, fileSystem), observed)) {
    yield* retainDisplacedLock(path, marker, fileSystem);
    return;
  }
  yield* cleanupFile(marker, fileSystem);
}

function* reclaimRetainedInstance(
  path: string,
  observed: LockSample,
  options: ExclusiveLockOptions,
  generation: string | undefined,
): Steps<void> {
  const fileSystem = options.fileSystem ?? nodeLockFileSystem;
  const prefix = guardPrefix(path, observed);
  const guard = yield* claimReclaimGuard(prefix, options, generation);
  if (guard === undefined) {
    return;
  }
  try {
    yield* removeRetainedInstance(path, observed, options);
  } finally {
    yield* releaseGuard(`${prefix}.${guard.k}`, guard.content, fileSystem);
    if (guard.compacted) {
      yield* releaseGuard(`${prefix}.0`, guard.content, fileSystem);
    }
  }
}

export function* checkRetainedLock(
  path: string,
  options: ExclusiveLockOptions,
  generation: string | undefined,
  publication: {
    reclaimed: LockSample | undefined;
    publishedContent: string;
    /** The private temp name, while it still exists. */
    tmp?: string;
  },
): Steps<boolean> {
  const { reclaimed, publishedContent, tmp } = publication;
  const fileSystem = options.fileSystem ?? nodeLockFileSystem;
  const retained = yield* sampleRetainedLock(`${path}.displaced`, fileSystem);
  if (retained === "absent") {
    return true;
  }
  const pid = options.pid ?? process.pid;
  const published: DoomedPublication =
    (tmp ? yield* samplePublication(tmp, publishedContent, fileSystem) : undefined) ??
    ({ raw: publishedContent } satisfies DoomedPublication);
  const current = yield* removePriorRetainedPublication(path, retained, published, {
    pid,
    fileSystem,
  });
  if (current === "absent") {
    return true;
  }
  // S3: F provably THIS call's publication is never judged for reclaim; identity decides below.
  if (typeof current === "string" || !hasIdentity(published) || !sameSample(published, current)) {
    if (isOwnBytesLeak(current, reclaimed, publishedContent, options)) {
      return yield* reclaimOwnBytesRetained(path, published, pid, fileSystem);
    }
    if (yield* reclaimRetainedLock(path, current, options, { generation, reclaimed })) {
      return true;
    }
  }
  return yield* settleRetainedPublication(path, current, published, { pid, fileSystem });
}

/** F2: distinguish this call's retained publication from remembered earlier doomed instances. */
function* removePriorRetainedPublication(
  path: string,
  retained: LockSample | "unreadable",
  published: DoomedPublication,
  { pid, fileSystem }: { pid: number; fileSystem: LockFileSystem },
): Steps<LockSample | "absent" | "unreadable"> {
  if (typeof retained !== "string" && hasIdentity(published) && sameSample(published, retained)) {
    // Inode reuse makes this identity the new publication, never an earlier doomed one.
    forgetBackOuts(path, fileSystem, (known) => isSamePublication(known, published));
    return retained;
  }
  return yield* removeRememberedRetained(path, retained, pid, { fileSystem });
}

function* settleRetainedPublication(
  path: string,
  retained: LockSample | "unreadable",
  published: DoomedPublication,
  { pid, fileSystem }: { pid: number; fileSystem: LockFileSystem },
): Steps<boolean> {
  const publication = yield* isRetainedPublication(path, retained, published.raw, {
    fileSystem,
    publication: hasIdentity(published) ? published : undefined,
  });
  if (publication === "absent") {
    yield* completeRetainedLock(path, fileSystem);
    return true;
  }
  if (publication === "same") {
    return true; // Another actor already completed this publication; keep both names untouched.
  }
  if (publication === "older") {
    if (hasIdentity(published)) {
      // F1: D may be in a displacer's private marker; its identity cannot match the older hold.
      rememberBackOut(path, fileSystem, published);
    }
    // Legacy wx has no identity: preserve the documented same-bytes self-block residual.
    return false; // An older same-owner hold is authoritative; P is absent, foreign or unreadable.
  }
  if (publication === "blocked" && hasIdentity(published)) {
    yield* removeBlockedPublication(path, published, pid, fileSystem);
    return false;
  }
  // Back out only P; F remains the retained owner's authority throughout COMPLETE.
  yield* backOutLockPath(path, published, pid, fileSystem);
  yield* completeRetainedLock(path, fileSystem);
  return false;
}

/**
 * S1: this call's publication sits at F while P is someone else's. Its owner removes it by
 * identity, F first: once the name F is claimed no COMPLETE can `link(F, P)` it any more. A peer
 * may already have done so, hence the P sample. Never the release path, whose unlink-exhaustion
 * fallback would link the doomed instance onto P. Unless it was verifiably removed from BOTH names
 * a displacer may still hold it in a private marker and link it back, so it is remembered.
 */
function* removeBlockedPublication(
  path: string,
  published: LockSample,
  pid: number,
  fileSystem: LockFileSystem,
): Steps<void> {
  const retained = yield* removeInstance(path, `${path}.displaced`, published, { pid, fileSystem });
  const linked = yield* removeInstance(path, path, published, { pid, fileSystem });
  if (retained !== "removed" || linked !== "removed") {
    rememberBackOut(path, fileSystem, published);
  }
}

/** S2/C3: an earlier doomed publication of this process that a displacer retained at F is removed by its owner. */
function* removeRememberedRetained(
  path: string,
  retained: LockSample | "unreadable",
  pid: number,
  { fileSystem, keepEntry = false }: { fileSystem: LockFileSystem; keepEntry?: boolean },
): Steps<LockSample | "absent" | "unreadable"> {
  if (typeof retained === "string") {
    return retained;
  }
  const doomed = pendingBackOuts
    .get(fileSystem)
    ?.get(path)
    ?.publications.find(
      (known) =>
        hasIdentity(known) &&
        (sameSample(known, retained) ||
          (known.raw === retained.raw && !hasProtectedPublication(path, known.raw, fileSystem))),
    );
  if (doomed === undefined || !hasIdentity(doomed)) {
    return retained;
  }
  const name = `${path}.displaced`;
  const removed = sameSample(doomed, retained)
    ? (yield* removeInstance(path, name, doomed, { pid, fileSystem })) === "removed"
    : (yield* backOutBytesAtName(path, name, doomed.raw, {
        pid,
        fileSystem,
        protectGenuine: true,
      })) === "removed";
  if (!removed) {
    return retained;
  }
  if (!keepEntry && !sameSample(doomed, retained)) {
    forgetBackOuts(path, fileSystem, (known) => known === doomed);
  }
  // Identity removal from F keeps the entry for another name or private-marker restore.
  return yield* sampleRetainedLock(name, fileSystem);
}

/** S3 (b): F carries exactly this call's bytes without identity proof and is judged reclaimable. */
function isOwnBytesLeak(
  retained: LockSample | "unreadable",
  reclaimed: LockSample | undefined,
  publishedContent: string,
  options: ExclusiveLockOptions,
): retained is LockSample {
  return (
    typeof retained !== "string" &&
    retained.raw === publishedContent &&
    !(reclaimed !== undefined && sameSample(retained, reclaimed)) &&
    isReclaimable(retained, options)
  );
}

/**
 * S3 (b): the own-pid `reclaimOwnPid` leak. Without identity proof F may BE this publication
 * (legacy wx, displaced and retained), so removing it must not by itself report "acquired":
 * the owner removes F without the guard and holds only if P still reads its exact bytes.
 */
function* reclaimOwnBytesRetained(
  path: string,
  published: DoomedPublication,
  pid: number,
  fileSystem: LockFileSystem,
): Steps<boolean> {
  const removed = yield* removeOwnBytesRetained(path, published.raw, pid, fileSystem);
  if ((yield* readText(path, fileSystem)) === published.raw) {
    return true;
  }
  if (!removed) {
    rememberBackOut(path, fileSystem, { raw: published.raw });
  }
  if (hasIdentity(published)) {
    // The atomic publication is at neither name: a displacer may link it back later.
    rememberBackOut(path, fileSystem, published);
  }
  return false;
}

function* removeOwnBytesRetained(
  path: string,
  raw: string,
  pid: number,
  fileSystem: LockFileSystem,
): Steps<boolean> {
  const marker = `${path}.${pid}.release.${++lockState.releaseMarkerCounter}`;
  if (!(yield* claimReleasePath(`${path}.displaced`, marker, fileSystem))) {
    return false;
  }
  if ((yield* readReleasePath(marker, fileSystem)) !== raw) {
    yield* retainDisplacedLock(path, marker, fileSystem);
    return false;
  }
  yield* unlinkBackOutMarker(path, marker, fileSystem);
  return true;
}

function* reclaimRetainedLock(
  path: string,
  retained: LockSample | "unreadable",
  options: ExclusiveLockOptions,
  { generation, reclaimed }: { generation?: string; reclaimed?: LockSample } = {},
): Steps<boolean> {
  if (typeof retained !== "string") {
    if (reclaimed !== undefined && sameSample(retained, reclaimed)) {
      yield* removeRetainedInstance(path, reclaimed, options);
      return true;
    }
    if (isReclaimable(retained, options)) {
      const alreadyGuarded =
        reclaimed !== undefined && guardPrefix(path, reclaimed) === guardPrefix(path, retained);
      if (!alreadyGuarded) {
        yield* reclaimRetainedInstance(path, retained, options, generation);
      }
      return true;
    }
  }
  return false;
}

function* isRetainedPublication(
  path: string,
  retained: LockSample | "unreadable",
  publishedContent: string,
  { fileSystem, publication }: { fileSystem: LockFileSystem; publication?: LockSample },
): Steps<"other" | "older" | "same" | "absent" | "blocked"> {
  if (typeof retained === "string" || retained.raw !== publishedContent) {
    return "other";
  }
  if (!sameSample(publication, retained)) {
    // Legacy wx has no identity proof: if displaced into F it reports false and stays
    // live there until exit or release; without hard links COMPLETE cannot restore it either.
    return (yield* readText(path, fileSystem)) === publishedContent ? "other" : "older";
  }
  try {
    yield { op: "readText", path };
    const raw = fileSystem.readText(path);
    if (raw !== publishedContent) {
      return "blocked";
    }
    yield { op: "stat", path };
    return sameSample({ ...fileSystem.stat(path), raw }, retained) ? "same" : "blocked";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      // F existed before this read: later publishers see live F and back out;
      // any publication that completed before retention is still at P. ENOENT is exclusive.
      logger.debug(`Own retained publication has no peer at ${path}: ${errorMessage(error)}`);
      return "absent";
    }
    logger.warn(`Own retained publication cannot read ${path}: ${errorMessage(error)}`, error);
    return "blocked";
  }
}

/**
 * Runs first in every lock call for the path. An identity entry costs `stat(P)` and at most one
 * byte check of P when identity differs per call
 * until it leaves by verified removal or eviction: a doomed publication that was not found may sit
 * in a displacer's private marker and be linked back at any later time, including after this
 * process acquired and released a genuine lock with identical bytes.
 */
export function* drainPendingBackOut(
  path: string,
  pid: number,
  fileSystem: LockFileSystem,
): Steps<void> {
  const pending = pendingBackOuts.get(fileSystem)?.get(path);
  if (!pending) {
    return; // Zero fs operations on the ordinary path.
  }
  for (const marker of [...pending.markers]) {
    pending.markers.delete(marker);
    yield* unlinkBackOutMarker(path, marker, fileSystem);
  }
  for (const publication of [...pending.publications]) {
    if (yield* drainDoomedPublication(path, publication, pid, fileSystem)) {
      forgetBackOuts(path, fileSystem, (known) => known === publication);
    }
  }
  forgetBackOuts(path, fileSystem, () => false);
  // A process that never calls this path's lock API again leaves P until it exits,
  // just like any live-pid lock; other processes cannot distinguish the non-holder.
}

/** True when the entry is done: its publication was verifiably removed. */
function* drainDoomedPublication(
  path: string,
  publication: DoomedPublication,
  pid: number,
  fileSystem: LockFileSystem,
): Steps<boolean> {
  if (!hasIdentity(publication)) {
    // Open residual (no hard links): bytes alone cannot tell this doomed publication from a
    // later genuine one, so a raw-only entry is cleared when this process acquires P with the
    // same bytes; a displacer linking the doomed copy back after that is not drained.
    if (hasInFlightPublication(path, publication.raw, fileSystem)) {
      return false;
    }
    return (
      (yield* backOutAttempt(path, publication.raw, pid, { fileSystem, protectGenuine: true })) ===
      "removed"
    );
  }
  const current = yield* samplePublication(path, publication.raw, fileSystem);
  if (!sameSample(current, publication)) {
    if (current === undefined) {
      return false;
    }
    return yield* removeDoomedCopy(path, path, publication.raw, { pid, fileSystem });
  }
  // F first: a retained copy of this instance could otherwise be linked onto P again.
  const retained = yield* removeInstance(path, `${path}.displaced`, publication, {
    pid,
    fileSystem,
  });
  const linked = yield* removeInstance(path, path, publication, { pid, fileSystem });
  return linked === "removed" && retained !== "unverified";
}

/** Production serializes lock calls synchronously; the in-flight guard also protects interleaved
 * harness publishers. Bytes identify a doomed copy only without a genuine hold (#2947 reopen). */
function* removeDoomedCopy(
  path: string,
  name: string,
  raw: string,
  { pid, fileSystem }: { pid: number; fileSystem: LockFileSystem },
): Steps<boolean> {
  if (
    hasProtectedPublication(path, raw, fileSystem) ||
    (yield* readText(name, fileSystem)) !== raw
  ) {
    return false;
  }
  const retained = yield* sampleRetainedLock(`${path}.displaced`, fileSystem);
  const remaining =
    retained === "absent"
      ? retained
      : yield* removeRememberedRetained(path, retained, pid, { fileSystem, keepEntry: true });
  // A successful byte removal ends the entry. A later private-marker restore is the R2 residual.
  const removed =
    (yield* backOutBytesAtName(path, name, raw, { pid, fileSystem, protectGenuine: true })) ===
    "removed";
  return removed && remaining !== "unreadable" && (remaining === "absent" || remaining.raw !== raw);
}

/**
 * Remove one public name (P or F) of a doomed publication by identity: sample, claim to a private
 * marker, verify the marker is that same instance, unlink it. A foreign instance is put back.
 */
function* removeInstance(
  path: string,
  name: string,
  publication: LockSample,
  { pid, fileSystem }: { pid: number; fileSystem: LockFileSystem },
): Steps<"removed" | "elsewhere" | "unverified"> {
  if (!sameSample(yield* samplePublication(name, publication.raw, fileSystem), publication)) {
    return "elsewhere";
  }
  if ((yield* readText(name, fileSystem)) !== publication.raw) {
    return "unverified";
  }
  const marker = `${path}.${pid}.release.${++lockState.releaseMarkerCounter}`;
  if (!(yield* claimReleasePath(name, marker, fileSystem))) {
    return "unverified";
  }
  if (!sameSample(yield* sampleLock(marker, fileSystem), publication)) {
    if (name === path) {
      yield* restoreDisplacedLock(path, marker, fileSystem);
    } else {
      yield* retainDisplacedLock(path, marker, fileSystem);
    }
    return "unverified";
  }
  yield* unlinkBackOutMarker(path, marker, fileSystem);
  return "removed";
}

/** A release that claimed an instance equal to a remembered identity ends that entry. */
export function* forgetClaimedBackOut(
  path: string,
  marker: string,
  raw: string,
  fileSystem: LockFileSystem,
): Steps<void> {
  const known = pendingBackOuts.get(fileSystem)?.get(path)?.publications;
  if (!known?.some((publication) => hasIdentity(publication) && publication.raw === raw)) {
    return; // Zero fs operations unless this process has such an entry.
  }
  const claimed = yield* samplePublication(marker, raw, fileSystem);
  forgetBackOuts(path, fileSystem, (publication) => sameSample(claimed, toSample(publication)));
}

/**
 * This process's acquire for P returned true. Its bytes are now legitimately at P, so a raw-only
 * entry with those bytes must never drain again. An identity entry stays (acquire, takeover and
 * release do not clear it) unless the filesystem reused that inode for this very publication.
 */
export function* settleAcquiredBackOuts(
  path: string,
  content: string,
  fileSystem: LockFileSystem,
  publicationName: string,
): Steps<void> {
  rememberGenuineHold(path, content, fileSystem);
  const known = pendingBackOuts.get(fileSystem)?.get(path)?.publications ?? [];
  const candidates = known.filter((publication) => publication.raw === content);
  if (!candidates.length) {
    return; // Zero fs operations unless this process has a pending entry for these bytes.
  }
  const acquired = candidates.some(hasIdentity)
    ? yield* samplePublication(publicationName, content, fileSystem)
    : undefined;
  forgetBackOuts(
    path,
    fileSystem,
    (publication) =>
      candidates.includes(publication) &&
      (!hasIdentity(publication) || sameSample(acquired, publication)),
  );
}

function* backOutLockPath(
  path: string,
  publication: DoomedPublication,
  pid: number,
  fileSystem: LockFileSystem,
): Steps<void> {
  const outcome = yield* backOutAttempt(path, publication.raw, pid, { fileSystem });
  if (outcome === "removed") {
    return;
  }
  // S2: a back-out is complete only when it claimed and removed its own publication. Anything
  // else leaves that publication possibly in a displacer's private marker, to be linked back.
  rememberBackOut(path, fileSystem, publication);
  if (outcome === "failed") {
    logger.warn(`Lock back-out failed at ${path}; cleanup pending in this process`);
  } else {
    logger.debug(`Lock back-out did not find its publication at ${path}; removal pending`);
  }
}

function* backOutAttempt(
  path: string,
  raw: string,
  pid: number,
  { fileSystem, protectGenuine = false }: { fileSystem: LockFileSystem; protectGenuine?: boolean },
): Steps<"removed" | "unfound" | "failed"> {
  const read = yield* retryLockStep({ op: "readText", path }, () => fileSystem.readText(path));
  if (typeof read === "string") {
    return read === "missing" ? "unfound" : "failed";
  }
  if (read.value !== raw) {
    return "unfound";
  }
  return yield* backOutBytesAtName(path, path, raw, { pid, fileSystem, protectGenuine });
}

function* backOutBytesAtName(
  path: string,
  name: string,
  raw: string,
  {
    pid,
    fileSystem,
    protectGenuine = false,
  }: { pid: number; fileSystem: LockFileSystem; protectGenuine?: boolean },
): Steps<"removed" | "unfound" | "failed"> {
  const marker = `${path}.${pid}.release.${++lockState.releaseMarkerCounter}`;
  const claim = yield* retryLockStep({ op: "rename", path: name }, () => {
    if (protectGenuine && hasProtectedPublication(path, raw, fileSystem)) {
      return false;
    }
    fileSystem.rename(name, marker);
    return true;
  });
  if (typeof claim === "string") {
    return claim === "missing" ? "unfound" : "failed";
  }
  if (!claim.value) {
    return "unfound";
  }
  const claimed = yield* retryLockStep({ op: "readText", path: marker }, () =>
    fileSystem.readText(marker),
  );
  if (
    typeof claimed === "string" ||
    claimed.value !== raw ||
    (protectGenuine && hasProtectedPublication(path, raw, fileSystem))
  ) {
    // Foreign or unknown claimed bytes are restored; this publication was not removed.
    if (name === path) {
      yield* restoreDisplacedLock(path, marker, fileSystem);
    } else {
      yield* retainDisplacedLock(path, marker, fileSystem);
    }
    return claimed === "failed" ? "failed" : "unfound";
  }
  yield* unlinkBackOutMarker(path, marker, fileSystem);
  return "removed";
}

function* unlinkBackOutMarker(
  path: string,
  marker: string,
  fileSystem: LockFileSystem,
): Steps<void> {
  const result = yield* retryLockStep({ op: "unlink", path: marker }, () =>
    fileSystem.unlink(marker),
  );
  if (result !== "failed") {
    return;
  }
  rememberBackOut(path, fileSystem, undefined, marker);
  logger.warn(`Lock back-out marker cleanup failed at ${path}; cleanup pending in this process`);
  // Never sweep .release.<n> markers: after a process exits, one may be the only
  // copy of a displaced live owner's lock. Only this process remembers doomed markers.
}

export function* drainRetainedBeforePublication(
  path: string,
  pid: number,
  fileSystem: LockFileSystem,
): Steps<void> {
  const known = pendingBackOuts.get(fileSystem)?.get(path)?.publications;
  if (!known?.some(hasIdentity)) {
    return;
  }
  // Drain F before publishing identical bytes; the new in-flight publication must stay protected.
  const retained = yield* sampleRetainedLock(`${path}.displaced`, fileSystem);
  if (retained !== "absent") {
    yield* removeRememberedRetained(path, retained, pid, { fileSystem });
  }
}
