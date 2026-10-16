import { ObserveResult, TapOnElementResult, ViewHierarchyResult } from "../../models";
import { throwIfAborted } from "../../utils/toolUtils";
import { type Timer } from "../../utils/SystemTimer";
import type {
  ConditionPredicate,
  WaitForCondition,
  WaitForConditionOptions,
  WaitForConditionResult,
} from "../observe/interfaces/WaitForCondition";
import { hierarchyUpdatedAtToMillis } from "../observe/observeTimestamp";

/**
 * Post-tap observation budgets used by retryTapIfNoChange to decide whether
 * a tap registered.
 *
 * Activity transitions commonly take 1-2s on contended emulators (emulator.wtf),
 * and the CtrlProxy WebSocket push for the new hierarchy doesn't arrive until
 * after the destination renders. With tighter budgets the post-tap refresh
 * races the push and returns null/stale data during normal activity
 * transitions, which gets misread as a ghost tap and causes a stray retry on
 * the new screen.
 */
export const POST_TAP_EFFECT_TIMEOUT_MS = 2500;
export const POST_TAP_EFFECT_POLL_MS = 150;

/**
 * Minimum wall-clock time a hierarchy-only post-tap frame must hold UNCHANGED
 * before it is accepted as the settled destination (issue #6284 P1). Activity
 * transitions commonly take 1–2 seconds, so a transient hierarchy must stay
 * quiet for a full second before it is terminal evidence. This prevents a
 * routine delayed destination from being pre-empted by an intermediate frame
 * that merely survives the first few 150ms polls.
 */
export const POST_TAP_SETTLE_QUIET_PERIOD_MS = 1000;

/** What post-tap settling needs from the owning tap action (hash and derive stay overridable seams). */
export interface PostTapSettlerDeps {
  readonly timer: Timer;
  readonly waitForCondition: () => WaitForCondition;
  readonly hashViewHierarchy: (hierarchy: ViewHierarchyResult | null) => string | null;
  readonly deriveTapEffect: (
    previous: ObserveResult | null,
    current: ObserveResult | undefined,
  ) => TapOnElementResult["effect"] | undefined;
  readonly compareActiveWindow: (
    previous: ObserveResult,
    current: ObserveResult,
  ) => TapOnElementResult["effect"] | undefined;
}

/** Decides when a tap's screen effect has settled. Reads observations only; never dispatches. */
export class PostTapSettler {
  constructor(private readonly deps: PostTapSettlerDeps) {}

  /**
   * Detect a first effect throughout the original 2500ms window (#6284), then
   * require a quiet period after a hierarchy-only change. A change can settle
   * within that first waiter; otherwise continue the same quiet-period state
   * with only the remainder of its own 2500ms settle budget (5000ms overall).
   */
  async waitForPostTapChange(
    previousObservation: ObserveResult,
    currentObservation: ObserveResult,
    signal?: AbortSignal,
  ): Promise<{ effect: TapOnElementResult["effect"]; observation: ObserveResult }> {
    const started = this.deps.timer.now();
    let quietHash: string | null = null;
    let quietSinceMs = 0;
    const change: { observation?: ObserveResult; seenAt?: number } = {};
    const predicate: ConditionPredicate = (observation) => {
      const effect = this.deps.deriveTapEffect(previousObservation, observation);
      if (effect?.screenChanged === true && effect.basis !== "viewHierarchy changed") {
        return { matched: true };
      }
      const now = this.deps.timer.now();
      if (effect?.screenChanged === true && change.seenAt === undefined) {
        change.observation = observation;
        change.seenAt = now;
      }
      // A still source screen must never end detection early.
      if (change.seenAt === undefined) {
        return { matched: false };
      }
      const hash = this.deps.hashViewHierarchy(observation.viewHierarchy ?? null);
      if (hash === null || hash !== quietHash) {
        quietHash = hash;
        quietSinceMs = now;
        return { matched: false };
      }
      return { matched: now - quietSinceMs >= POST_TAP_SETTLE_QUIET_PERIOD_MS };
    };
    const options: WaitForConditionOptions = {
      // The predicate reads activeWindow, which needs per-poll back-stack reconciliation.
      readBackStackEachPoll: true,
      timeoutMs: POST_TAP_EFFECT_TIMEOUT_MS,
      pollMs: POST_TAP_EFFECT_POLL_MS,
      signal,
      // Keep the floor in the device-authored timestamp domain (#6284).
      initialMinTimestampMs: hierarchyUpdatedAtToMillis(currentObservation.viewHierarchy),
      // Still screens push nothing; require independent device reads (#9587).
      skipWaitForFresh: true,
      requireFreshExtraction: true,
    };
    let settled = await this.deps.waitForCondition().execute(predicate, options);
    const trustedEnteringObservation = change.observation ?? currentObservation;
    if (settled.timedOut && !settled.screenOff && change.seenAt !== undefined) {
      const deadline = Math.min(
        started + 2 * POST_TAP_EFFECT_TIMEOUT_MS,
        change.seenAt + POST_TAP_EFFECT_TIMEOUT_MS,
      );
      const remainingMs = deadline - this.deps.timer.now();
      if (remainingMs > 0) {
        throwIfAborted(signal);
        settled = await this.deps.waitForCondition().execute(predicate, {
          ...options,
          timeoutMs: remainingMs,
          initialMinTimestampMs: hierarchyUpdatedAtToMillis(
            this.resolveSettleTimeoutObservation(
              previousObservation,
              trustedEnteringObservation,
              settled,
            ).viewHierarchy,
          ),
        });
      }
    }
    const effectObservation = this.resolveSettleTimeoutObservation(
      previousObservation,
      trustedEnteringObservation,
      settled,
    );
    // Preserve a detected change if the device sleeps during its quiet period (#6284).
    const effect = this.deps.deriveTapEffect(
      previousObservation,
      settled.screenOff ? trustedEnteringObservation : effectObservation,
    );
    if (!settled.matched && effect?.screenChanged !== true) {
      return { effect, observation: currentObservation };
    }
    return {
      effect,
      observation: {
        ...effectObservation,
        gfxMetrics: effectObservation.gfxMetrics ?? currentObservation.gfxMetrics,
        perfTiming: effectObservation.perfTiming ?? currentObservation.perfTiming,
      },
    };
  }

  /**
   * Confirm a hierarchy-only tap effect is the settled DESTINATION rather than a
   * transient intermediate mutation before trusting it as terminal (issue
   * #6284). Polls (via the injected waiter/FakeTimer seam) until either:
   *  - `activeWindow` changes vs the baseline — authoritative, stop at once; or
   *  - the hierarchy hash holds UNCHANGED for a real quiet period of wall-clock
   *    time (`POST_TAP_SETTLE_QUIET_PERIOD_MS`) — the transition has settled.
   *
   * Settlement is a wall-clock quiet-period DEADLINE, not a count of equal
   * comparisons, and that is what makes `baseline → A → A → B` reach B. A
   * comparison count treats the very first poll — taken immediately, with no
   * `pollMs` sleep yet elapsed — as if it proved stability, so a transient A
   * that persists just one interval before a delayed B would settle on A. The
   * deadline instead starts a clock when a hash first appears and accepts it
   * only once it has genuinely held for the quiet period; a B that arrives after
   * that interval resets the clock and is reached. A hierarchy-less (null-hash)
   * poll cannot start or extend a quiet period — it resets the run — so a run of
   * rootless captures never masquerades as a stable screen.
   *
   * Staleness robustness lives in the poll floor, NOT in this predicate and NOT
   * in `compareViewHierarchy`: the entering reference (seeded here from the
   * entering capture's `updatedAt`) forces every poll strictly past that
   * capture, so an unchanged hash across the quiet period is a genuinely-held
   * fresh screen — never a stale snapshot re-served masking a later fresh
   * destination. That keeps `compareViewHierarchy` a pure hash diff, so a stale
   * baseline can never block a legitimate same-window dialog diff (the
   * entanglement root of the earlier incremental attempt).
   */
  async settleHierarchyOnlyChange(
    previousObservation: ObserveResult,
    currentObservation: ObserveResult,
    signal?: AbortSignal,
  ): Promise<{ effect: TapOnElementResult["effect"]; observation: ObserveResult }> {
    // Hash whose quiet period is currently being timed, and when that run began.
    let quietHash: string | null = null;
    let quietSinceMs = 0;
    const settled = await this.deps.waitForCondition().execute(
      (observation) => {
        const effect = this.deps.deriveTapEffect(previousObservation, observation);
        if (
          this.deps.compareActiveWindow(previousObservation, observation)?.screenChanged === true ||
          effect?.basis === "screenIdentity changed"
        ) {
          return { matched: true };
        }
        const currentHash = this.deps.hashViewHierarchy(observation.viewHierarchy ?? null);
        const now = this.deps.timer.now();
        if (currentHash === null) {
          // A hierarchy-less poll proves nothing about stability; reset the run.
          quietHash = null;
          return { matched: false };
        }
        if (currentHash !== quietHash) {
          // A new (or first) hash: start its quiet-period clock now. Never
          // settles on this frame — a real interval must elapse first.
          quietHash = currentHash;
          quietSinceMs = now;
          return { matched: false };
        }
        // Same hash as the run's start: accept only once it has genuinely held
        // for the full quiet period of wall-clock time.
        return { matched: now - quietSinceMs >= POST_TAP_SETTLE_QUIET_PERIOD_MS };
      },
      {
        // The predicate reads activeWindow, which needs per-poll back-stack reconciliation.
        readBackStackEachPoll: true,
        timeoutMs: POST_TAP_EFFECT_TIMEOUT_MS,
        pollMs: POST_TAP_EFFECT_POLL_MS,
        signal,
        // Device-clock-domain floor seed (issue #6284). See method doc.
        initialMinTimestampMs: hierarchyUpdatedAtToMillis(currentObservation.viewHierarchy),
        // A still screen pushes nothing; cached copies cannot prove a quiet period (#9587).
        skipWaitForFresh: true,
        requireFreshExtraction: true,
      },
    );

    const effectObservation = this.resolveSettleTimeoutObservation(
      previousObservation,
      currentObservation,
      settled,
    );

    // Issue #6284: preserve the already-established `screenChanged: true` when
    // the settle poll's final observation is a DEFINITIVE screen-off terminal
    // (the device went to sleep mid-settle). That capture legitimately carries
    // no viewHierarchy, so re-deriving from scratch would find only an unchanged
    // `activeWindow` and flip the effect back to `screenChanged: false`,
    // erasing the transition that already entered this settle.
    const isDefinitiveScreenOffTerminal = settled.screenOff === true;
    const effect: TapOnElementResult["effect"] = isDefinitiveScreenOffTerminal
      ? { screenChanged: true, basis: "viewHierarchy changed" }
      : this.deps.deriveTapEffect(previousObservation, effectObservation);
    return {
      effect,
      observation: {
        ...effectObservation,
        gfxMetrics: effectObservation.gfxMetrics ?? currentObservation.gfxMetrics,
        perfTiming: effectObservation.perfTiming ?? currentObservation.perfTiming,
      },
    };
  }

  /**
   * Which observation `settleHierarchyOnlyChange` should trust when its poll
   * timed out. A clean stop (or a screen-off terminal) always yields the poll's
   * final observation. On timeout, prefer the trusted entering change over a
   * final poll that is untrustworthy (explicitly stale, or carrying no
   * hierarchy) so a temporarily-unresponsive proxy doesn't erase a real,
   * already-observed change; otherwise the final poll is the freshest evidence.
   */
  resolveSettleTimeoutObservation(
    previousObservation: ObserveResult,
    currentObservation: ObserveResult,
    settled: WaitForConditionResult,
  ): ObserveResult {
    const effectObservation = settled.observation;
    const finalPollIsDefinitiveScreenOff = settled.screenOff === true;
    if (!settled.timedOut || finalPollIsDefinitiveScreenOff) {
      return effectObservation;
    }
    const currentObservationIsTrustedChange =
      currentObservation.freshness?.isFresh !== false &&
      this.deps.deriveTapEffect(previousObservation, currentObservation)?.screenChanged === true;
    const finalPollIsUntrustworthy =
      effectObservation.freshness?.isFresh === false ||
      this.deps.hashViewHierarchy(effectObservation.viewHierarchy ?? null) === null;
    return currentObservationIsTrustedChange && finalPollIsUntrustworthy
      ? currentObservation
      : effectObservation;
  }
}
