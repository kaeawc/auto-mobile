import { isProcessRunning as defaultIsProcessRunning } from "../processLiveness";
import { logger } from "../logger";
import { type LockFileSystem } from "../lockFileSystem";
import { type IdGenerator } from "../IdGenerator";
import {
  type LockOwnerGenerationProbe,
  type LockOwnerGenerationVerdict,
} from "../../models/LockOwnerGeneration";
import { errorMessage } from "../describeUnknownError";
export type {
  LockOwnerGenerationProbe,
  LockOwnerGenerationVerdict,
} from "../../models/LockOwnerGeneration";

export const isProcessRunningWithDebug = (pid: number): boolean =>
  defaultIsProcessRunning(pid, { debugLog: logger.debug });

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

// Count own-tmp unlink attempts, including failures, across the entire acquire attempt.
export const OWN_TMP_SWEEP_LIMIT = 8;

export const OWN_TMP_SWEEP_INTERVAL_MS = 300_000;

export const OWN_TMP_SWEEP_CANDIDATE_LIMIT = 64;

export const OWN_TMP_SWEEP_DIRECTORY_LIMIT = 64;

export const BACK_OUT_RETRY_LIMIT = 3;

/**
 * A publication this process linked at P and was told it does not hold, not yet verifiably removed.
 * An atomic publication carries its identity (the tmp inode it was linked from); a legacy wx
 * publication has none and is known by its bytes alone.
 */
export interface DoomedPublication {
  raw: string;
  ino?: bigint;
  mtimeMs?: number;
}

export interface LockAttemptOptions extends ExclusiveLockOptions {
  publications: Set<string>;
}

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

export interface LockStep {
  op: keyof LockFileSystem;
  path: string;
}

export type Steps<T> = Generator<LockStep, T, void>;

export function finishLockSteps<T>(steps: Steps<T>): T {
  let result = steps.next();
  while (!result.done) {
    result = steps.next();
  }
  return result.value;
}

export interface LockSample {
  ino: bigint;
  mtimeMs: number;
  raw: string;
}

export function isReclaimable(observed: LockSample, options: ExclusiveLockOptions): boolean {
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

export function sameSample(left: LockSample | undefined, right: LockSample): boolean {
  return left?.ino === right.ino && left.mtimeMs === right.mtimeMs && left.raw === right.raw;
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

export function hasIdentity(publication: DoomedPublication): publication is LockSample {
  return publication.ino !== undefined && publication.mtimeMs !== undefined;
}

export function isSamePublication(left: DoomedPublication, right: DoomedPublication): boolean {
  return left.raw === right.raw && left.ino === right.ino && left.mtimeMs === right.mtimeMs;
}

export function toSample(publication: DoomedPublication): LockSample {
  // No real file has inode -1, and the NaN mtime never equals any sample's, this one's included.
  return { raw: publication.raw, ino: publication.ino ?? -1n, mtimeMs: publication.mtimeMs ?? NaN };
}

export function isOwnLockContent(
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

export function captureLockOwnerGeneration(
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
