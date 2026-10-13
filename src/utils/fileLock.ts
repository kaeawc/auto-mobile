import { createHash } from "node:crypto";
import { defaultIdGenerator, type IdGenerator } from "./IdGenerator";
import { nodeLockFileSystem, type LockFileSystem } from "./lockFileSystem";
import { basename, dirname } from "path";
import { isProcessRunning as defaultIsProcessRunning } from "./processLiveness";
import { errorMessage } from "./describeUnknownError";
import { logger } from "./logger";
import { toActionableError } from "../models/ActionableError";

const isProcessRunningWithDebug = (pid: number): boolean =>
  defaultIsProcessRunning(pid, { debugLog: logger.debug });

/** Verdict on whether a LIVE pid is still the process generation a lock recorded. */
export type LockOwnerGenerationVerdict = "same" | "different" | "unknown";
export interface LockOwnerGenerationProbe {
  /** Token for a lock pid is taking now; undefined when unavailable. Must not throw. */
  current(pid: number): string | undefined;
  /** Compare a live pid with its recorded token; unknown means unreadable/incomparable. Must not throw. */
  compare(pid: number, recorded: string): LockOwnerGenerationVerdict;
}

/**
 * The canonical cross-process file-lock primitive (issue #2794).
 *
 * A fully written lock file published atomically via an exclusive hard link holding the owner
 * PID. Two racers can't both win — the atomic create decides — and a lock left
 * by a dead holder is reclaimed via PID liveness or a provably different OS
 * generation. Line 2 is the owner token, line 3 metadata, and line 4 the optional
 * OS generation token; older locks retain PID-only liveness behavior.
 *
 * Both `DaemonManager` (start/stop coordination, non-blocking single attempt)
 * and the DB `FileMigrationLock` (bounded busy-wait) build on this so there is
 * "one canonical primitive per concern" rather than two copies of the subtle
 * `O_EXCL` + stale-reclaim logic.
 */

// Legacy/corrupt ownerless files are reclaimable only after this grace period.
// Atomic publication never exposes an empty lock; the fallback retains the old window.
export const OWNERLESS_LOCK_RECLAIM_AGE_MS = 10_000;
// Guards cover a synchronous burst; tokenless/corrupt crash remnants get the same grace.
export const RECLAIM_GUARD_ABANDON_AGE_MS = OWNERLESS_LOCK_RECLAIM_AGE_MS;
export const RECLAIM_GUARD_SLOT_LIMIT = 64;
// Count unlink attempts, including failures, across the entire acquire attempt.
export const OWN_TMP_SWEEP_LIMIT = 8;

export interface ExclusiveLockOptions {
  /** Optional synchronous filesystem seam; defaults to node fs. */
  fileSystem?: LockFileSystem;
  /** Collision-resistant private publication names (defaults to the module-level NodeIdGenerator). */
  idGenerator?: IdGenerator;
  /** Clock for ownerless-lock and abandoned-guard age checks (defaults to Date.now). */
  now?: () => number;
  /** Reclaim ownerless locks strictly older than this bound; defaults to 10 seconds. */
  ownerlessReclaimAgeMs?: number;
  /** Owner PID written into the lock file (defaults to `process.pid`). */
  pid?: number;
  /** Liveness check for stale-lock reclaim (defaults to `process.kill(pid, 0)`). */
  isProcessRunning?: (pid: number) => boolean;
  /**
   * When true, a lock file already owned by *this* PID is treated as a stale
   * leak from a crashed prior incarnation and reclaimed, instead of "held".
   *
   * Safe only where the caller guarantees a single in-process acquirer (e.g. the
   * migration singleton, whose `runMigrations` never runs twice concurrently in
   * one process): it removes the deterministic timeout hang that would otherwise
   * occur when a supervisor restarts a crashed process and the OS recycles the
   * same PID. The daemon coordinator leaves this `false` so a same-PID probe from
   * another manager instance still reads as held.
   *
   * See {@link ownerToken}: pairing this with a per-process-instance token narrows
   * the reclaim to a *genuine* recycled-PID leak, so an in-process reopen while
   * this process still holds the lock waits instead of stealing it (#2947).
   */
  reclaimOwnPid?: boolean;

  /**
   * A per-process-instance token written on the second line of the lock file
   * (below the PID). It disambiguates the two ways a same-PID lock can arise under
   * {@link reclaimOwnPid}:
   *
   * - token matches ours → a *live in-flight* acquire by THIS same process
   *   instance (e.g. an in-process same-path reopen while the prior generation's
   *   migration still holds the lock). Read as held so the reopen WAITS rather
   *   than stealing it and running two migrators on one DB file (#2947).
   * - token differs (or is absent, a pre-token incarnation) → a genuine stale leak
   *   from a crashed prior incarnation whose PID the OS recycled. Reclaimed, exactly
   *   as before (#2794 behavior preserved).
   *
   * Only consulted for the same-PID reclaim decision. When omitted, `reclaimOwnPid`
   * behaves exactly as it did before this token existed (any same-PID lock is a
   * reclaimable leak). The PID stays on the first line so daemon liveness reads and
   * {@link releaseExclusiveLock}'s PID compare are unaffected. The positional format
   * ("line 1 = bare integer PID, line 2 = token") is centralized in the
   * {@link formatLockContent} / {@link parseLockContent} pair, so additional
   * fields are added there and cannot silently move the PID off line 1 (#3006).
   *
   * Must be a NON-EMPTY, single-line, whitespace-free token (a UUID satisfies
   * this). The lock body is `trim()`-ed on read to tolerate a trailing newline, so
   * a token with surrounding whitespace — or an empty string — would be mangled or
   * dropped and read back as "no token". The only caller passes a `randomUUID()`
   * from `IdGenerator`; a future caller must uphold the same shape.
   */
  ownerToken?: string;

  /**
   * Optional single-line metadata written on line 3 of the lock file. It is
   * opaque to this primitive; callers that need to preserve arbitrary data must
   * encode it before passing it here.
   */
  metadata?: string;
  /** Omitted retains PID-only behavior and writes no generation line. */
  ownerGeneration?: LockOwnerGenerationProbe;
}

/**
 * The parsed contents of a lock file.
 *
 * The on-disk format is positional and MUST keep line 1 a bare integer PID so
 * `parseInt`-based readers (daemon liveness, and historically {@link releaseExclusiveLock})
 * stay correct; the per-process token, when present, is line 2. This helper pair
 * ({@link formatLockContent} / {@link parseLockContent}) is the single place that
 * encodes that contract: metadata is line 3 and OS generation is line 4. Line 1 stays a
 * bare integer by construction rather than by every call site remembering to
 * (issue #3006, follow-up 2).
 */
export interface LockContent {
  /** Owner PID (line 1). `NaN` when the PID line is not a readable integer. */
  pid: number;
  /** Per-process-instance token (line 2), or `undefined` when absent. */
  token: string | undefined;
  /** Optional caller-defined metadata (line 3). */
  metadata?: string;
  /** Optional OS process-generation token (line 4). */
  generation?: string;
}

/**
 * Serialize a lock file body. PID on line 1 (bare integer, always), token on an
 * optional line 2, opaque metadata on line 3, and OS generation on line 4. Inverse of
 * {@link parseLockContent}. Centralizes the positional format so a future field
 * can't silently move the PID off line 1 (#3006).
 */
export function formatLockContent(
  pid: number,
  ownerToken?: string,
  metadata?: string,
  generation?: string,
): string {
  if (generation !== undefined) {
    return `${pid}\n${ownerToken ?? ""}\n${metadata ?? ""}\n${generation}`;
  }
  if (metadata === undefined) {
    return ownerToken === undefined ? String(pid) : `${pid}\n${ownerToken}`;
  }
  return `${pid}\n${ownerToken ?? ""}\n${metadata}`;
}

/**
 * Parse a lock file body (already `trim()`-ed by the caller) into its PID and
 * optional token, metadata, and generation. Line 1 is parsed as an integer PID (`NaN` when
 * unreadable); line 2, if present, is the token; line 3 is caller-defined
 * metadata; line 4 is the OS generation token. Inverse of {@link formatLockContent} (#3006).
 */
export function parseLockContent(content: string): LockContent {
  const [pidLine, tokenLine, metadataLine, generationLine] = content.split("\n", 4);
  const rawPid = Number.parseInt(pidLine, 10);
  // A PID <= 0 is never a real single-process owner: `process.kill(0, 0)`
  // signals the current process group and `process.kill(-1, 0)` signals
  // every process this user can signal, so both "succeed" as a liveness
  // check without naming a real process. Treat a corrupt/stale lock
  // containing one the same as an unreadable PID (NaN) rather than ever
  // reporting it as a live owner or surfacing it in a `kill` suggestion
  // (issue #6260).
  const pid = Number.isInteger(rawPid) && rawPid > 0 ? rawPid : NaN;
  const parsed: LockContent = {
    pid,
    token: tokenLine || undefined,
  };
  if (metadataLine) {
    parsed.metadata = metadataLine;
  }
  if (generationLine) {
    parsed.generation = generationLine;
  }
  return parsed;
}

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

export interface LockStep {
  op: keyof LockFileSystem;
  path: string;
}

type Steps<T> = Generator<LockStep, T, void>;

function finishLockSteps<T>(steps: Steps<T>): T {
  let result = steps.next();
  while (!result.done) {
    result = steps.next();
  }
  return result.value;
}

/** Test scheduling seam: yields BEFORE every fs operation. Production must drive it synchronously. */
export function* acquireExclusiveLockSteps(
  lockFilePath: string,
  options: ExclusiveLockOptions = {},
): Steps<boolean> {
  const pid = options.pid ?? process.pid;
  const fileSystem = options.fileSystem ?? nodeLockFileSystem;
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

function* sweepOwnPublicationTmps(path: string, options: ExclusiveLockOptions): Steps<void> {
  const fileSystem = options.fileSystem ?? nodeLockFileSystem;
  const directory = dirname(path);
  let names: string[];
  try {
    yield { op: "list", path: directory };
    names = fileSystem.list(directory);
  } catch (error) {
    // Optional litter cleanup can be skipped safely when the directory is missing/unreadable.
    logger.debug(`Lock tmp listing unavailable at ${directory}: ${errorMessage(error)}`, error);
    return;
  }
  const pid = String(options.pid ?? process.pid);
  const prefix = `${basename(path)}.`;
  // Parse from the end: a guard prefix's fractional mtime may itself contain dots.
  const publicationName = /^.+\.(\d+)\.\d+\.[^.]+\.tmp$/;
  let attempts = 0;
  for (const name of names.sort()) {
    if (!name.startsWith(prefix) || publicationName.exec(name)?.[1] !== pid) {
      continue;
    }
    const tmp = path.slice(0, path.length - basename(path).length) + name;
    if (!(yield* isAbandonedPublicationTmp(tmp, options))) {
      continue;
    }
    yield* cleanupFile(tmp, fileSystem);
    if (++attempts === OWN_TMP_SWEEP_LIMIT) {
      break;
    }
  }
}

function* isAbandonedPublicationTmp(path: string, options: ExclusiveLockOptions): Steps<boolean> {
  try {
    yield { op: "stat", path };
    const { mtimeMs } = (options.fileSystem ?? nodeLockFileSystem).stat(path);
    return (options.now ?? Date.now)() - mtimeMs > RECLAIM_GUARD_ABANDON_AGE_MS;
  } catch (error) {
    // A vanished/unreadable tmp can be left safely; publication never depends on cleanup.
    logger.debug(`Lock tmp age unavailable at ${path}: ${errorMessage(error)}`, error);
    return false;
  }
}

interface LockSample {
  ino: number;
  mtimeMs: number;
  raw: string;
}

function* sampleLock(path: string, fileSystem: LockFileSystem): Steps<LockSample | undefined> {
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

function isReclaimable(observed: LockSample, options: ExclusiveLockOptions): boolean {
  const owner = parseLockContent(observed.raw.trim());
  if (Number.isNaN(owner.pid)) {
    const age = (options.now ?? Date.now)() - observed.mtimeMs;
    return age >= 0 && age > (options.ownerlessReclaimAgeMs ?? OWNERLESS_LOCK_RECLAIM_AGE_MS);
  }
  return (
    isOwnStaleLock(
      owner.pid,
      owner.token,
      options.pid ?? process.pid,
      options.ownerToken,
      options.reclaimOwnPid ?? false,
    ) ||
    !(options.isProcessRunning ?? isProcessRunningWithDebug)(owner.pid) ||
    compareLockOwnerGeneration(options.ownerGeneration, owner.pid, owner.generation) === "different"
  );
}

function sameSample(left: LockSample | undefined, right: LockSample): boolean {
  return left?.ino === right.ino && left.mtimeMs === right.mtimeMs && left.raw === right.raw;
}

function guardPrefix(path: string, sample: LockSample): string {
  const hash = createHash("sha256").update(sample.raw).digest("hex").slice(0, 32);
  // Numeric/hash suffixes never end in .lock/.pid/.sock/.json/.forward; directory scans ignore them.
  return `${path}.reclaim.${sample.ino}.${sample.mtimeMs}.${hash}`;
}

function* readText(path: string, fileSystem: LockFileSystem): Steps<string | undefined> {
  try {
    yield { op: "readText", path };
    return fileSystem.readText(path);
  } catch (error) {
    // A vanished/unreadable file proves no ownership; callers conservatively back off.
    logger.debug(`Lock read failed at ${path}: ${errorMessage(error)}`, error);
    return undefined;
  }
}

function* claimLockMarker(
  path: string,
  marker: string,
  fileSystem: LockFileSystem,
): Steps<boolean> {
  try {
    yield { op: "rename", path };
    fileSystem.rename(path, marker);
    return true;
  } catch (error) {
    // A concurrent release may have removed the instance; a failed claim means retrying.
    logger.debug(`Lock rename failed at ${path}: ${errorMessage(error)}`, error);
    return false;
  }
}

function isOwnStaleLock(
  ownerPid: number,
  tokenLine: string | undefined,
  pid: number,
  ownerToken: string | undefined,
  reclaimOwnPid: boolean,
): boolean {
  // A same-PID lock is a reclaimable stale leak ONLY when its owner token differs
  // from ours (a crashed prior incarnation whose PID the OS recycled) or is absent
  // (a pre-token incarnation). A MATCHING token means this same process instance
  // still holds it live — an in-process reopen must wait, not steal it (#2947).
  // With no token supplied the pre-token semantics stand: any same-PID lock leaks.
  return (
    reclaimOwnPid &&
    ownerPid === pid &&
    (ownerToken === undefined || (tokenLine ?? "") !== ownerToken)
  );
}

interface ReclaimGuard {
  k: number;
  content: string;
  compacted: boolean;
}

/**
 * Exclusive links arbitrate the first free slot. A superseder revalidates every
 * remembered dead slot before becoming holder; only that holder may replace
 * slot 0 or remove lower slots. Slot 0 stays present throughout compaction, so
 * old ascenders fail revalidation and new observers see our live guard.
 * Descending cleanup preserves a contiguous chain for a lone claimant's crash.
 * Per instance, quiescent guards are bounded by one plus crashes inside the
 * supersession window since the last completed supersession; each running
 * claimant adds at most one (two during install/top removal). After successful
 * compaction, critical-section crashes leave one slot 0 until guard release;
 * a completed reclaim cleans its visible chain.
 * With slot 0 already dead, 63 consecutive supersession-window crashes can
 * fill the 64-slot cap without a completed supersession. R1/R2 remain unchanged. R3 (a live but aged-out owner)
 * is outside this invariant; content-checked release narrows, not eliminates it.
 */
function* claimReclaimGuard(
  prefix: string,
  options: ExclusiveLockOptions,
  generation: string | undefined,
): Steps<ReclaimGuard | undefined> {
  const fileSystem = options.fileSystem ?? nodeLockFileSystem;
  const pid = options.pid ?? process.pid;
  const content = formatLockContent(pid, options.ownerToken, undefined, generation);
  const lower: LockSample[] = [];
  for (let k = 0; k < RECLAIM_GUARD_SLOT_LIMIT; k++) {
    const path = `${prefix}.${k}`;
    const published = yield* publishReclaimGuard(
      path,
      content,
      pid,
      fileSystem,
      options.idGenerator,
    );
    if (published === "created") {
      if (!(yield* revalidateGuardSlots(prefix, lower, fileSystem))) {
        yield* releaseGuard(path, content, fileSystem);
        return undefined;
      }
      const compacted = k > 0 && (yield* compactGuard(prefix, k, content, options));
      return { k, content, compacted };
    }
    if (published === "failed") {
      return undefined;
    }
    const guard = yield* sampleLock(path, fileSystem);
    if (guard === undefined || isGuardLive(guard, options)) {
      return undefined;
    }
    lower.push(guard);
  }
  logger.warn(`Reclaim guard chain exhausted at ${prefix}`);
  return undefined;
}

function* revalidateGuardSlots(
  prefix: string,
  lower: LockSample[],
  fileSystem: LockFileSystem,
): Steps<boolean> {
  for (const [k, remembered] of lower.entries()) {
    if (!sameSample(yield* sampleLock(`${prefix}.${k}`, fileSystem), remembered)) {
      return false;
    }
  }
  return true;
}

function* releaseGuard(path: string, content: string, fileSystem: LockFileSystem): Steps<boolean> {
  const current = yield* readText(path, fileSystem);
  if (current !== content) {
    // An aged-out actor must leave a successor's guard (or unreadable path) alone.
    logger.debug(`Reclaim guard release skipped at ${path}: content changed or unavailable`);
    return false;
  }
  return yield* unlinkGuard(path, fileSystem);
}

function* unlinkGuard(path: string, fileSystem: LockFileSystem): Steps<boolean> {
  try {
    yield { op: "unlink", path };
    fileSystem.unlink(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      // Already absent means this cleanup has completed.
      logger.debug(`Reclaim guard already removed at ${path}: ${errorMessage(error)}`);
      return true;
    }
    logger.warn(`Reclaim guard removal failed at ${path}: ${errorMessage(error)}`, error);
    return false;
  }
}

function* installGuard(
  path: string,
  content: string,
  options: ExclusiveLockOptions,
): Steps<boolean> {
  const fileSystem = options.fileSystem ?? nodeLockFileSystem;
  const pid = options.pid ?? process.pid;
  const idGenerator = options.idGenerator ?? defaultIdGenerator;
  const tmp = `${path}.${pid}.${++publicationCounter}.${idGenerator.next()}.tmp`;
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

function* compactGuard(
  prefix: string,
  k: number,
  content: string,
  options: ExclusiveLockOptions,
): Steps<boolean> {
  const fileSystem = options.fileSystem ?? nodeLockFileSystem;
  if (!(yield* installGuard(`${prefix}.0`, content, options))) {
    return false;
  }
  if (yield* releaseGuard(`${prefix}.${k}`, content, fileSystem)) {
    for (let lower = k - 1; lower > 0; lower--) {
      if (!(yield* unlinkGuard(`${prefix}.${lower}`, fileSystem))) {
        break;
      }
    }
  }
  return true;
}

function isGuardLive(guard: LockSample, options: ExclusiveLockOptions): boolean {
  const owner = parseLockContent(guard.raw.trim());
  if (!Number.isNaN(owner.pid)) {
    // A guard owned by this process is live unless generation evidence disproves it,
    // or unknown evidence ages out below; reclaimOwnPid alone never supersedes it.
    if (
      owner.pid !== (options.pid ?? process.pid) &&
      !(options.isProcessRunning ?? isProcessRunningWithDebug)(owner.pid)
    ) {
      return false;
    }
    const verdict = compareLockOwnerGeneration(
      options.ownerGeneration,
      owner.pid,
      owner.generation,
    );
    if (verdict !== "unknown") {
      return verdict === "same"; // Positive OS evidence never ages out a stalled live reclaimer.
    }
  }
  // R3: without positive generation evidence, a LIVE reclaimer suspended beyond this
  // bound between its under-guard sample and rename can be superseded, then rename a
  // successor's lock. The post-rename fingerprint check and non-clobbering restore
  // remain defence in depth. Empty/unparseable legacy guards share this age rule.
  // Content-checked guard release leaves an installed successor alone, but its
  // read/unlink is not atomic and cannot close all of this out-of-scope R3 window.
  // Negative age keeps the guard live; a missing/unreadable sample backs off above.
  const age = (options.now ?? Date.now)() - guard.mtimeMs;
  return !(age > RECLAIM_GUARD_ABANDON_AGE_MS);
}

function* reclaimExclusiveLock(
  lockFilePath: string,
  options: ExclusiveLockOptions,
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
    return (yield* writeExclusiveLockFile(lockFilePath, pid, options, false)).acquired;
  } finally {
    yield* releaseGuard(`${prefix}.${guard.k}`, guard.content, fileSystem);
    if (guard.compacted) {
      yield* releaseGuard(`${prefix}.0`, guard.content, fileSystem);
    }
  }
}

function* restoreDisplacedLock(
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
        yield* renameDisplacedLock(path, marker, fileSystem);
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

function* renameDisplacedLock(
  path: string,
  marker: string,
  fileSystem: LockFileSystem,
): Steps<void> {
  try {
    yield { op: "exists", path };
    if (fileSystem.exists(path)) {
      // A failed copy may have left a partial destination that cleanup could not remove.
      logger.warn(`Displaced lock last-resort restore blocked at ${path}; retaining ${marker}`);
      return;
    }
    yield { op: "rename", path: marker };
    fileSystem.rename(marker, path);
  } catch (error) {
    logger.warn(
      `Displaced lock last-resort restore failed at ${path}: ${errorMessage(error)}`,
      error,
    );
    // Leave the marker if even rename fails: it is the only copy of a possibly
    // live owner's lock. Deleting it would silently free that held lock.
  }
}

function* cleanupFile(path: string, fileSystem: LockFileSystem): Steps<void> {
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

function* removeStaleLockMarker(path: string, fileSystem: LockFileSystem): Steps<void> {
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

/**
 * Read the PID recorded in an exclusive lock file without attempting to
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
  let content: string;
  try {
    content = fileSystem.readText(lockFilePath).trim();
  } catch (error) {
    logger.debug(`src/utils/fileLock.ts readLockOwnerPid: lock unreadable: ${error}`, error);
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
 * Read and parse an exclusive lock file without acquiring or reclaiming it.
 * Returns `undefined` when the file is missing, unreadable, or empty.
 */
export function readExclusiveLockContent(
  lockFilePath: string,
  fileSystem: LockFileSystem = nodeLockFileSystem,
): LockContent | undefined {
  const content = finishLockSteps(readText(lockFilePath, fileSystem))?.trim();
  if (content === undefined || content.length === 0) {
    return undefined;
  }
  return parseLockContent(content);
}

/**
 * Take over a lock held by a LIVE owner the caller has judged stale by some
 * out-of-band evidence (issue #10497: the owner reported no live session, or
 * its control socket is unreachable). The takeover only succeeds when the lock
 * still holds exactly the observed owner's PID and token. Removal is guarded by
 * the sampled file identity just like dead-owner reclaim. R2: a live owner's own
 * release racing takeover retains the residual window documented in release.
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
  const sample = yield* sampleLock(path, options.fileSystem ?? nodeLockFileSystem);
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
  let content: string;
  try {
    yield { op: "readText", path: lockFilePath };
    content = fileSystem.readText(lockFilePath).trim();
  } catch (error) {
    // Lock file is already gone (released concurrently, or never existed); there is
    // nothing left to release, so returning is a no-op, not a failure.
    logger.debug(`src/utils/fileLock.ts fallback failed: ${error}`, error);
    return;
  }

  if (!isOwnLockContent(parseLockContent(content), pid, ownerToken)) {
    // The lock is no longer ours — do not delete another opener's file.
    return;
  }

  // A live owner's lock can now be taken over (#10497), so the read above may
  // already be stale: a taker could replace the file between that read and an
  // unlink-by-path, which would delete the TAKER's lock. Claim the exact file
  // instance by renaming it to a unique marker, verify the marker is ours, and
  // only then delete it; a displaced foreign lock is restored instead.
  // POSIX has no compare-and-unlink, so a residual window remains: a releaser
  // whose read predates a completed takeover can rename the taker's lock away
  // and a third fresh acquirer can win before the restore. Forwarding-lease
  // owners that answer their socket therefore release on request instead of
  // being taken over (#10506 review); only an unreachable or orphaned owner is
  // taken over while live.
  const releaseMarker = `${lockFilePath}.${pid}.release.${++releaseMarkerCounter}`;
  try {
    yield { op: "rename", path: lockFilePath };
    fileSystem.rename(lockFilePath, releaseMarker);
  } catch (error) {
    // Already gone (released or taken over and removed); nothing of ours remains.
    logger.debug(`src/utils/fileLock.ts: release rename found no lock: ${error}`);
    return;
  }
  let claimed: LockContent | undefined;
  try {
    yield { op: "readText", path: releaseMarker };
    claimed = parseLockContent(fileSystem.readText(releaseMarker).trim());
  } catch (error) {
    logger.warn(`src/utils/fileLock.ts: release marker unreadable at ${releaseMarker}: ${error}`);
  }
  if (claimed === undefined || !isOwnLockContent(claimed, pid, ownerToken)) {
    yield* restoreDisplacedLock(lockFilePath, releaseMarker, fileSystem);
    return;
  }
  try {
    yield { op: "unlink", path: releaseMarker };
    fileSystem.unlink(releaseMarker);
  } catch (error) {
    logger.warn(
      `src/utils/fileLock.ts: failed to release exclusive lock at ${lockFilePath}: ${errorMessage(error)}`,
    );
    // The lock could not be deleted, so put it back rather than strand it under
    // the marker name; linking never clobbers a lock someone took meanwhile.
    try {
      yield { op: "link", path: lockFilePath };
      fileSystem.link(releaseMarker, lockFilePath);
    } catch (restoreError) {
      logger.warn(`src/utils/fileLock.ts: could not restore unreleased lock: ${restoreError}`);
    }
  }
}

let releaseMarkerCounter = 0;

function isOwnLockContent(
  content: LockContent,
  pid: number,
  ownerToken: string | undefined,
): boolean {
  if (content.pid !== pid) {
    return false;
  }
  // Incarnation check: with a token supplied, a same-PID lock bearing a DIFFERENT
  // token belongs to another incarnation that recycled our PID — leave it. A lock
  // with no token line predates tokens and is treated as ours (PID match).
  return ownerToken === undefined || content.token === undefined || content.token === ownerToken;
}

type Publication = "created" | "contended" | { error: unknown };
let publicationCounter = 0;

/** One publication protocol for locks and guards: complete private bytes, then exclusive link. */
function* publishFile(
  path: string,
  content: string,
  pid: number,
  fileSystem: LockFileSystem,
  idGenerator: IdGenerator = defaultIdGenerator,
): Steps<Publication> {
  const tmp = `${path}.${pid}.${++publicationCounter}.${idGenerator.next()}.tmp`;
  let linking = false;
  try {
    // A recycled name may still alias a live lock inode; unlink before exclusive create.
    yield* cleanupFile(tmp, fileSystem);
    yield { op: "writeFile", path: tmp };
    fileSystem.writeFile(tmp, content);
    yield { op: "link", path };
    linking = true;
    fileSystem.link(tmp, path);
    return "created";
  } catch (error) {
    if (linking && (error as NodeJS.ErrnoException).code === "EEXIST") {
      // Exclusive link contention is expected and never overwrites an owner.
      logger.debug(`Lock publication contended at ${path}: ${errorMessage(error)}`);
      return "contended";
    }
    logger.warn(`Atomic lock publication failed at ${path}: ${errorMessage(error)}`, error);
    return { error };
  } finally {
    yield* cleanupFile(tmp, fileSystem);
  }
}

function* writeExclusiveLockFile(
  path: string,
  pid: number,
  options: ExclusiveLockOptions,
  sweep = true,
): Steps<{ acquired: boolean; generation: string | undefined; swept: boolean }> {
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
    const publication = yield* publishFile(path, content, pid, fileSystem, options.idGenerator);
    if (typeof publication === "string") {
      return { acquired: publication === "created", generation, swept: sweep };
    }
    return {
      acquired: yield* writeLegacyLock(path, content, fileSystem),
      generation,
      swept: sweep,
    };
  } catch (error) {
    // Genuine IO failures are not contention (#3623).
    throw toActionableError(error, `Failed to create exclusive lock file at ${path}`);
  }
}

function* publishReclaimGuard(
  path: string,
  content: string,
  pid: number,
  fileSystem: LockFileSystem,
  idGenerator: IdGenerator = defaultIdGenerator,
): Steps<"created" | "contended" | "failed"> {
  const publication = yield* publishFile(path, content, pid, fileSystem, idGenerator);
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

function* writeLegacyLock(
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

export function compareLockOwnerGeneration(
  probe: LockOwnerGenerationProbe | undefined,
  pid: number,
  recorded: string | undefined,
): LockOwnerGenerationVerdict {
  if (probe === undefined || recorded === undefined) {
    return "unknown";
  }
  try {
    return probe.compare(pid, recorded);
  } catch (error) {
    // An unreadable sample proves nothing, so retaining the lock is safe.
    logger.debug(`Lock owner generation comparison unavailable: ${errorMessage(error)}`);
    return "unknown";
  }
}

function captureLockOwnerGeneration(
  probe: LockOwnerGenerationProbe | undefined,
  pid: number,
): string | undefined {
  try {
    const token = probe?.current(pid);
    if (
      token !== undefined &&
      (token.length === 0 || token.includes("\n") || token.includes("\r"))
    ) {
      logger.debug("Ignoring invalid single-line lock owner generation token");
      return undefined;
    }
    return token;
  } catch (error) {
    // Optional capture may fail safely: a tokenless lock retains PID-only protection.
    logger.debug(`Lock owner generation capture unavailable: ${errorMessage(error)}`);
    return undefined;
  }
}
