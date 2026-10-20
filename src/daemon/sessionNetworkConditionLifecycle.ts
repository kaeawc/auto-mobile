import { ActionableError } from "../models/ActionableError";
import type {
  IosAppNetworkRule,
  IosAppNetworkRuleCommandContext,
} from "../features/networkFilter/IosAppNetworkRuleClient";
import { MAX_NETWORK_CONDITION_TTL_SECONDS } from "../features/utility/DeviceState";
import { logger } from "../utils/logger";
import { IosAppNetworkLeases, type IosAppNetworkRuleRestorer } from "./iosAppNetworkLease";
import type { Session } from "./sessionManager";
import { runDeviceStateMutationExclusive } from "./queuedDeviceStateRestore";
import type {
  SessionDeviceStateRestoreHost,
  SessionDeviceStateRestoreOptions,
  IosAppNetworkRuleSessionState,
} from "./sessionDeviceStateRestore";

/** Only the session lifecycle operations this restore family needs. */
interface SessionNetworkConditionLifecycleHost extends Pick<
  SessionDeviceStateRestoreHost,
  "timer" | "sessionNow" | "isPublished" | "isAdmittedForAutomation"
> {}
interface NetworkConditionRestoreCallbacks {
  onExpiry(session: Session, clearIfOwned: () => void): void;
}
/** Owns network TTLs and iOS per-app rule ownership. */
export class SessionNetworkConditionLifecycle {
  private injectedIosAppNetworkRuleRestorer?: IosAppNetworkRuleRestorer;

  private readonly defaultIosAppNetworkRuleRestorer: () => IosAppNetworkRuleRestorer;

  /**
   * Active per-condition network TTLs (issue #6085 item 2), keyed by session id.
   * When a session degrades the network with an `expiresInSeconds`, a timer resets
   * the profile to `none` when it elapses — independent of session lifetime. The
   * timer is cancelled on release/rebind (whichever restore runs first wins) and
   * clears the restore slot when it fires, so it can never fire against a freed
   * device or double-restore.
   */
  private readonly networkConditionExpiryTimers: Map<
    string,
    { handle: NodeJS.Timeout; session: Session; deadlineMs: number; generation: number }
  > = new Map();

  /**
   * Monotonic per-session network-condition generation (issue #6177). Bumped by
   * {@link bumpNetworkConditionGeneration} on every apply/reset mutation, and
   * captured into a TTL expiry's closure when it is scheduled. A stale expiry
   * (condition A) that is still awaiting its restore when a newer condition
   * (B) is applied sees, on completion, that the session's generation has moved
   * on — so it can detect it was superseded and must not clear B's restore slot.
   */
  private readonly networkConditionGeneration: Map<string, number> = new Map();

  /**
   * Per-session tail of the promise chain serializing
   * {@link runNetworkConditionMutationExclusive} critical sections (issue #6178
   * PR #6183 review, structural fix). The generation guard alone cannot
   * preserve a displaced expiry: a later generation only proves a mutation was
   * ATTEMPTED, not that it succeeded, so two overlapping FAILURES (B then C)
   * could each see nothing to restore while a timed degrade's (A's) original
   * deadline is lost between them. Serializing the whole apply/reset + TTL
   * arm/cancel/re-arm sequence per session removes the race family outright —
   * see {@link runNetworkConditionMutationExclusive}.
   */
  private readonly networkConditionMutationQueues: Map<string, Promise<unknown>> = new Map();

  /** Renews each session's installed iOS per-app rule (#10264). */
  private readonly iosAppNetworkLeases: IosAppNetworkLeases;

  /** Last owner generation handed out; see {@link allocateIosOwnerGeneration}. */
  private lastIosOwnerGeneration = 0;

  constructor(
    private readonly host: SessionNetworkConditionLifecycleHost,
    options: Pick<
      SessionDeviceStateRestoreOptions,
      "iosAppNetworkRuleRestorer" | "defaultIosAppNetworkRuleRestorer" | "iosLease"
    >,
    private readonly callbacks: NetworkConditionRestoreCallbacks,
  ) {
    this.injectedIosAppNetworkRuleRestorer = options.iosAppNetworkRuleRestorer;
    this.defaultIosAppNetworkRuleRestorer = options.defaultIosAppNetworkRuleRestorer;
    this.iosAppNetworkLeases = new IosAppNetworkLeases(
      this.host.timer,
      () => this.iosAppNetworkRuleRestorer,
      options.iosLease,
    );
  }

  /** The injected iOS per-app rule restorer, else one over the installed controller. */
  get iosAppNetworkRuleRestorer(): IosAppNetworkRuleRestorer {
    this.injectedIosAppNetworkRuleRestorer ??= this.defaultIosAppNetworkRuleRestorer();
    return this.injectedIosAppNetworkRuleRestorer;
  }

  /**
   * Owner generations must increase across daemon restarts, because the
   * provider keeps tombstones of released generations in memory. Seeding from
   * the host clock (milliseconds) and never repeating a value keeps a new
   * daemon's generations above an earlier daemon's.
   */
  private allocateIosOwnerGeneration(): number {
    this.lastIosOwnerGeneration = Math.max(
      this.lastIosOwnerGeneration + 1,
      Math.floor(this.host.sessionNow()),
    );
    return this.lastIosOwnerGeneration;
  }

  /**
   * Publish this session's iOS per-app rule slot before an `apply` (#10264), so
   * release, rebind and TTL expiry can remove it even if the apply is in flight.
   * One app per session: a different app must be reset first.
   */
  beginIosAppNetworkRule(
    session: Session,
    target: { udid: string; bundleId: string },
  ): IosAppNetworkRuleCommandContext {
    const state = session.cacheData.networkCondition;
    const existing = state?.iosAppRule;
    if (existing && (existing.udid !== target.udid || existing.bundleId !== target.bundleId)) {
      throw new ActionableError(
        `Session ${session.sessionId} already holds an offline rule for ${existing.bundleId}; ` +
          `reset it with networkCondition { profile: "none", appId: "${existing.bundleId}" } first.`,
      );
    }
    const rule: IosAppNetworkRuleSessionState = existing ?? {
      udid: target.udid,
      bundleId: target.bundleId,
      ownerGeneration: this.allocateIosOwnerGeneration(),
      lastRevision: 0,
    };
    if (!existing) {
      session.cacheData.networkCondition = { initialProfile: "none", iosAppRule: rule };
    }
    return this.iosRuleContext(session, rule, ++rule.lastRevision);
  }

  /**
   * Ownership for an explicit `reset` of `target`. A session that holds no rule
   * for it still sends a reset (under a fresh generation it never stores): the
   * provider then answers `reset` when no rule exists, or refuses to clear
   * another session's rule.
   */
  prepareIosAppNetworkReset(
    session: Session,
    target: { udid: string; bundleId: string },
  ): IosAppNetworkRuleCommandContext {
    const existing = session.cacheData.networkCondition?.iosAppRule;
    if (existing && existing.udid === target.udid && existing.bundleId === target.bundleId) {
      return this.iosRuleContext(session, existing, ++existing.lastRevision);
    }
    const transient: IosAppNetworkRuleSessionState = {
      udid: target.udid,
      bundleId: target.bundleId,
      ownerGeneration: this.allocateIosOwnerGeneration(),
      lastRevision: 1,
    };
    return this.iosRuleContext(session, transient, transient.lastRevision);
  }

  private iosRuleContext(
    session: Session,
    state: IosAppNetworkRuleSessionState,
    revision: number,
  ): IosAppNetworkRuleCommandContext {
    return {
      rule: {
        udid: state.udid,
        bundleId: state.bundleId,
        owner: session.sessionId,
        ownerGeneration: state.ownerGeneration,
        revision,
      },
      nextRevision: () => ++state.lastRevision,
    };
  }

  /**
   * The provider acknowledged `rule` as installed: record it and renew its lease
   * while this exact session still owns this exact revision.
   */
  confirmIosAppNetworkRule(session: Session, rule: IosAppNetworkRule): void {
    const state = session.cacheData.networkCondition?.iosAppRule;
    if (
      !this.host.isPublished(session) ||
      !state ||
      state.ownerGeneration !== rule.ownerGeneration
    ) {
      return;
    }
    state.installedRevision = rule.revision;
    this.iosAppNetworkLeases.start(session.sessionId, rule, () => {
      const current = session.cacheData.networkCondition?.iosAppRule;
      return (
        this.host.isAdmittedForAutomation(session) &&
        current === state &&
        current.installedRevision === rule.revision
      );
    });
  }

  /**
   * The session reset its rule (or the provider said it no longer holds one):
   * stop renewing and drop the slot, so release does not reset it again.
   */
  finishIosAppNetworkReset(session: Session, rule: IosAppNetworkRule): void {
    if (!this.host.isPublished(session)) {
      return;
    }
    const state = session.cacheData.networkCondition?.iosAppRule;
    if (!state || state.ownerGeneration !== rule.ownerGeneration) {
      return;
    }
    this.iosAppNetworkLeases.stop(session.sessionId);
    delete session.cacheData.networkCondition;
  }

  /** The iOS rule whose lease this session is renewing, if any (diagnostics and tests). */
  activeIosAppNetworkLease(sessionId: string): IosAppNetworkRule | undefined {
    return this.iosAppNetworkLeases.active(sessionId);
  }

  /** Stop renewing `sessionId`'s iOS rule lease (release/rebind remove the rule themselves). */
  stopIosAppNetworkLease(sessionId: string): void {
    this.iosAppNetworkLeases.stop(sessionId);
  }

  /** Start renewing an already-confirmed rule (rebind republishes the lease). */
  startIosAppNetworkLease(
    sessionId: string,
    rule: IosAppNetworkRule,
    isCurrent: () => boolean,
  ): void {
    this.iosAppNetworkLeases.start(sessionId, rule, isCurrent);
  }

  /**
   * Arm a standalone per-condition network TTL (issue #6085 item 2): when it
   * elapses, the device is reset to `none` independent of session lifetime.
   * Re-scheduling (a re-applied condition) cancels the prior timer first, so only
   * the latest TTL is armed. A non-positive TTL arms nothing (and still clears any
   * prior timer), matching the "TTL-only / neutral request applies nothing" rule.
   *
   * Keyed by session id but IDENTITY-GUARDED by the captured `Session` instance
   * (issue #6085 review): the caller passes the exact session it just mutated, and
   * the timer fires against that instance only — so a stale schedule from a
   * timed-out setup cannot arm or fire a TTL against a same-UUID REPLACEMENT
   * session. The TTL is clamped to `MAX_NETWORK_CONDITION_TTL_SECONDS` so the
   * millisecond product cannot overflow `setTimeout`'s signed 32-bit delay (item 4).
   *
   * `generation` MUST be the value the caller's own `bumpNetworkConditionGeneration`
   * call returned for the mutation this TTL belongs to (issue #6181 review) — NOT
   * re-read from the session's current generation here. Two mutations (B, C) can
   * bump the shared counter before either reaches this call (B under `await
   * trackSessionSetup`, C right behind it), so reading "current" at schedule time
   * can tag B's timer with C's generation. Comparing against a per-call, per-mutation
   * value closes that window: a timer only ever matches the generation it actually
   * belongs to. Callers that don't track their own generation (tests, and any
   * caller predating this parameter) may omit it, falling back to the session's
   * current generation at schedule time — safe as long as no concurrent mutation is
   * in flight for that call.
   */
  scheduleNetworkConditionExpiry(
    session: Session,
    expiresInSeconds: number,
    generation?: number,
  ): void {
    const sessionId = session.sessionId;
    this.cancelNetworkConditionExpiry(sessionId);
    if (!(expiresInSeconds > 0)) {
      return;
    }
    // A stale schedule (e.g. a setup that finished after this session was released
    // and replaced) must not arm a timer against the replacement — bail unless the
    // captured instance is still the live session.
    if (!this.host.isPublished(session)) {
      return;
    }
    const effectiveSeconds = Math.min(expiresInSeconds, MAX_NETWORK_CONDITION_TTL_SECONDS);
    if (effectiveSeconds < expiresInSeconds) {
      logger.warn(
        `networkCondition TTL of ${expiresInSeconds}s exceeds the ${MAX_NETWORK_CONDITION_TTL_SECONDS}s ` +
          `setTimeout limit for session ${sessionId}; clamping to ${effectiveSeconds}s`,
      );
    }
    // Capture the OWNING mutation's generation into the closure (issue #6177,
    // hardened #6181): if a newer condition supersedes it before this timer's
    // awaited restore settles, the generation check in clearNetworkConditionIfOwned
    // detects the mismatch and skips clearing the newer condition's restore slot.
    const effectiveGeneration = generation ?? this.currentNetworkConditionGeneration(sessionId);
    this.armNetworkConditionExpiryAt(
      session,
      this.host.sessionNow() + effectiveSeconds * 1000,
      effectiveGeneration,
    );
  }

  /**
   * Arm the timer for an absolute deadline and a fixed generation, shared by
   * {@link scheduleNetworkConditionExpiry} (a fresh TTL) and
   * {@link rearmNetworkConditionExpiry} (restoring a snapshot taken by
   * {@link peekNetworkConditionExpiry}). Identity-guarded like its callers: a
   * session that was replaced under the same id since the deadline was captured
   * is not armed against.
   */
  private armNetworkConditionExpiryAt(
    session: Session,
    deadlineMs: number,
    generation: number,
  ): void {
    const sessionId = session.sessionId;
    if (!this.host.isPublished(session)) {
      return;
    }
    const remainingMs = Math.max(0, deadlineMs - this.host.sessionNow());
    const handle = this.host.timer.setTimeout(() => {
      this.handleNetworkConditionExpiry(session, generation);
    }, remainingMs);
    this.networkConditionExpiryTimers.set(sessionId, { handle, session, deadlineMs, generation });
  }

  /**
   * Snapshot a pending network-condition TTL without disturbing it (issue
   * #6178 item 1). `runSessionNetworkMutation` calls this before cancelling the
   * timer to run its own mutation race-free (issue #6085 review), then re-arms
   * the snapshot via {@link rearmNetworkConditionExpiry} if that mutation does
   * not confirm success — so a manual reset whose emulator command fails does
   * not permanently drop the deadline a prior timed degrade promised.
   */
  peekNetworkConditionExpiry(
    sessionId: string,
  ): { deadlineMs: number; generation: number } | undefined {
    const entry = this.networkConditionExpiryTimers.get(sessionId);
    return entry ? { deadlineMs: entry.deadlineMs, generation: entry.generation } : undefined;
  }

  /**
   * Re-arm a TTL previously captured via {@link peekNetworkConditionExpiry},
   * preserving its original deadline and generation exactly (issue #6178 item
   * 1). A deadline already in the past fires on the next tick rather than
   * being dropped, matching a TTL that elapsed while the failed mutation ran.
   *
   * Generation-guarded (issue #6178 PR #6183 review, P1): the caller's own
   * mutation attempt already bumped the counter to `snapshot.generation`
   * before it ran, so an UNCHANGED current generation means nothing else has
   * mutated since. But three overlapping requests on one session (A's timed
   * degrade, B's slow failing re-apply, C's later successful re-apply) can
   * settle out of order — B's failure must not blindly re-arm A's deadline
   * once C has already bumped the counter again and established its own
   * state (its own fresh TTL, live in the timer map, or a deliberate "no
   * TTL"). Skipping whenever the generation has moved on avoids both
   * resurrecting a deadline C already retired AND clobbering C's live timer
   * handle without cancelling it.
   *
   * Also refuses to re-arm a releasing/released session (issue #6178 PR #6183
   * review, P2): `releaseSessionInternal` cancels any pending TTL BEFORE
   * awaiting the tracked mutation that may still be in flight. If that
   * mutation then throws (or otherwise triggers a re-arm) while release is
   * still draining, blindly re-arming here would undo release's cancellation
   * — either running a stale timer concurrently with release's own
   * restoration, or pinning a released session's timer-map entry for up to
   * `MAX_NETWORK_CONDITION_TTL_SECONDS` (~24.8 days). Release's cancellation
   * must be the last word, so a releasing/no-longer-current session is never
   * re-armed.
   */
  rearmNetworkConditionExpiry(
    session: Session,
    snapshot: { deadlineMs: number; generation: number },
  ): void {
    const sessionId = session.sessionId;
    if (this.currentNetworkConditionGeneration(sessionId) !== snapshot.generation) {
      logger.debug(
        `Skipping network-condition TTL re-arm for session ${sessionId}: generation ` +
          `${snapshot.generation} has been superseded by a later mutation`,
      );
      return;
    }
    if (!this.host.isAdmittedForAutomation(session)) {
      logger.debug(
        `Skipping network-condition TTL re-arm for session ${sessionId}: session is releasing ` +
          `or no longer live`,
      );
      return;
    }
    this.armNetworkConditionExpiryAt(session, snapshot.deadlineMs, snapshot.generation);
  }

  /**
   * Cancel a pending network TTL. Called on release, rebind, and any subsequent
   * network mutation (a manual reset, or a re-apply BEFORE it re-arms) so the
   * release-restore and the TTL can never both fire. A no-op when no timer is armed.
   */
  cancelNetworkConditionExpiry(sessionId: string): void {
    const entry = this.networkConditionExpiryTimers.get(sessionId);
    if (entry !== undefined) {
      this.host.timer.clearTimeout(entry.handle);
      this.networkConditionExpiryTimers.delete(sessionId);
    }
  }

  /**
   * TTL elapsed: the host resets the device to `none` via the SAME bounded
   * restore/retry the session-release path uses, and RETAINS restoration
   * ownership — keeps the restore slot and the device quarantined — until the
   * reset actually SUCCEEDS (issue #6085 review); only then does
   * {@link clearNetworkConditionIfOwned} drop the slot.
   *
   * Identity-guarded on the captured `Session`: a fire against a same-UUID
   * REPLACEMENT session (or an already-released one) is a no-op, so it never acts
   * on a freed or replaced device.
   */
  private handleNetworkConditionExpiry(session: Session, expectedGeneration: number): void {
    const sessionId = session.sessionId;
    const entry = this.networkConditionExpiryTimers.get(sessionId);
    if (entry && entry.session === session) {
      this.networkConditionExpiryTimers.delete(sessionId);
    }
    // Read the raw session map rather than getSession(), so a timer fire cannot
    // trigger a lazy-expiry release as a side effect. A missing or replaced
    // session was already released — its release-restore handled connectivity.
    if (!this.host.isPublished(session)) {
      return;
    }
    this.callbacks.onExpiry(session, () =>
      this.clearNetworkConditionIfOwned(session, expectedGeneration),
    );
  }

  /**
   * Drop the network restore slot once a reset has satisfied it (issue #6085),
   * but ONLY while the captured session is still the live one — a same-UUID
   * replacement must keep its own freshly-published slot — AND only while the
   * session's network-condition generation still matches the one this expiry was
   * scheduled against (issue #6177). A stale expiry (condition A) that settles
   * after a newer condition (B) has been applied must not delete B's restore
   * slot: the generation mismatch is the signal that A has been superseded.
   */
  private clearNetworkConditionIfOwned(session: Session, expectedGeneration: number): void {
    if (!this.host.isPublished(session)) {
      return;
    }
    if (this.currentNetworkConditionGeneration(session.sessionId) !== expectedGeneration) {
      logger.debug(
        `Network condition TTL expiry for session ${session.sessionId} settled after a newer ` +
          `condition superseded it; leaving that condition's restore binding in place`,
      );
      return;
    }
    if (session.cacheData.networkCondition) {
      delete session.cacheData.networkCondition;
      this.iosAppNetworkLeases.stop(session.sessionId);
    }
  }

  /**
   * Bump the per-session network-condition generation (issue #6177). Called on
   * every apply/reset mutation, BEFORE the mutation runs, so a TTL scheduled for
   * the condition being replaced can never observe the generation it captures as
   * still current. Returns the new generation for the caller to arm a TTL with.
   */
  bumpNetworkConditionGeneration(sessionId: string): number {
    const next = (this.networkConditionGeneration.get(sessionId) ?? 0) + 1;
    this.networkConditionGeneration.set(sessionId, next);
    return next;
  }

  /**
   * Run `fn` as the next link in a per-session promise-chain mutex, so that
   * `runSessionNetworkMutation`'s ENTIRE critical section — generation bump,
   * TTL snapshot/cancel, the mutation itself, and its TTL re-arm/schedule
   * decision — never overlaps another same-session networkCondition mutation
   * (issue #6178 PR #6183 review). This is the structural fix for a family of
   * races the generation guard alone could not close: a later generation only
   * proves a mutation was ATTEMPTED, not that it succeeded, so two overlapping
   * FAILURES could each observe nothing to restore while a displaced TTL is
   * lost between them. With this lock, a later mutation's snapshot always sees
   * the FULLY SETTLED state (including any prior mutation's own re-arm) of the
   * one before it — the whole interleaving family becomes impossible, not just
   * the specific cases already patched.
   *
   * Scoped narrowly and reentrancy-safe by construction: keyed per session id
   * (never blocks a different session's mutations, or unrelated session work
   * like release/rebind — those act on the timer/session maps directly), and
   * `fn` is the caller's entire body, so nothing outside this one critical
   * section is ever held across an await. `.catch(() => undefined)` on the
   * chain tail ensures one mutation's rejection cannot wedge the queue for the
   * next; the `finally` drops the map entry once nothing is queued behind it,
   * so a dead session leaves no residue.
   */
  runNetworkConditionMutationExclusive<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    return runDeviceStateMutationExclusive(this.networkConditionMutationQueues, sessionId, fn);
  }

  private currentNetworkConditionGeneration(sessionId: string): number {
    return this.networkConditionGeneration.get(sessionId) ?? 0;
  }

  /** The session ended: drop its generation and mutation queue (no residue). */
  forgetSession(sessionId: string): void {
    this.networkConditionGeneration.delete(sessionId);
    this.networkConditionMutationQueues.delete(sessionId);
  }

  /** Cancel every armed TTL and stop every iOS lease so a stopped manager leaves no timer. */
  stopAll(): void {
    for (const entry of this.networkConditionExpiryTimers.values()) {
      this.host.timer.clearTimeout(entry.handle);
    }
    this.networkConditionExpiryTimers.clear();
    this.iosAppNetworkLeases.stopAll();
  }
}
