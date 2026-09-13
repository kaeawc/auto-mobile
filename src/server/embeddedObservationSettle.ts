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
 * The ONLY fields the action's own capture may contribute to the merged
 * observation when the settle loop's capture is adopted.
 *
 * This list is deliberately a whitelist rather than the deletion list it
 * replaces. A deletion list has to enumerate every field `ObserveScreen`
 * derives from a hierarchy, and it grew once per review round as another one
 * was found: first the screen state it leaves UNSET on a destination that no
 * longer has it (`focusedElement`, `intentChooserDetected`, capture `error`s),
 * then `screenIdentity`, which an iOS destination without identity signals is
 * assigned as an explicit `undefined`, and which a stale value would let diff
 * mode read a cross-screen transition as same-screen. Every future
 * capture-derived field would join it, and the failure mode of forgetting one
 * is silent and wrong.
 *
 * Inverting it ends the series: the settled capture describes the screen and
 * therefore owns every capture-derived field by construction, including the
 * ones nobody has enumerated. What the settled capture cannot know is what the
 * ACTION did, and that set is small, closed, and greppable — the action
 * pipeline writes `gfxMetrics`/`perfTiming` (`BaseVisualChange`),
 * `selectedElements` (`TapOnElement`) and `displayedTimeMetrics` (`LaunchApp`)
 * onto the observation AFTER the observe, and a handler that ran its own
 * `waitFor` attaches the wait's own record. Audits are here because the settle
 * poll deliberately skips them (`skipAccessibilityAudit: true`): an explicitly
 * requested audit must not be silently voided by a gate the caller did not ask
 * for.
 *
 * Anything NOT listed here — `rawViewHierarchy`, `observeScope`,
 * `recompositionSummary`, `freshness`, `screenIdentity`, … — is capture-derived
 * and comes from the settled capture or not at all.
 */
const ACTION_AUTHORED_OBSERVATION_METADATA = [
  "gfxMetrics",
  "perfTiming",
  "perfTimingTruncated",
  "perfSnapshot",
  "selectedElements",
  "displayedTimeMetrics",
  "accessibilityAudit",
  "performanceAudit",
  // A handler-run `waitFor`'s own record of what it waited for and found
  // (`openLink`'s integrated wait, #3490 §5). It describes the wait, not the
  // screen, so the settled capture has no opinion about it.
  "awaitedElement",
  "awaitDuration",
  "awaitTimeout",
  "matched",
  "timedOut",
  "polls",
  "waitMs",
  "matchedElement",
  "candidates",
] as const;

/**
 * Fold the action's own metadata onto the settled capture, so the fresh
 * hierarchy and everything derived from it wins while metadata only the ACTION
 * could attach survives.
 *
 * Built FROM the settled capture, not from the action's: the settle loop
 * re-reads the screen through `ObserveScreen`, which knows nothing about the
 * action that ran, so only {@link ACTION_AUTHORED_OBSERVATION_METADATA} may be
 * carried across — and only into a slot the settled capture left empty.
 *
 * Keys the settled capture carries with an explicit `undefined` value are
 * dropped rather than copied: `ObserveScreen` assigns `undefined` where a
 * screen simply does not have something (no focused node, no identity
 * signals), and the contract downstream is absence, not a present-but-undefined
 * key.
 */
function mergeActionMetadata(
  actionObservation: ObserveResult,
  settledObservation: ObserveResult,
): ObserveResult {
  const merged = Object.fromEntries(
    Object.entries(settledObservation).filter(([, value]) => value !== undefined),
  ) as ObserveResult;
  for (const field of ACTION_AUTHORED_OBSERVATION_METADATA) {
    if (merged[field] === undefined && actionObservation[field] !== undefined) {
      Object.assign(merged, { [field]: actionObservation[field] });
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
 * The action's embedded observation, or `undefined` when the payload carries
 * none in a usable shape (absent, primitive, or an array).
 */
function readEmbeddedObservation(payload: Record<string, unknown>): ObserveResult | undefined {
  const observation = payload.observation;
  if (!observation || typeof observation !== "object" || Array.isArray(observation)) {
    return undefined;
  }
  return observation as ObserveResult;
}

/**
 * Apply {@link settleEmbeddedObservation} to a completed action-tool envelope
 * in place, stamping `observation.settled` so a client can tell a
 * stability-checked capture from an unchecked one without guessing (issue
 * #6866). Runs BEFORE `finalizeToolResponse`, so the settled hierarchy is what
 * the session caches, diffs against, and projects to the skeleton.
 *
 * A complete no-op for `observe` (which owns its own `waitFor` settle at the
 * payload top level), for internal calls, and for a payload with no embedded
 * observation. A FAILED action is still stamped — it just is not re-observed,
 * so the tool pipeline can call this unconditionally.
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
  const observation = readEmbeddedObservation(view.payload);
  if (!observation) {
    return;
  }
  // A handler that ran its OWN stability wait publishes the verdict at the
  // payload top level (`systemTray({action: "tap"})` polls for a changed
  // hierarchy that then stays structurally stable; `openLink`'s `waitFor` +
  // `settled` does the same). That verdict describes the capture the handler is
  // returning, and it is strictly better evidence than this gate's default
  // `false` for an action class the gate does not recognise. Honour it rather
  // than stamping a contradiction into the same response.
  const handlerSettled = view.payload.settled === true;
  if (view.payload.success === false) {
    // The action failed; re-observing would buy the client nothing and would
    // charge a settle budget to an error path. The capture it did return is
    // still an action observation, so it carries the honest verdict for a
    // capture that never faced a stability check (e.g. `sendKeys` stopping on a
    // failed command but keeping its post-command observation).
    writeToolEnvelopePayload(view, {
      ...view.payload,
      observation: { ...observation, settled: handlerSettled },
    });
    return;
  }

  if (handlerSettled) {
    // The handler's own gate already proved THIS capture stable, so there is
    // nothing left for this one to establish. Running it anyway would spend a
    // second settle budget on a screen that is done moving, and on a screen
    // that never reaches structural stability (a ticking clock) it would time
    // out, adopt a later frame, and stamp `observation.settled: false`
    // underneath the payload-level `settled: true` the handler published —
    // one response carrying two contradictory verdicts, with wait metadata
    // describing a capture that is no longer there. A handler verdict is never
    // downgraded (#6890 review), and the coherent way to honour that is to
    // leave the capture it describes in place.
    writeToolEnvelopePayload(view, {
      ...view.payload,
      observation: { ...observation, settled: true },
    });
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
        observation,
        settleObserve,
        signal: ctx.signal,
      })
    : { observation, settled: false };

  writeToolEnvelopePayload(view, {
    ...view.payload,
    observation: { ...outcome.observation, settled: outcome.settled },
  });
}
