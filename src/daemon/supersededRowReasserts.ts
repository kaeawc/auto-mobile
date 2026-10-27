import { exponentialBackoff, type BackoffPolicy } from "../utils/Backoff";
import type { Logger } from "../utils/logger";
import type { Timer } from "../utils/SystemTimer";
import type { Session, SessionReleaseSnapshot } from "./sessionManager";

/**
 * Retries of a live row's rewrite over its superseded release's terminal row (#11557): one failed
 * write (a busy database) must not leave the live session behind a terminal row. Bounded; after
 * the last one the rewrite stays owed and the session's next activity write issues it again.
 */
export const SUPERSEDED_ROW_REASSERT_RETRY_ATTEMPTS = 5;
export const DEFAULT_SUPERSEDED_ROW_REASSERT_BACKOFF: BackoffPolicy = exponentialBackoff({
  initialDelayMs: 250,
  maxDelayMs: 5_000,
});

/** The session incarnation a ledger entry belongs to; compared by identity. */
export interface SupersededRowIncarnation {
  readonly sessionId: string;
}

/** Row policy of an owed rewrite stays with its caller; the ledger only schedules it. */
export interface OwedSupersededRowReassertCallbacks<S extends SupersededRowIncarnation = Session> {
  /** Issue the owed rewrite again; resolves true when the live row was written. Never rejects. */
  retry(entry: OwedSupersededRowReassert<S>): Promise<boolean>;
  /** The drain's one attempt; `drainAttempted` is already set when this is called. */
  retryDuringDrain(entry: OwedSupersededRowReassert<S>): Promise<void>;
}

/** A live row's rewrite over its superseded release's terminal row that failed (#11557). */
export interface OwedSupersededRowReassert<S extends SupersededRowIncarnation = Session> {
  /** The incarnation the rewrite is owed to; a session revived under the UUID owes nothing. */
  session: S;
  /** Reasons of the superseded releases whose terminal row the rewrite may replace. */
  reasons: Set<string>;
  /** Failed attempts so far, the first write included. */
  attempt: number;
  /** The armed retry; absent while a retry runs and once the retries are exhausted. */
  handle?: NodeJS.Timeout;
  /** Already retried during shutdown's drain; a further failure is not retried again (#11058). */
  drainAttempted?: boolean;
  callbacks: OwedSupersededRowReassertCallbacks<S>;
}

/** A pending non-terminal release whose row still holds its session's superseded release's row. */
export interface SupersededRowReassertsCollaborators {
  timer: Timer;
  logger: Pick<Logger, "warn">;
  /** True once shutdown started draining releases (#11058). */
  draining(): boolean;
  /** Track a background write for shutdown's drain without wrapping its promise. */
  trackDrainWrite(write: Promise<void>): void;
}

/**
 * The superseded-row state of the row writer (#11799 W3): which superseded releases' terminal
 * rows a live row may be rewritten over, which rewrites are under way or owed, and the owed
 * rewrites' retry scheduling. Holds no I/O and no row policy: every statement, read and
 * precondition stays with the caller, which keeps its original await sequence.
 */
export class SupersededRowReasserts<S extends SupersededRowIncarnation = Session> {
  /** Own superseded releases can land late for this incarnation's entire lifetime (#11557). */
  private readonly rememberedReasons = new WeakMap<S, Set<string>>();
  /** Only the exact earlier reasons of this release may be replaced by its committed upgrade. */
  private readonly reasonPredecessors = new WeakMap<SessionReleaseSnapshot, readonly string[]>();
  /** A refused release wrote nothing, so superseding it owes no live-row rewrite. */
  private readonly refusedWrites = new WeakSet<SessionReleaseSnapshot>();
  /**
   * UUIDs whose live row this daemon is about to rewrite over a terminal row its own superseded
   * release wrote or may still write (#11206), counted per pending rewrite. While one is pending,
   * a terminal row under the live session is that release's, not the end of the UUID (#11498).
   */
  private readonly pendingReasserts = new Map<string, number>();
  /**
   * Pending non-terminal releases whose row still holds their session's superseded release's
   * terminal row (#11557): the retry of `release` replaces that row before it writes its own.
   */
  /**
   * The superseded releases' reasons whose terminal row a rewrite or a replacement under way is
   * replacing, one entry per write. Not the parked write's whole window: the row a peer or a
   * committed release wrote meanwhile is the UUID's end.
   */
  private readonly reasonsBeingRewritten = new Map<string, string[]>();
  /**
   * Rewrites that failed and are still owed (#11557): retried with the backoff, then by the
   * session's activity writes. While one is owed, its release's terminal row under the live
   * session is not the UUID's end.
   */
  private readonly owedReasserts = new Map<string, OwedSupersededRowReassert<S>>();
  private backoff: BackoffPolicy = DEFAULT_SUPERSEDED_ROW_REASSERT_BACKOFF;

  constructor(private readonly collaborators: SupersededRowReassertsCollaborators) {}

  setBackoff(backoff: BackoffPolicy): void {
    this.backoff = backoff;
  }

  /** Keep reasons beyond an owed entry's lifetime, without lending them to a same-UUID session. */
  remember(session: S, reasons: readonly string[]): readonly string[] {
    const remembered = this.rememberedReasons.get(session) ?? new Set<string>();
    for (const reason of reasons) {
      remembered.add(reason);
    }
    this.rememberedReasons.set(session, remembered);
    return [...remembered];
  }

  /** The superseded reasons remembered for this incarnation, without recording any. */
  remembered(session: S): ReadonlySet<string> | undefined {
    return this.rememberedReasons.get(session);
  }

  notePredecessors(upgraded: SessionReleaseSnapshot, from: SessionReleaseSnapshot): void {
    this.reasonPredecessors.set(upgraded, [
      ...(this.reasonPredecessors.get(from) ?? []),
      from.releaseReason,
    ]);
  }

  predecessors(snapshot: SessionReleaseSnapshot): readonly string[] {
    return this.reasonPredecessors.get(snapshot) ?? [];
  }

  noteRefused(snapshot: SessionReleaseSnapshot): void {
    this.refusedWrites.add(snapshot);
  }

  wasRefused(snapshot: SessionReleaseSnapshot): boolean {
    return this.refusedWrites.has(snapshot);
  }

  /**
   * Count a pending rewrite of `sessionId`'s row over the terminal row of the superseded releases
   * named by `supersededReasons`; the returned function ends it, once.
   */
  expectReassert(sessionId: string, supersededReasons: readonly string[] = []): () => void {
    const pending = this.pendingReasserts;
    pending.set(sessionId, (pending.get(sessionId) ?? 0) + 1);
    const reasons = this.reasonsBeingRewritten;
    if (supersededReasons.length > 0) {
      reasons.set(sessionId, [...(reasons.get(sessionId) ?? []), ...supersededReasons]);
    }
    let settled = false;
    return () => {
      if (settled) {
        return;
      }
      settled = true;
      const remaining = (pending.get(sessionId) ?? 1) - 1;
      if (remaining > 0) {
        pending.set(sessionId, remaining);
      } else {
        pending.delete(sessionId);
      }
      const left = reasons.get(sessionId) ?? [];
      for (const reason of supersededReasons) {
        const index = left.indexOf(reason);
        if (index >= 0) {
          left.splice(index, 1);
        }
      }
      if (left.length === 0) {
        reasons.delete(sessionId);
      }
    };
  }

  isReassertPending(sessionId: string): boolean {
    return this.pendingReasserts.has(sessionId);
  }

  isBeingRewritten(sessionId: string, releaseReason: string): boolean {
    return this.reasonsBeingRewritten.get(sessionId)?.includes(releaseReason) ?? false;
  }

  owed(sessionId: string): OwedSupersededRowReassert<S> | undefined {
    return this.owedReasserts.get(sessionId);
  }

  /**
   * Whether `releaseReason`, found under the live `session`, is its own superseded release's
   * terminal row with the rewrite still owed (#11557), rather than the end of the UUID.
   */
  isOwedFor(session: S, releaseReason: string): boolean {
    const owed = this.owedReasserts.get(session.sessionId);
    return owed?.session === session && owed.reasons.has(releaseReason);
  }

  /** Record a failed rewrite as owed and arm its next retry, while any are left (#11557). */
  owe(
    session: S,
    supersededReasons: readonly string[],
    callbacks: OwedSupersededRowReassertCallbacks<S>,
  ): void {
    supersededReasons = this.remember(session, supersededReasons);
    const sessionId = session.sessionId;
    const owed = this.owedReasserts.get(sessionId);
    const previous = owed?.session === session ? owed : undefined;
    if (owed?.handle !== undefined) {
      this.collaborators.timer.clearTimeout(owed.handle);
    }
    const entry: OwedSupersededRowReassert<S> = {
      session,
      reasons: new Set([...(previous?.reasons ?? []), ...supersededReasons]),
      attempt: (previous?.attempt ?? 0) + 1,
      drainAttempted: previous?.drainAttempted,
      callbacks,
    };
    this.owedReasserts.set(sessionId, entry);
    this.arm(entry);
  }

  private arm(entry: OwedSupersededRowReassert<S>): void {
    const draining = this.collaborators.draining();
    if (draining && !entry.drainAttempted) {
      // A timer armed during shutdown's drain would outlive the database (#11058): one attempt
      // now, which the drain awaits.
      this.collaborators.trackDrainWrite(this.retryDuringDrain(entry));
      return;
    }
    if (entry.attempt > SUPERSEDED_ROW_REASSERT_RETRY_ATTEMPTS || draining) {
      this.collaborators.logger.warn(
        `[SessionManager] The live row of session ${entry.session.sessionId} is still not ` +
          `re-persisted after ${entry.attempt} attempt(s); its next activity write retries it`,
      );
      return;
    }
    entry.handle = this.collaborators.timer.setTimeout(() => {
      entry.handle = undefined;
      this.collaborators.trackDrainWrite(entry.callbacks.retry(entry).then(() => {}));
    }, this.backoff.delayForAttempt(entry.attempt));
    entry.handle.unref?.();
  }

  /** An attempt that could not issue its write counts as a failed one. */
  defer(entry: OwedSupersededRowReassert<S>): void {
    if (this.owedReasserts.get(entry.session.sessionId) !== entry || entry.handle !== undefined) {
      return;
    }
    entry.attempt++;
    this.arm(entry);
  }

  drop(entry: OwedSupersededRowReassert<S>): void {
    if (entry.handle !== undefined) {
      this.collaborators.timer.clearTimeout(entry.handle);
      entry.handle = undefined;
    }
    if (this.owedReasserts.get(entry.session.sessionId) === entry) {
      this.owedReasserts.delete(entry.session.sessionId);
    }
  }

  /** The live row was written, or the session ended: nothing is owed to this incarnation. */
  settle(session: S): void {
    const owed = this.owedReasserts.get(session.sessionId);
    if (owed?.session === session) {
      this.drop(owed);
    }
  }

  /** Issue every owed rewrite now, skipping its backoff, and return the writes (shutdown). */
  retryAllNow(): Promise<void>[] {
    return Array.from(this.owedReasserts.values(), (entry) => {
      if (entry.handle !== undefined) {
        this.collaborators.timer.clearTimeout(entry.handle);
        entry.handle = undefined;
      }
      return this.retryDuringDrain(entry);
    });
  }

  /** The drain's one attempt at an owed rewrite; marked before the caller's first await. */
  private retryDuringDrain(entry: OwedSupersededRowReassert<S>): Promise<void> {
    entry.drainAttempted = true;
    return entry.callbacks.retryDuringDrain(entry);
  }

  stopTimers(): void {
    for (const entry of this.owedReasserts.values()) {
      if (entry.handle !== undefined) {
        this.collaborators.timer.clearTimeout(entry.handle);
        entry.handle = undefined;
      }
    }
  }
}
