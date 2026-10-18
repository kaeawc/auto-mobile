import type { Element, ObserveResult, TapOnElementResult, ViewHierarchyResult } from "../../models";
import type { TapOnElementOptions } from "../../models/TapOnElementOptions";
import type { PerformanceTracker } from "../../utils/PerformanceTracker";
import type {
  SelectionCaptureState,
  SelectionStateTracker,
} from "../navigation/SelectionStateTracker";
import type { LongPressMetadata } from "./LongPressMetadataDetector";
import { describeFocusTarget } from "./tapFocusIdentity";
import type { TapOnFocusOutcome } from "./tapResultMarkers";
import type { TapVerificationOptions } from "./tapVerificationOptions";

/** What the post-gesture finalize phase needs from the owning tap action. */
export interface TapFinalizeHost {
  /** Routed through the owner so overriding/spying on the public test seams observes it. */
  deriveTapEffectAfterPostTapObservation(
    previousObservation: ObserveResult | null,
    currentObservation: ObserveResult,
    signal?: AbortSignal,
  ): Promise<{ effect: TapOnElementResult["effect"]; observation: ObserveResult }>;
  enforceFreshnessConsistencyWithEffect(
    previousObservation: ObserveResult | null,
    result: { effect?: TapOnElementResult["effect"]; observation?: ObserveResult },
  ): void;
  applyEnsureCheckedResult(
    result: TapOnElementResult,
    options: TapVerificationOptions,
    signal?: AbortSignal,
  ): Promise<void>;
  captureTerminalObservationScreenshot(
    observation: ObserveResult | undefined,
    perf: PerformanceTracker,
    signal?: AbortSignal,
  ): Promise<void>;
  recordDeferredPredictionOutcome(result: unknown, finalObservation: ObserveResult): Promise<void>;
  selectionStateTracker(): Pick<SelectionStateTracker, "finalize">;
  verifyFocusAfterTap(
    result: TapOnElementResult,
    verify: (observation: ObserveResult | undefined) => boolean,
    signal?: AbortSignal,
  ): Promise<boolean>;
  verifyFocusedInputTarget(
    options: TapOnElementOptions,
    target: Element,
    observation?: ObserveResult,
    labelText?: string,
    selectedIndex?: number,
    preTapHierarchy?: ViewHierarchyResult,
  ): boolean;
  detectLongPressMetadata(
    previousObservation: ObserveResult | null,
    currentObservation?: ObserveResult,
  ): LongPressMetadata;
}

/** Inputs the orchestrator captured while the gesture ran. */
export interface TapFinalizeContext {
  options: TapOnElementOptions;
  requestedAction: NonNullable<TapOnElementOptions["action"]>;
  effectiveAction: TapOnElementOptions["action"];
  previousObserveResult: ObserveResult | null;
  selectionCapture: SelectionCaptureState | null;
  focusTarget: Element | undefined;
  focusLabelText: string | undefined;
  preTapHierarchy: ViewHierarchyResult | undefined;
  perf: PerformanceTracker;
  signal?: AbortSignal;
}

/** After the gesture: settle the effect, verify state, finalize selection, report long-press metadata. */
export class TapFinalizePhase {
  constructor(private readonly host: TapFinalizeHost) {}

  async finalize(result: TapOnFocusOutcome, ctx: TapFinalizeContext): Promise<TapOnFocusOutcome> {
    const { options, previousObserveResult, perf, signal } = ctx;
    if (result.success && result.observation && result.element) {
      const postTap = await this.host.deriveTapEffectAfterPostTapObservation(
        previousObserveResult,
        result.observation,
        signal,
      );
      result.effect = postTap.effect;
      // The observation that established the effect must be returned and become
      // the caller's diff baseline, rather than the earlier source capture.
      result.observation = postTap.observation;
      await this.host.applyEnsureCheckedResult(result, options, signal);
      await this.host.captureTerminalObservationScreenshot(result.observation, perf, signal);
      await this.host.recordDeferredPredictionOutcome(result, result.observation);
      const selectedElements = await this.host.selectionStateTracker().finalize({
        action: ctx.effectiveAction,
        selectionState: ctx.selectionCapture,
        currentObservation: result.observation,
        previousObservation: previousObserveResult,
        element: result.element,
        effect: postTap.effect,
        signal,
      });
      if (selectedElements.length > 0) {
        result.observation.selectedElements = selectedElements;
      }
      this.host.enforceFreshnessConsistencyWithEffect(previousObserveResult, result);
    }

    await this.confirmFocusAfterTap(result, ctx);

    if (ctx.effectiveAction === "longPress") {
      const metadata = this.host.detectLongPressMetadata(previousObserveResult, result.observation);
      return { ...result, ...metadata };
    }
    return result;
  }

  /** Mark a focus-requested tap as failed unless the focused field matches the target (mutates `result`). */
  private async confirmFocusAfterTap(
    result: TapOnFocusOutcome,
    ctx: TapFinalizeContext,
  ): Promise<void> {
    const { options, focusTarget, focusLabelText, preTapHierarchy, signal } = ctx;
    if (ctx.requestedAction !== "focus" || !result.success || result.wasAlreadyFocused) {
      return;
    }
    const target = focusTarget ?? result.element;
    result.focusVerified = await this.host.verifyFocusAfterTap(
      result,
      (observation) =>
        this.host.verifyFocusedInputTarget(
          options,
          target,
          observation,
          focusLabelText,
          result.selectedElement?.indexInMatches,
          preTapHierarchy,
        ),
      signal,
    );
    if (!result.focusVerified) {
      result.success = false;
      result.error = `Failed to confirm focus on editable input ${describeFocusTarget(target, options)}: the focused field could not be matched to the target`;
    }
  }
}
