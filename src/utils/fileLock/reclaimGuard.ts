import {
  type LockSample,
  type ExclusiveLockOptions,
  type Steps,
  formatLockContent,
  RECLAIM_GUARD_SLOT_LIMIT,
  sameSample,
  parseLockContent,
  isProcessRunningWithDebug,
  compareLockOwnerGeneration,
  RECLAIM_GUARD_ABANDON_AGE_MS,
} from "./contracts";
import { createHash } from "node:crypto";
import { nodeLockFileSystem, type LockFileSystem } from "../lockFileSystem";
import { publishReclaimGuard, sampleLock, retryLockStep, installGuard } from "./fileSystem";
import { logger } from "../logger";
import { errorMessage } from "../describeUnknownError";

export function guardPrefix(path: string, sample: LockSample): string {
  const hash = createHash("sha256").update(sample.raw).digest("hex").slice(0, 32);
  // Numeric/hash suffixes never end in .lock/.pid/.sock/.json/.forward; directory scans ignore them.
  // The inode keeps its rounded number spelling so every version names the same guard;
  // the mtime and content hash still tell distinct samples apart.
  return `${path}.reclaim.${Number(sample.ino)}.${sample.mtimeMs}.${hash}`;
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
export function* claimReclaimGuard(
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
    const published = yield* publishReclaimGuard(path, content, pid, {
      fileSystem,
      idGenerator: options.idGenerator,
    });
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

export function* releaseGuard(
  path: string,
  content: string,
  fileSystem: LockFileSystem,
): Steps<boolean> {
  const read = yield* retryLockStep({ op: "readText", path }, () => fileSystem.readText(path));
  const current = typeof read === "string" ? undefined : read.value;
  if (current !== content) {
    // An aged-out actor must leave a successor's guard (or unreadable path) alone.
    logger.debug(`Reclaim guard release skipped at ${path}: content changed or unavailable`);
    return false;
  }
  return yield* unlinkGuard(path, fileSystem);
}

function* unlinkGuard(path: string, fileSystem: LockFileSystem): Steps<boolean> {
  let lastError: unknown;
  const result = yield* retryLockStep({ op: "unlink", path }, () => {
    try {
      fileSystem.unlink(path);
    } catch (error) {
      lastError = error;
      throw error;
    }
  });
  if (typeof result !== "string") {
    return true;
  }
  if (result === "missing") {
    // Already absent means this cleanup has completed.
    logger.debug(`Reclaim guard already removed at ${path}: ${errorMessage(lastError)}`);
    return true;
  }
  logger.warn(`Reclaim guard removal failed at ${path}: ${errorMessage(lastError)}`, lastError);
  return false;
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
