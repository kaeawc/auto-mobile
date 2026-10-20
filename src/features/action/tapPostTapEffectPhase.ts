import type { TapOnCall } from "./ActionCall";
import type { ObserveResult, TapOnElementResult, ViewHierarchyResult } from "../../models";
import { hierarchyUpdatedAtToMillis } from "../observe/observeTimestamp";
import type { ScreenSizeForOffscreenCheckOptions } from "../../models/ScreenSize";
import type { PostTapSettler } from "./tapPostTapSettler";

/** What the post-tap effect/freshness phase needs from the owning tap action. */
export interface PostTapEffectHost {
  /** Restamp the observation's rotation after its hierarchy was re-captured (platform-specific). */
  applyRefreshedObservationRotation(
    observation: ObserveResult,
    hierarchyRotation: number | undefined,
  ): void;
  /** Whether the platform strategy settles a post-tap change across a detection window. */
  settlesPostTapChange(): boolean;
  settler(): Pick<PostTapSettler, "waitForPostTapChange" | "settleHierarchyOnlyChange">;
  deriveTapEffect(
    previousObservation: ObserveResult | null,
    currentObservation: ObserveResult | undefined,
  ): TapOnElementResult["effect"] | undefined;
  getScreenSizeFromHierarchy(
    hierarchy: ViewHierarchyResult,
    options?: ScreenSizeForOffscreenCheckOptions,
  ): ObserveResult["screenSize"] | undefined;
}

/**
 * Realign a cached observation's freshness verdict to the live re-capture that
 * just replaced its hierarchy (issue #6284). The refresh verified the tree
 * against the device on THIS call, so a lingering pre-refresh `isFresh: false`
 * verdict no longer describes the attached data.
 *
 * Promote ONLY a `cache_age` failure — a stale/unverified/over-budget cache
 * entry, which is exactly what swapping in a freshly-captured hierarchy
 * resolves. A `window_identity` failure (wrong-window, status-bar-only,
 * activity-attribution mismatch, incomplete capture, missing foreground
 * window — issue #6284 P1) describes WHICH window/app the tree belongs to; the
 * refresh replaced only `viewHierarchy` and did not recollect or reconcile
 * `activeWindow`/attribution, and the re-capture may itself be from the wrong
 * window, so clearing that warning would make an internally-inconsistent
 * result look trustworthy. A verdict that was already fresh (or absent), or
 * failed for any other reason, is left untouched. Called exclusively from
 * {@link TapPostTapEffectPhase.replaceObservationHierarchy}.
 */
export function markObservationFreshAfterSyncRefresh(observeResult: ObserveResult): void {
  const freshness = observeResult.freshness;
  const hierarchy = observeResult.viewHierarchy;
  const actualTimestamp = hierarchyUpdatedAtToMillis(hierarchy);
  const hasCompleteLiveHierarchy =
    hierarchy !== undefined &&
    typeof hierarchy.hierarchy === "object" &&
    hierarchy.hierarchy !== null &&
    !("error" in hierarchy.hierarchy) &&
    hierarchy.ctrlProxyIncomplete !== true &&
    hierarchy.fresh !== false &&
    actualTimestamp !== undefined;
  if (
    hasCompleteLiveHierarchy &&
    freshness?.isFresh === false &&
    freshness.category === "cache_age"
  ) {
    observeResult.freshness = {
      ...freshness,
      isFresh: true,
      verified: true,
      actualTimestamp,
      ageMs: 0,
      staleDurationMs: undefined,
      warning: undefined,
      category: undefined,
    };
  }
}

/** Post-tap effect derivation and observation freshness bookkeeping for tapOn. */
export class TapPostTapEffectPhase {
  constructor(private readonly host: PostTapEffectHost) {}

  async deriveEffectAfterPostTapObservation(
    previousObservation: ObserveResult | null,
    currentObservation: ObserveResult,
    signal?: AbortSignal,
    call?: Pick<TapOnCall, "settlePostTapEffect">,
  ): Promise<{ effect: TapOnElementResult["effect"]; observation: ObserveResult }> {
    const immediateEffect = this.host.deriveTapEffect(previousObservation, currentObservation);
    // Retry verification already ran during gesture dispatch. Only the optional
    // destination-effect polling is skipped; retain the final observed capture.
    if (
      call?.settlePostTapEffect === false ||
      !this.host.settlesPostTapChange() ||
      !previousObservation
    ) {
      return { effect: immediateEffect, observation: currentObservation };
    }

    if (immediateEffect?.screenChanged !== true) {
      // A stable source tree can arrive before Android begins the activity
      // transition. Keep the full detection window before concluding no change;
      // a quiet source screen is not proof that the tap had no effect.
      return this.host
        .settler()
        .waitForPostTapChange(previousObservation, currentObservation, signal);
    }

    if (immediateEffect.basis !== "viewHierarchy changed") {
      // A `screenIdentity`/`activeWindow` change is authoritative on its own —
      // it names a real destination window, so trust it immediately.
      return { effect: immediateEffect, observation: currentObservation };
    }

    // Issue #6284: a hierarchy-ONLY change (activeWindow unchanged) is not, by
    // itself, proof of the DESTINATION screen. The first post-tap observation
    // uses `changeExpected: false`, so a transient intermediate mutation (a
    // focused/selected/checked flip, or a partial hierarchy update before a
    // delayed dialog/navigation) can look identical to a real change on the
    // very first frame. Settle it across a real stability interval before
    // trusting it as terminal, so a transient A isn't returned in place of the
    // actual destination B (`baseline → A → A → B` must reach B).
    return this.host
      .settler()
      .settleHierarchyOnlyChange(previousObservation, currentObservation, signal);
  }

  /**
   * Guard against a self-contradicting response (issue #6219): `effect` says the
   * screen already changed (`screenChanged: true`), but the observation attached
   * to the SAME payload predates that transition and still stamps
   * `freshness.verified/isFresh: true` — a client sees a stale, pre-tap tree
   * asserted as trustworthy in the very response that also reports the window
   * changed. Re-derives the comparison against `result.observation` as it
   * stands right before it is returned (after any downstream mutation, e.g.
   * `selectionStateTracker.finalize`), rather than trusting whichever
   * intermediate observation `effect` was originally computed from, so a later
   * mutation cannot leave the two fields disagreeing in the response.
   *
   * Only ever retracts freshness — never invents a `screenChanged: true` an
   * observation didn't earn — and only when `effect` itself claims a change.
   */
  enforceFreshnessConsistency(
    previousObservation: ObserveResult | null,
    result: { effect?: TapOnElementResult["effect"]; observation?: ObserveResult },
  ): void {
    if (!previousObservation || !result.observation || result.effect?.screenChanged !== true) {
      return;
    }
    if (result.observation.wakefulness === "Asleep") {
      // Issue #6284: a definitive screen-off terminal legitimately carries no
      // viewHierarchy, so a re-derivation against it cannot reproduce the
      // `screenChanged: true` (there is nothing to diff). This is NOT a stale
      // pre-tap tree the client should re-observe past — it is the real
      // post-tap state (the screen went off). Retracting freshness here would
      // stamp the wrong warning ("predates the detected transition") over a
      // faithful terminal capture, so leave it intact.
      return;
    }
    const reDerived = this.host.deriveTapEffect(previousObservation, result.observation);
    if (reDerived?.screenChanged === true) {
      // The observation being returned is itself consistent with the detected
      // transition — nothing to correct.
      return;
    }
    const existing = result.observation.freshness;
    result.observation.freshness = {
      ...(existing ?? { isFresh: true }),
      verified: false,
      isFresh: false,
      category: "effect_inconsistent",
      warning:
        "effect.screenChanged is true, but this observation's own capture still matches the " +
        "pre-action screen — it predates the detected transition. Call observe again for the " +
        "current, post-action state.",
    };
  }

  /**
   * The ONLY sanctioned way to swap an observation's `viewHierarchy` for one
   * captured later in `execute` (issue #6284). Folding "replace hierarchy" and
   * "refresh freshness" into one helper means no call site can do the first
   * without the second: replacing a cached observation's hierarchy with a
   * freshly-captured one while leaving its OLD `freshness` (e.g. `isFresh:
   * false` from the pre-tap cache) stamped on the new, just-verified tree would
   * surface fresh data labelled stale in the response.
   *
   * Pass `refreshedFromDevice: true` only when `viewHierarchy` was just captured
   * from the device on this call (a genuine live re-capture) — that is the case
   * whose freshness must be realigned. A replacement with data already in hand
   * (the caller's own hierarchy returned unchanged) leaves freshness untouched.
   */
  replaceObservationHierarchy(
    observeResult: ObserveResult,
    viewHierarchy: ViewHierarchyResult,
    refreshedFromDevice: boolean,
  ): void {
    const screenSize = this.host.getScreenSizeFromHierarchy(viewHierarchy, {
      observationScreenSize: observeResult.screenSize,
      display: observeResult.viewHierarchy,
    });
    observeResult.viewHierarchy = viewHierarchy;
    // The replacement is device-authored; keep the enclosing observation in
    // that same clock domain so later freshness floors never compare it with
    // the host time from the cached observation it replaced.
    const updatedAt = hierarchyUpdatedAtToMillis(viewHierarchy);
    if (updatedAt !== undefined) {
      observeResult.updatedAt = updatedAt;
    }
    if (screenSize) {
      observeResult.screenSize = screenSize;
    } else if (observeResult.screenSize) {
      observeResult.screenSize = { width: 0, height: 0 };
    }
    this.host.applyRefreshedObservationRotation(observeResult, viewHierarchy.rotation);
    if (refreshedFromDevice) {
      markObservationFreshAfterSyncRefresh(observeResult);
    }
  }
}
