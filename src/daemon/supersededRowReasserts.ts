import { exponentialBackoff, type BackoffPolicy } from "../utils/Backoff";
import type { Logger } from "../utils/logger";
import type { Timer } from "../utils/SystemTimer";
import type { Session, SessionReleaseSnapshot } from "./sessionManager";

/**
 * Retries of a live row's rewrite after an overlapping row write (#11557): an activity re-persist
 * that a rebind overlapped may have written the binding from before it, and one failed rewrite (a
 * busy database) must not leave the live session's row behind. Bounded; after the last one the
 * rewrite stays owed and the session's next activity write issues it again.
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

/** A live row's rewrite after an overlapping row write that is still owed (#11557). */
export interface OwedSupersededRowReassert<S extends SupersededRowIncarnation = Session> {
  /** The incarnation the rewrite is owed to; a session revived under the UUID owes nothing. */
  session: S;
  /** Failed attempts so far, the first write included. */
  attempt: number;
  /** The armed retry; absent while a retry runs and once the retries are exhausted. */
  handle?: NodeJS.Timeout;
  /** Already retried during shutdown's drain; a further failure is not retried again (#11058). */
  drainAttempted?: boolean;
  callbacks: OwedSupersededRowReassertCallbacks<S>;
}

/** What the ledger needs from the row writer around it. */
export interface SupersededRowReassertsCollaborators {
  timer: Timer;
  logger: Pick<Logger, "warn">;
  /** True once shutdown started draining releases (#11058). */
  draining(): boolean;
  /** Track a background write for shutdown's drain without wrapping its promise. */
  trackDrainWrite(write: Promise<void>): void;
}

/**
 * The superseded-row state of the row writer (#11799 W3): the live-row rewrites that repair a
 * rebind and an activity write overlapping (which are under way, which are owed, and the owed
 * rewrites' retry scheduling), and the earlier reasons a terminal release's committed upgrade may
 * replace. Holds no I/O and no row policy: every statement, read and precondition stays with the
 * caller, which keeps its original await sequence.
 */
export class SupersededRowReasserts<S extends SupersededRowIncarnation = Session> {
  /** Only the exact earlier reasons of this release may be replaced by its committed upgrade. */
  private readonly reasonPredecessors = new WeakMap<SessionReleaseSnapshot, readonly string[]>();
  /**
   * UUIDs whose live row this daemon is rewriting after an overlapping row write, counted per
   * pending rewrite. While one is pending, a refused activity write does not end the live session
   * (#11498): the rewrite is about to leave its row live.
   */
  private readonly pendingReasserts = new Map<string, number>();
  /**
   * Rewrites that failed, or that a rebind overtook, and are still owed (#11557): retried with
   * the backoff, then by the session's activity writes once the retries are exhausted.
   */
  private readonly owedReasserts = new Map<string, OwedSupersededRowReassert<S>>();
  private backoff: BackoffPolicy = DEFAULT_SUPERSEDED_ROW_REASSERT_BACKOFF;

  constructor(private readonly collaborators: SupersededRowReassertsCollaborators) {}

  setBackoff(backoff: BackoffPolicy): void {
    this.backoff = backoff;
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

  /** Count a pending rewrite of `sessionId`'s live row; the returned function ends it, once. */
  expectReassert(sessionId: string): () => void {
    const pending = this.pendingReasserts;
    pending.set(sessionId, (pending.get(sessionId) ?? 0) + 1);
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
    };
  }

  isReassertPending(sessionId: string): boolean {
    return this.pendingReasserts.has(sessionId);
  }

  owed(sessionId: string): OwedSupersededRowReassert<S> | undefined {
    return this.owedReasserts.get(sessionId);
  }

  /** Record a failed rewrite as owed and arm its next retry, while any are left (#11557). */
  owe(session: S, callbacks: OwedSupersededRowReassertCallbacks<S>): void {
    const sessionId = session.sessionId;
    const owed = this.owedReasserts.get(sessionId);
    const previous = owed?.session === session ? owed : undefined;
    if (owed?.handle !== undefined) {
      this.collaborators.timer.clearTimeout(owed.handle);
    }
    const entry: OwedSupersededRowReassert<S> = {
      session,
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
