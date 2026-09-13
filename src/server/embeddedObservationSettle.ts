import type { ObserveResult } from "../models/ObserveResult";
import type { SettleObserve } from "../features/observe/interfaces/SettleObserve";
import { hierarchyUpdatedAtToMillis } from "../features/observe/observeTimestamp";
import {
  classifyObservationAction,
  isSettleGatedActionClass,
  type ObservationActionClass,
} from "../features/action/observationActionClass";
import { combineAbortSignals } from "../utils/AbortContext";
import { logger } from "../utils/logger";
import { errorMessage } from "../utils/describeUnknownError";
import { readToolEnvelopePayload, writeToolEnvelopePayload } from "./toolEnvelopePayload";

/**
 * Budget for the embedded-observation settle gate (issue #6866).
 *
 * Deliberately tighter than the standalone `observe(waitFor: {for: "stable"})`
 * default (`DEFAULT_SETTLE_TIMEOUT_MS`, 2500ms): this runs on the hot path of
 * EVERY navigation-class action, and a screen that never reaches structural
 * stability (a ticking clock, a blinking caret) would otherwise spend the full
 * standalone budget on every tap. A screen that is merely finishing inflation
 * settles in two polls, so the bound is only ever paid by screens that would
 * not have settled anyway — and those report `settled: false` rather than
 * stalling the action.
 */
export const EMBEDDED_OBSERVATION_SETTLE_TIMEOUT_MS = 1000;

/** Poll interval for the gate, matching the shared settle/scroll-idle cadence. */
export const EMBEDDED_OBSERVATION_SETTLE_POLL_MS = 150;

export interface EmbeddedObservationSettleInput {
  actionClass: ObservationActionClass;
  /** The observation the action tool already captured. */
  observation: ObserveResult;
  settleObserve: SettleObserve;
  signal?: AbortSignal;
}

export interface EmbeddedObservationSettleOutcome {
  /** The observation to hand back: the settled capture, or the original one. */
  observation: ObserveResult;
  /** Whether `observation` passed the stability gate. */
  settled: boolean;
}

/**
 * Gate an action tool's embedded observation on hierarchy stability (issue
 * #6866), so the client's first look at a newly-navigated screen is the settled
 * one rather than a half-inflated frame.
 *
 * Reuses the existing `#4389` settle primitive verbatim — two consecutive
 * structurally-equal snapshots per the `#3053` diff, bounded, cancellable,
 * FakeTimer-driven — seeded with the device-authored `updatedAt` of the capture
 * the action already holds, so the loop must read STRICTLY past it. Without
 * that seed a still-fresh cache entry for the half-inflated tree could be
 * served straight back as the "settled" answer.
 *
 * Only `"navigation"` is gated ({@link isSettleGatedActionClass}); every other
 * class keeps its single capture and reports `settled: false`, which is the
 * honest answer for a capture that never faced a stability check.
 */
export async function settleEmbeddedObservation(
  input: EmbeddedObservationSettleInput,
): Promise<EmbeddedObservationSettleOutcome> {
  if (!isSettleGatedActionClass(input.actionClass)) {
    return { observation: input.observation, settled: false };
  }

  // The settle loop's own budget is checked BETWEEN polls, so a single device
  // read that hangs could still overrun it — on a hot path that now runs after
  // every navigation action. Bound the whole gate with a real-clock deadline as
  // well, combined with the caller's signal so a cancelled request stops
  // observing immediately. Real-clock deliberately: it fences a real device
  // read, which no fake clock governs, and fake-backed unit tests resolve long
  // before it can fire.
  const deadline = AbortSignal.timeout(EMBEDDED_OBSERVATION_SETTLE_TIMEOUT_MS);
  try {
    const result = await input.settleObserve.execute({
      timeoutMs: EMBEDDED_OBSERVATION_SETTLE_TIMEOUT_MS,
      pollMs: EMBEDDED_OBSERVATION_SETTLE_POLL_MS,
      signal: combineAbortSignals(input.signal, deadline),
      initialMinTimestampMs: hierarchyUpdatedAtToMillis(input.observation.viewHierarchy),
    });
    return {
      observation: isAdoptableCapture(input.observation, result.observation)
        ? mergeActionMetadata(input.observation, result.observation)
        : input.observation,
      settled: result.settled,
    };
  } catch (error) {
    // Nothing here may fail an action that ALREADY RAN. A settle read that
    // errors (CtrlProxy hiccup, transient device read failure), the deadline
    // above, and request cancellation all degrade the same way: hand back the
    // capture the action took, honestly flagged as unsettled. Rethrowing would
    // turn a completed tap into a tool error, and a client that retried it
    // would tap twice.
    logger.warn(`[EmbeddedObservationSettle] settle failed: ${errorMessage(error)}`, error);
    return { observation: input.observation, settled: false };
  }
}

/**
 * Screen state `ObserveScreen` re-derives from EVERY hierarchy capture, and
 * legitimately leaves UNSET when the screen no longer has it: there is no
 * focused node, no chooser dialog, no capture error. Because it is absent rather
 * than `undefined`-valued on the settled capture, a plain spread would carry the
 * PREVIOUS screen's value through — an `inputText` submit returning the settled
 * destination hierarchy together with the origin screen's `focusedElement`. Each
 * of these is owned by the capture, never by the action, so the settled capture
 * gets the only vote.
 */
const HIERARCHY_DERIVED_OBSERVATION_STATE = [
  "focusedElement",
  "accessibilityFocusedElement",
  "intentChooserDetected",
  "notificationPermissionDetected",
  "error",
  "errors",
] as const;

/**
 * Fold the settled capture over the action's own, so the fresh hierarchy wins
 * while metadata only the ACTION could attach survives.
 *
 * The settle loop re-reads the screen through `ObserveScreen`, which knows
 * nothing about the action that ran: `gfxMetrics` (UI-stability tracking),
 * `perfTiming`, `selectedElements` and the rest are written onto the capture by
 * the action pipeline AFTER the observe. Replacing the observation wholesale
 * would silently drop them. Every key the settled capture actually defines wins,
 * plus {@link HIERARCHY_DERIVED_OBSERVATION_STATE} is cleared when the settled
 * capture does not report it, so no screen state from the half-inflated read
 * outlives the tree it described.
 */
function mergeActionMetadata(
  actionObservation: ObserveResult,
  settledObservation: ObserveResult,
): ObserveResult {
  const defined = Object.fromEntries(
    Object.entries(settledObservation).filter(([, value]) => value !== undefined),
  );
  const merged: ObserveResult = { ...actionObservation, ...defined };
  for (const field of HIERARCHY_DERIVED_OBSERVATION_STATE) {
    if (defined[field] === undefined) {
      delete merged[field];
    }
  }
  return merged;
}

function hasUsableHierarchy(observation: ObserveResult): boolean {
  const hierarchy = observation.viewHierarchy?.hierarchy;
  return !!hierarchy && typeof hierarchy === "object" && !("error" in hierarchy);
}

/**
 * Whether the settle loop's capture may REPLACE the one the action already
 * holds.
 *
 * A settled capture always qualifies, and so does the newest capture of a screen
 * that simply never stopped moving: it is strictly later than the action's own
 * frame, so handing it back is closer to the truth than the half-inflated tree
 * #6866 is about. What must never qualify is the loop's LAST-RESORT fallback.
 * `pollObserveUntil` returns `newestTrustworthyObservation ?? observation` on
 * timeout, and when NO poll was admissible that second operand is whatever the
 * final read happened to be — a pre-action cache entry the freshness wait gave
 * up on, or a capture whose freshness `ObserveScreen` retracted (a wrong-window
 * tree, #5867). Adopting one of those would move the client's view BACKWARDS
 * off a capture that is known-good and known-post-action.
 *
 * So: reject an explicitly-stale capture, and reject one that is not provably
 * at-or-after the action's own device-clock timestamp. When the action's capture
 * carries no device timestamp the loop had no floor to enforce either, so there
 * is nothing to compare and a usable hierarchy is accepted as before.
 */
function isAdoptableCapture(
  actionObservation: ObserveResult,
  settledObservation: ObserveResult,
): boolean {
  if (!hasUsableHierarchy(settledObservation)) {
    return false;
  }
  const freshness = settledObservation.freshness;
  if (freshness?.isFresh === false || freshness?.verified === false) {
    return false;
  }
  const actionMs = hierarchyUpdatedAtToMillis(actionObservation.viewHierarchy);
  if (actionMs === undefined) {
    return true;
  }
  const settledMs = hierarchyUpdatedAtToMillis(settledObservation.viewHierarchy);
  return settledMs !== undefined && settledMs >= actionMs;
}

export interface EmbeddedObservationSettleContext {
  name: string;
  args?: Record<string, unknown>;
  /** Internal tool-to-tool calls are never gated and never stamped. */
  internal: boolean;
  /**
   * Build the settle delegate for the resolved device, or `undefined` when no
   * device is available (direct/no-device calls). Called lazily so a non-gated
   * action never constructs one.
   */
  createSettleObserve: () => SettleObserve | undefined;
  signal?: AbortSignal;
}

/**
 * Apply {@link settleEmbeddedObservation} to a completed action-tool envelope
 * in place, stamping `observation.settled` so a client can tell a
 * stability-checked capture from an unchecked one without guessing (issue
 * #6866). Runs BEFORE `finalizeToolResponse`, so the settled hierarchy is what
 * the session caches, diffs against, and projects to the skeleton.
 *
 * A no-op for `observe` (which owns its own `waitFor` settle at the payload top
 * level), for internal calls, for a failed action, and for a payload with no
 * embedded observation.
 */
export async function settleEmbeddedObservationInResponse(
  response: unknown,
  ctx: EmbeddedObservationSettleContext,
): Promise<void> {
  if (ctx.internal || ctx.name === "observe") {
    return;
  }
  const view = readToolEnvelopePayload(response);
  if (!view) {
    return;
  }
  const observation = view.payload.observation;
  if (!observation || typeof observation !== "object" || Array.isArray(observation)) {
    return;
  }
  if (view.payload.success === false) {
    // The action failed; re-observing would buy the client nothing and would
    // charge a settle budget to an error path.
    return;
  }

  const actionClass = classifyObservationAction(ctx.name, ctx.args);
  const settleObserve = isSettleGatedActionClass(actionClass)
    ? ctx.createSettleObserve()
    : undefined;
  if (isSettleGatedActionClass(actionClass) && !settleObserve) {
    // No device to re-observe with. Leave the response exactly as the handler
    // built it rather than stamping a gate verdict that was never evaluated.
    return;
  }

  const outcome = settleObserve
    ? await settleEmbeddedObservation({
        actionClass,
        observation: observation as ObserveResult,
        settleObserve,
        signal: ctx.signal,
      })
    : { observation: observation as ObserveResult, settled: false };

  writeToolEnvelopePayload(view, {
    ...view.payload,
    observation: { ...outcome.observation, settled: outcome.settled },
  });
}
