import { type DoomedPublication, isSamePublication } from "./contracts";
import { type LockFileSystem } from "../lockFileSystem";

const PENDING_PUBLICATION_LIMIT = 8;

/**
 * Eviction residual: more than 8 doomed publications per path or 64 paths per filesystem
 * object evicts the oldest entry; its publication can then stay named until its process exits.
 */
interface PendingBackOut {
  publications: DoomedPublication[];
  markers: Set<string>;
}

export const pendingBackOuts = new WeakMap<LockFileSystem, Map<string, PendingBackOut>>();

const genuineHolds = new WeakMap<LockFileSystem, Map<string, Set<string>>>();

const inFlightPublications = new WeakMap<LockFileSystem, Map<string, Map<string, number>>>();

export function hasInFlightPublication(
  path: string,
  raw: string,
  fileSystem: LockFileSystem,
): boolean {
  return (inFlightPublications.get(fileSystem)?.get(path)?.get(raw) ?? 0) > 0;
}

export function rememberInFlightPublication(
  path: string,
  raw: string,
  fileSystem: LockFileSystem,
  publications: Set<string>,
): void {
  if (publications.has(raw)) {
    return;
  }
  publications.add(raw);
  let paths = inFlightPublications.get(fileSystem);
  if (!paths) {
    paths = new Map();
    inFlightPublications.set(fileSystem, paths);
  }
  let counts = paths.get(path);
  if (!counts) {
    counts = new Map();
    paths.set(path, counts);
  }
  counts.set(raw, (counts.get(raw) ?? 0) + 1);
}

export function forgetInFlightPublications(
  path: string,
  fileSystem: LockFileSystem,
  publications: Set<string>,
): void {
  const paths = inFlightPublications.get(fileSystem);
  const counts = paths?.get(path);
  for (const raw of publications) {
    const remaining = (counts?.get(raw) ?? 0) - 1;
    if (remaining > 0) {
      counts?.set(raw, remaining);
    } else {
      counts?.delete(raw);
    }
  }
  if (!counts?.size) {
    paths?.delete(path);
  }
}

export function hasProtectedPublication(
  path: string,
  raw: string,
  fileSystem: LockFileSystem,
): boolean {
  return hasGenuineHold(path, raw, fileSystem) || hasInFlightPublication(path, raw, fileSystem);
}

// Once a genuine record is evicted, absent records no longer prove absence of a hold.
// One bit per filesystem keeps bounded bookkeeping conservative after either capacity is exceeded.
const genuineHoldOverflow = new WeakSet<LockFileSystem>();

function hasGenuineHold(path: string, raw: string, fileSystem: LockFileSystem): boolean {
  return (
    genuineHoldOverflow.has(fileSystem) ||
    genuineHolds.get(fileSystem)?.get(path)?.has(raw) === true
  );
}

export function rememberGenuineHold(path: string, raw: string, fileSystem: LockFileSystem): void {
  let paths = genuineHolds.get(fileSystem);
  if (!paths) {
    paths = new Map();
    genuineHolds.set(fileSystem, paths);
  }
  let holds = paths.get(path);
  if (!holds) {
    holds = new Set();
    paths.set(path, holds);
  }
  holds.add(raw);
  if (holds.size > PENDING_PUBLICATION_LIMIT) {
    genuineHoldOverflow.add(fileSystem);
    holds.delete(holds.values().next().value!);
  }
  if (paths.size > 64) {
    genuineHoldOverflow.add(fileSystem);
    paths.delete(paths.keys().next().value!);
  }
}

export function forgetGenuineHolds(
  path: string,
  fileSystem: LockFileSystem,
  forget: (raw: string) => boolean,
): void {
  const paths = genuineHolds.get(fileSystem);
  const holds = paths?.get(path);
  for (const raw of holds ?? []) {
    if (forget(raw)) {
      holds?.delete(raw);
    }
  }
  if (!holds?.size) {
    paths?.delete(path);
  }
}

/** @internal Test seam: does this filesystem object remember an unremoved doomed publication for the path? */
export function hasPendingBackOut(fileSystem: LockFileSystem, lockFilePath: string): boolean {
  return (pendingBackOuts.get(fileSystem)?.get(lockFilePath)?.publications.length ?? 0) > 0;
}

// List at most once per filesystem/PID/directory every five minutes (unless the clock
// moves backwards). Remember bounded own-PID candidates across lock basenames,
// prioritizing the listing acquire's basename before filling the remaining slots;
// each publishing acquire rechecks its candidates' names and ages before removal.
export const ownTmpSweeps = new WeakMap<
  LockFileSystem,
  Map<string, { listedAt: number; candidates: string[] }>
>();

// Bounded like ownTmpSweeps: oldest paths/publications/markers are evicted, and separate fs objects never share state.
export function rememberBackOut(
  path: string,
  fileSystem: LockFileSystem,
  publication?: DoomedPublication,
  marker?: string,
): void {
  let paths = pendingBackOuts.get(fileSystem);
  if (!paths) {
    paths = new Map();
    pendingBackOuts.set(fileSystem, paths);
  }
  let pending = paths.get(path);
  if (!pending) {
    pending = { publications: [], markers: new Set() };
    paths.set(path, pending);
  }
  const { publications, markers } = pending;
  // A SET per path: two openers of one process may strand different publications.
  if (publication && !publications.some((known) => isSamePublication(known, publication))) {
    publications.push(publication);
  }
  if (publications.length > PENDING_PUBLICATION_LIMIT) {
    publications.shift();
  }
  if (marker) {
    markers.add(marker);
  }
  if (markers.size > 8) {
    markers.delete(markers.values().next().value!);
  }
  if (paths.size > 64) {
    paths.delete(paths.keys().next().value!);
  }
}

export function forgetBackOuts(
  path: string,
  fileSystem: LockFileSystem,
  forget: (publication: DoomedPublication) => boolean,
): void {
  const paths = pendingBackOuts.get(fileSystem);
  const pending = paths?.get(path);
  if (!pending) {
    return;
  }
  pending.publications = pending.publications.filter((publication) => !forget(publication));
  if (!pending.publications.length && !pending.markers.size) {
    paths?.delete(path);
  }
}

export const lockState = { releaseMarkerCounter: 0, publicationCounter: 0 };
