import { Mutex } from "async-mutex";
import { DeviceSessionNotActiveError } from "../db/deviceSessionRepository";
import type { DbWriteBarrier } from "../db/dbWriteBarrier";
import { ActionableError } from "../models/ActionableError";
import { errorMessage } from "../utils/describeUnknownError";
import { logger } from "../utils/logger";
import {
  getCliSessionIdleTimeoutMs as resolveCliSessionIdleTimeoutMs,
  MAX_CLI_SESSION_IDLE_TIMEOUT_MS,
  sanitizeCliSessionIdleTimeoutMs as sanitizeRequestedCliIdleTimeoutMs,
} from "./constants";
import {
  decideLivenessClaim,
  mayAdoptUnownedLiveness,
  type LivenessOwnerView,
} from "./livenessClaimDecision";
import {
  MANAGED_EXECUTION_LIVENESS_POLICY,
  resolveManagedExecutionIdleTimeoutMs,
} from "./sessionBroker/provisioning/executionLiveness";
import type {
  LivenessClaimOutcome,
  LivenessReleaseOutcome,
  PreCliLivenessSnapshot,
  Session,
} from "./sessionManager";

/**
 * Re-derive the idle deadline after a policy change widened `sessionTimeoutMs`, never shortening
 * it. The deadline is anchored on the last tool activity (`lastUsedAt`), never on the current time:
 * a liveness path may change the idle WINDOW but must not count as use (#10656, #10668).
 */
export function widenIdleDeadlineFromLastActivity(session: Session): void {
  session.expiresAt = Math.max(session.expiresAt, session.lastUsedAt + session.sessionTimeoutMs);
}

/**
 * Re-derive the idle deadline after a policy change restored a shorter `sessionTimeoutMs`. Like
 * {@link widenIdleDeadlineFromLastActivity} it is anchored on the last tool activity, so the
 * liveness path that restores the policy cannot extend the deadline (#10656, #10668).
 */
export function rebaseIdleDeadlineOnLastActivity(session: Session): void {
  session.expiresAt = session.lastUsedAt + session.sessionTimeoutMs;
}

/**
 * What the liveness lease needs from the session manager that owns the session table. Each member
 * is a forwarder to the owner's method of the same meaning, so the lookups keep their expiry
 * behaviour: `getSession` expires and releases a session past its idle deadline, `peekSession`
 * only judges.
 */
export interface SessionLivenessPort {
  getSession(sessionId: string): Session | null;
  peekSession(sessionId: string): Session | null;
  /** A looked-up session, unless it is a plan label whose base has ended (#11640). */
  unlessBaseEnded(session: Session | null): Session | null;
  isAdmittedForAutomation(session: Session): boolean;
  sessionNow(): number;
  ownershipSessionUuid(sessionId: string): string;
  livenessOwnerView(session: Session): LivenessOwnerView;
  hasUnissuedActivity(session: Session): boolean;
  recordSessionActivity(session: Session): Promise<void>;
  getBarrier(): DbWriteBarrier;
  recordLivenessOwnership(sessionId: string, ownerToken: string | null): Promise<void>;
  replaceLivenessOwnership(sessionId: string, ownerToken: string | null): Promise<void>;
  defaultHeartbeatTimeoutMs(): number;
}

/**
 * The liveness owner lease and the policy a session is judged under (#11797): heartbeats that
 * renew the lease, ownership claims and releases under a per-session mutex, and the CLI,
 * managed-execution and heartbeat policy changes. The lease judgements, stall forgiveness and
 * expiry stay with the session manager, which owns the session table they scan.
 */
export class SessionLivenessController {
  private readonly livenessOwnershipClaimMutexes = new WeakMap<Session, Mutex>();

  // The lint walkers (livenessActivityClockSeparation) key on the field name `port`.
  constructor(private readonly port: SessionLivenessPort) {}

  /**
   * Record a liveness heartbeat for a session.
   *
   * A heartbeat proves the owner process is alive; it is not device use (#10656). It renews the
   * owner lease (`lastHeartbeat`, `lastOwnerHeartbeat`), marks the session as heartbeating, and
   * promotes an awaiting-owner session to owned. It must never write the tool-activity clocks
   * (`lastUsedAt`, `expiresAt`): an idle but live owner — a stdio proxy whose keeper ticks every
   * 2 s while its agent makes no tool calls — would otherwise hold its device forever. Only tool
   * calls (`getOrCreateSession` at the start, `recordToolCallEnded` at the end) move the idle
   * deadline. Guarded by
   * `test/lint/livenessActivityClockSeparation.test.ts` (#10668).
   */
  recordHeartbeat(sessionId: string): void {
    const session = this.port.unlessBaseEnded(this.port.getSession(sessionId));
    if (!session) {
      logger.warn(`Cannot record heartbeat for session ${sessionId}: not found`);
      return;
    }
    if (!this.port.isAdmittedForAutomation(session)) {
      return;
    }
    const now = this.port.sessionNow();
    const previousHeartbeat = session.lastHeartbeat;
    session.lastHeartbeat = now;
    logger.debug(
      `Heartbeat accepted for session ${sessionId}; previous heartbeat age=${Math.max(0, now - previousHeartbeat)}ms`,
    );
    // Only a heartbeat advances the owner lease; both the socket and HTTP routes admit one only
    // from the owner (or a tokenless client on a session no proxy owns).
    session.lastOwnerHeartbeat = now;
    session.activityGeneration++;
    session.hasReceivedHeartbeat = true;
    if (session.ownership === "awaiting-owner") {
      session.ownership = "owned";
      session.awaitingOwnerSince = undefined;
    }
    // The heartbeat's own clocks are in-memory only; the row changes only when a persisted field
    // does (the first heartbeat, or a state an earlier write failed to store). Skipping the rest
    // keeps a contended or failing database off the heartbeat path entirely (#11079).
    if (!this.port.hasUnissuedActivity(session)) {
      return;
    }
    void this.port
      .getBarrier()
      .track(() => this.port.recordSessionActivity(session))
      .catch((error) => {
        // The heartbeat was acknowledged and the owner really is alive: rolling the lease back
        // here would release a healthy owner after lease + grace whenever writes fail (disk
        // full, read-only, busy peer) (#11079). The lease is in-memory; the unstored fields are
        // retried by the next heartbeat or tool call because the failed write is forgotten.
        logger.warn(
          `[SessionManager] Failed to record heartbeat activity for ${sessionId}: ${errorMessage(error)}`,
          error,
        );
      });
  }

  /**
   * Make `ownerToken` the current liveness owner for a session, unless another
   * token owns it with a live lease (#10050).
   *
   * This intentionally does not record activity. The request handler claims
   * ownership before applying the requested policy and recording its heartbeat,
   * so a rejected or stale token can be refused without changing any liveness
   * deadline, and a rejected claim leaves the session's owner and policy intact.
   *
   * Who wins is decided by {@link decideLivenessClaim}. A claim naming a derived
   * `${base}:${label}` session is judged against its base's owner too (#11602); the label keeps
   * its own liveness record, which the heartbeat path reads and renews under the label's id.
   */
  async claimLivenessOwnership(
    sessionId: string,
    ownerToken: string,
  ): Promise<LivenessClaimOutcome> {
    const session = this.port.unlessBaseEnded(this.port.getSession(sessionId));
    if (!session) {
      logger.warn(`Cannot claim liveness ownership for session ${sessionId}: not found`);
      return "not-found";
    }
    const mutex = this.livenessOwnershipClaimMutexFor(session);
    return await mutex.runExclusive(async () => {
      if (this.port.unlessBaseEnded(this.port.getSession(sessionId)) !== session) {
        return "not-found";
      }
      const processedClaims = session.livenessOwnershipClaims ?? new Set<string>();
      session.livenessOwnershipClaims = processedClaims;
      const base = this.livenessBaseSession(session);
      // Decided with no await before the takeover below takes effect.
      const decision = decideLivenessClaim({
        claimantToken: ownerToken,
        session: this.port.livenessOwnerView(session),
        claimAlreadyProcessed: processedClaims.has(ownerToken),
        base: base ? this.port.livenessOwnerView(base) : undefined,
      });
      if (decision.outcome === "superseded") {
        // A retried claim whose token has since been displaced must never take
        // the session back, whatever the new owner's lease says.
        return "superseded";
      }
      if (decision.outcome === "conflict") {
        const holder = decision.holdOf === "base" ? `its base session ${base?.sessionId}` : "it";
        logger.warn(
          `Rejected liveness ownership claim for session ${sessionId}: another owner holds a live lease on ${holder}`,
        );
        return "conflict";
      }
      if (session.livenessOwnerToken === ownerToken && processedClaims.has(ownerToken)) {
        // The owner's own retried claim: nothing to take over.
        return "claimed";
      }
      return await this.takeLivenessOwnership(session, ownerToken, processedClaims);
    });
  }

  /**
   * The live base session of a derived `${base}:${label}` session (#11602): its outermost base, as
   * connection ownership is keyed (#11586). Undefined for a session that is not a published label,
   * and for a label whose base is gone.
   */
  livenessBaseSession(session: Session): Session | undefined {
    const baseSessionId = this.port.ownershipSessionUuid(session.sessionId);
    return baseSessionId === session.sessionId
      ? undefined
      : (this.port.peekSession(baseSessionId) ?? undefined);
  }

  /** Clear only the owner token; preserve the device, policy and existing lease/grace deadline. */
  async releaseLivenessOwnership(
    sessionId: string,
    ownerToken: string,
  ): Promise<LivenessReleaseOutcome> {
    const session = this.port.unlessBaseEnded(this.port.getSession(sessionId));
    if (!session || !this.port.isAdmittedForAutomation(session)) {
      return "not-found";
    }
    return await this.livenessOwnershipClaimMutexFor(session).runExclusive(async () => {
      if (
        this.port.unlessBaseEnded(this.port.getSession(sessionId)) !== session ||
        !this.port.isAdmittedForAutomation(session)
      ) {
        return "not-found";
      }
      if (session.livenessOwnerToken === undefined) {
        return "already-unowned";
      }
      if (session.livenessOwnerToken !== ownerToken) {
        return "not-owner";
      }
      // Tick adoption has no claim history. Fence all keeper ticks before the release write yields.
      session.livenessOwnershipClaims ??= new Set<string>();
      session.livenessOwnershipClaims.add(ownerToken);
      const previousOwnerBoundAt = session.livenessOwnerBoundAt;
      session.livenessOwnerToken = undefined;
      session.livenessOwnerBoundAt = undefined;
      // Fence an older heartbeat write's failure rollback across the handoff.
      session.activityGeneration++;
      try {
        await this.port.recordLivenessOwnership(sessionId, null);
      } catch (error) {
        session.livenessOwnerToken = ownerToken;
        session.livenessOwnerBoundAt = previousOwnerBoundAt;
        if (!this.port.isAdmittedForAutomation(session)) {
          return "not-found";
        }
        throw error;
      }
      return "released";
    });
  }

  livenessOwnershipClaimMutexFor(session: Session): Mutex {
    const existing = this.livenessOwnershipClaimMutexes.get(session);
    if (existing) {
      return existing;
    }
    const mutex = new Mutex();
    this.livenessOwnershipClaimMutexes.set(session, mutex);
    return mutex;
  }

  /** Record a claim {@link decideLivenessClaim} let win. Runs inside the claim mutex. */
  private async takeLivenessOwnership(
    session: Session,
    ownerToken: string,
    processedClaims: Set<string>,
  ): Promise<LivenessClaimOutcome> {
    const previousOwnerToken = session.livenessOwnerToken;
    const previousOwnerHeartbeat = session.lastOwnerHeartbeat;
    const previousOwnerBoundAt = session.livenessOwnerBoundAt;
    const alreadyProcessed = processedClaims.has(ownerToken);
    processedClaims.add(ownerToken);
    session.livenessOwnerToken = ownerToken;
    session.livenessOwnerBoundAt = undefined;
    // Stamp the lease in the same step as the takeover, still inside the claim mutex. The
    // request handler records the claimant's heartbeat several awaits later; until then a second
    // foreign claimant would read the previous, lapsed lease and displace this one (#10050).
    session.lastOwnerHeartbeat = this.port.sessionNow();
    try {
      await this.persistNewLivenessOwnershipClaim(
        session,
        ownerToken,
        { previousOwnerToken, previousOwnerHeartbeat, previousOwnerBoundAt },
        processedClaims,
      );
    } catch (error) {
      if (alreadyProcessed) {
        processedClaims.add(ownerToken);
      }
      if (!this.port.isAdmittedForAutomation(session)) {
        // The session's release won the race with this claim: its row is no longer active, so
        // the ownership write matched nothing. The session is gone, as the claim reports.
        logger.info(
          `Liveness ownership claim for session ${session.sessionId} lost to its release: ` +
            errorMessage(error),
        );
        return "not-found";
      }
      throw error;
    }
    return "claimed";
  }

  private async persistNewLivenessOwnershipClaim(
    session: Session,
    ownerToken: string,
    previous: {
      previousOwnerToken: string | undefined;
      previousOwnerHeartbeat: number | undefined;
      previousOwnerBoundAt: number | undefined;
    },
    processedClaims: Set<string>,
  ): Promise<void> {
    const settleClaimantHeartbeat = this.markAcceptedClaimantHeartbeating(session);
    try {
      await this.port.recordLivenessOwnership(session.sessionId, ownerToken);
    } catch (error) {
      processedClaims.delete(ownerToken);
      session.livenessOwnerToken = previous.previousOwnerToken;
      session.lastOwnerHeartbeat = previous.previousOwnerHeartbeat;
      session.livenessOwnerBoundAt = previous.previousOwnerBoundAt;
      settleClaimantHeartbeat("undo");
      throw error;
    }
    settleClaimantHeartbeat("keep");
  }

  /**
   * An accepted claim is its owner's heartbeat (#11646). The claim arrives on the proxy's first
   * heartbeat, and the request handler records that heartbeat only after the ownership row write
   * resolves; until then the monitor would judge the session as one that never heartbeated, or
   * one still awaiting its rehydrated owner, and release it although its owner is live. The fact
   * is in-memory and set before the write, so a slow database stays off the heartbeat path
   * (#11079); the lease itself was stamped with the takeover, and is what the session is judged
   * on from here. Called only for an accepted claim, so a refused one changes nothing.
   *
   * Returns how the claim settles. "undo", for a claim whose write fails, leaves the session as
   * unheard and as unclaimed as the claim found it; a heartbeat or tool call recorded while the
   * write was pending moved the activity generation and stands on its own, so the undo leaves it
   * alone. A rehydrated session's owner window (`awaitingOwnerSince`) stays in place while the
   * write is pending, so the daemon's stall forgiveness keeps moving it and an undone claim
   * returns to the forgiven window, not the one the claim found; it is dropped once the
   * promotion stands.
   */
  private markAcceptedClaimantHeartbeating(session: Session): (outcome: "keep" | "undo") => void {
    const { hasReceivedHeartbeat, ownership, activityGeneration } = session;
    session.hasReceivedHeartbeat = true;
    if (ownership === "awaiting-owner") {
      session.ownership = "owned";
    }
    return (outcome) => {
      if (outcome === "undo" && session.activityGeneration === activityGeneration) {
        session.hasReceivedHeartbeat = hasReceivedHeartbeat;
        session.ownership = ownership;
        return;
      }
      if (ownership === "awaiting-owner" && session.ownership === "owned") {
        session.awaitingOwnerSince = undefined;
      }
    };
  }

  /** Return whether `ownerToken` is still authorized to refresh the session. */
  hasLivenessOwnership(sessionId: string, ownerToken: string): boolean {
    return (
      this.port.unlessBaseEnded(this.port.getSession(sessionId))?.livenessOwnerToken === ownerToken
    );
  }

  /**
   * Recover daemon-local liveness ownership after restart without allowing a
   * keeper to replace an owner that was established by this daemon instance.
   * Decided by {@link mayAdoptUnownedLiveness}: a derived label session is not adopted past
   * another token that holds its base (#11602).
   */
  claimUnownedLivenessOwnership(sessionId: string, ownerToken: string): boolean {
    const session = this.port.unlessBaseEnded(this.port.getSession(sessionId));
    if (!session || !this.adoptUnownedLivenessOwnerToken(session, ownerToken)) {
      return false;
    }
    session.lastOwnerHeartbeat = this.port.sessionNow();
    return true;
  }

  /** Bind acquisition identity and its claim-only lease start; no heartbeat or release changes. */
  bindAcquiredLivenessOwnerToken(sessionId: string, ownerToken: string): boolean {
    const session = this.port.peekSession(sessionId);
    if (!session || !this.adoptUnownedLivenessOwnerToken(session, ownerToken)) {
      return false;
    }
    session.livenessOwnerBoundAt = this.port.sessionNow();
    return true;
  }

  private adoptUnownedLivenessOwnerToken(session: Session, ownerToken: string): boolean {
    const base = this.livenessBaseSession(session);
    const adopt = mayAdoptUnownedLiveness({
      claimantToken: ownerToken,
      session: this.port.livenessOwnerView(session),
      sessionHasClaimHistory: Boolean(session.livenessOwnershipClaims?.size),
      base: base ? this.port.livenessOwnerView(base) : undefined,
    });
    if (!adopt) {
      return false;
    }
    session.livenessOwnerToken = ownerToken;
    session.livenessOwnerBoundAt = undefined;
    this.persistAdoptedLivenessOwnerToken(session);
    return true;
  }

  private persistAdoptedLivenessOwnerToken(session: Session): void {
    void this.port
      .getBarrier()
      .track(() =>
        this.livenessOwnershipClaimMutexFor(session).runExclusive(async () => {
          if (
            this.port.peekSession(session.sessionId) !== session ||
            !this.port.isAdmittedForAutomation(session) ||
            !session.livenessOwnerToken
          ) {
            return;
          }
          // Read under the claim mutex: a queued adoption must not restore an older owner.
          await this.port.replaceLivenessOwnership(session.sessionId, session.livenessOwnerToken);
        }),
      )
      .catch((error) => {
        if (error instanceof DeviceSessionNotActiveError) {
          // The row may have been released or not yet activated; in-memory adoption still stands.
          logger.debug("[SessionManager] Adopted liveness owner row is no longer active");
          return;
        }
        // Persistence is best-effort; omit error details because they may contain the token.
        logger.warn("[SessionManager] Failed to persist adopted liveness ownership");
      });
  }

  /**
   * Move a session onto the CLI liveness policy and record a heartbeat (#6870).
   *
   * Called when a one-shot `--cli` process declares ownership of the session it
   * just minted or joined. From here on the heartbeat monitor stops applying the
   * 10 s contract (which no one-shot process can keep between invocations) and
   * reaps the session only after {@link getCliSessionIdleTimeoutMs} of wall-clock
   * idleness. Returns false when the session is unknown — the CLI's declaration
   * is best-effort and must never fail the tool call that carried it.
   */
  adoptCliLivenessPolicy(sessionId: string, requestedIdleTimeoutMs?: number): boolean {
    const session = this.port.unlessBaseEnded(this.port.getSession(sessionId));
    if (!session) {
      logger.warn(`Cannot adopt CLI liveness policy for session ${sessionId}: not found`);
      return false;
    }
    if (session.livenessPolicy === MANAGED_EXECUTION_LIVENESS_POLICY) {
      // A managed execution's proxy owns this session for the execution's lifetime (#11176); a
      // one-shot CLI declaration must not widen it onto a heartbeat-free idle policy.
      logger.warn(
        `Refusing the CLI liveness policy for managed-execution session ${sessionId}; it stays on its owner lease`,
      );
      return false;
    }
    // A `--cli` invocation reuses whatever daemon is already running, so the
    // daemon process environment cannot be the only source of the idle timeout:
    // the invocation sends its own resolved (and here re-validated, bounded)
    // value, and only an absent/unusable one falls back to this process's env
    // (issue #6870 review).
    const idleTimeoutMs =
      sanitizeRequestedCliIdleTimeoutMs(requestedIdleTimeoutMs) ??
      Math.min(resolveCliSessionIdleTimeoutMs(), MAX_CLI_SESSION_IDLE_TIMEOUT_MS);
    if (session.livenessPolicy === "heartbeat") {
      // Remember the strict contract exactly once, so a long-lived owner taking
      // this UUID over can put the session back on it (issue #6870 review). A
      // re-adoption must not overwrite the snapshot with the CLI's own widened
      // values.
      session.preCliLiveness = {
        heartbeatTimeoutMs: session.heartbeatTimeoutMs,
        heartbeatTimeoutSource: session.heartbeatTimeoutSource,
        sessionTimeoutMs: session.sessionTimeoutMs,
      };
    }
    session.livenessPolicy = "cli-idle";
    session.heartbeatTimeoutMs = idleTimeoutMs;
    // Widen the ordinary expiry deadline too. An autolocked session is created
    // with a 60 s `sessionTimeoutMs`, and a later invocation's lookup expires a
    // session past `expiresAt` — so leaving `expiresAt` on the 60 s clock would
    // release a CLI-owned session long before the CLI idle timeout the policy
    // promises. `Math.max` keeps adoption from ever *shortening* the deadline of
    // a session that already had a longer one (a plain 30-minute session stays
    // at 30 minutes; the cli-idle policy still reaps it at the idle timeout,
    // which is the stricter of the two). The widened deadline is measured from
    // the last tool call, never from this declaration (#10656).
    session.sessionTimeoutMs = Math.max(session.sessionTimeoutMs, idleTimeoutMs);
    widenIdleDeadlineFromLastActivity(session);
    this.recordHeartbeat(sessionId);
    logger.debug(
      `Session ${sessionId} adopted the CLI liveness policy (idle timeout ${session.heartbeatTimeoutMs}ms)`,
    );
    return true;
  }

  /**
   * Put a session on the `managed-execution` liveness policy (#11176) with its idle window: the
   * launcher-trusted `idleTimeoutMs` (bounded 2–60 minutes) or the 2-minute default. Called by the
   * broker binding acquisition once it holds the session (epic #11172 step 5); a re-adoption updates
   * the window. The owner lease is unchanged, and the idle deadline is re-derived from the last
   * tool activity, never from now, so adopting the policy is not device use (#10656).
   *
   * Throws `BindingConfigError` for an out-of-bounds window and `ActionableError` for an
   * unknown session or a `cli-idle` one (a one-shot CLI session is not an execution's session).
   * A failed durable write rolls the in-memory change back and throws.
   */
  async adoptManagedExecutionLivenessPolicy(
    sessionId: string,
    options: { idleTimeoutMs?: number } = {},
  ): Promise<Session> {
    const idleTimeoutMs = resolveManagedExecutionIdleTimeoutMs(options.idleTimeoutMs);
    const session = this.port.getSession(sessionId);
    if (!session) {
      throw new ActionableError(
        `Cannot hold session ${sessionId} for a managed execution: the session is not active.`,
      );
    }
    if (session.livenessPolicy === "cli-idle") {
      throw new ActionableError(
        `Cannot hold session ${sessionId} for a managed execution: it is owned by a one-shot CLI.`,
      );
    }
    const previous = {
      livenessPolicy: session.livenessPolicy,
      sessionTimeoutMs: session.sessionTimeoutMs,
      expiresAt: session.expiresAt,
    };
    session.livenessPolicy = MANAGED_EXECUTION_LIVENESS_POLICY;
    session.sessionTimeoutMs = idleTimeoutMs;
    rebaseIdleDeadlineOnLastActivity(session);
    session.activityGeneration++;
    const capturedGeneration = session.activityGeneration;
    try {
      await this.port.recordSessionActivity(session);
    } catch (error) {
      // Only the latest change may roll back, so an older failure cannot clobber newer state.
      if (session.activityGeneration === capturedGeneration) {
        Object.assign(session, previous);
      }
      throw error;
    }
    logger.info(
      `Session ${sessionId} is held for a managed execution (idle window ${idleTimeoutMs}ms)`,
    );
    return session;
  }

  /**
   * Put a CLI-adopted session back on the strict heartbeat contract (#6870).
   *
   * `adoptCliLivenessPolicy` is sticky by design — a one-shot process is gone by
   * the time the next invocation arrives — but a long-lived stdio/HTTP proxy
   * that later owns the same session UUID *can* keep the 10 s contract, and its
   * heartbeats say so. Without this, that session would stay on the minutes-long
   * idle window and keep holding its device for the whole window after the
   * long-lived client disconnects. Returns false when there was nothing to
   * restore (unknown session, or one that never adopted the CLI policy).
   */
  restoreHeartbeatLivenessPolicy(sessionId: string): boolean {
    const session = this.port.unlessBaseEnded(this.port.getSession(sessionId));
    if (!session || session.livenessPolicy !== "cli-idle") {
      return false;
    }
    // Defensive fallback: a session that is somehow on the CLI policy without a
    // snapshot (a future recovery path that persists the policy) must still come
    // back to a strict timeout rather than keep the minutes-long one.
    const snapshot: PreCliLivenessSnapshot = session.preCliLiveness ?? {
      heartbeatTimeoutMs: this.port.defaultHeartbeatTimeoutMs(),
      heartbeatTimeoutSource: "default",
      sessionTimeoutMs: session.sessionTimeoutMs,
    };
    session.livenessPolicy = "heartbeat";
    session.heartbeatTimeoutMs = snapshot.heartbeatTimeoutMs;
    session.heartbeatTimeoutSource = snapshot.heartbeatTimeoutSource;
    session.sessionTimeoutMs = snapshot.sessionTimeoutMs;
    delete session.preCliLiveness;
    // Re-derive the idle deadline from the restored (shorter) timeout, so the
    // widened deadline adoption installed does not outlive the policy that
    // justified it. It is measured from the last tool call: this heartbeat
    // proves liveness, not use, and must not extend it (#10656).
    rebaseIdleDeadlineOnLastActivity(session);
    this.recordHeartbeat(sessionId);
    logger.debug(
      `Session ${sessionId} restored the heartbeat liveness policy (timeout ${session.heartbeatTimeoutMs}ms)`,
    );
    return true;
  }
}
