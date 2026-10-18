import {
  ActionableError,
  ObserveResult,
  TapOnElementResult,
  ViewHierarchyResult,
} from "../../models";
import type { Element, ElementSelectionResult, TapOnSelectedElement } from "../../models";
import type { TapOnElementOptions } from "../../models/TapOnElementOptions";
import { isTruthyFlag } from "../utility/elementProperties";
import { sequenceBackoff } from "../../utils/Backoff";
import { throwIfAborted } from "../../utils/toolUtils";
import type { Timer } from "../../utils/SystemTimer";
import { POST_TAP_REFRESH_TIMEOUT_MS } from "./androidGhostTapRetry";
import type { AndroidTapVerification, TapVerificationOptions } from "./tapVerificationOptions";

export const ENSURE_CHECKED_POLL_BACKOFF_MS = [50, 100, 200, 400] as const;
export const ensureCheckedPollBackoff = sequenceBackoff(ENSURE_CHECKED_POLL_BACKOFF_MS);
export const ENSURE_CHECKED_POLL_TIMEOUT_MS = ENSURE_CHECKED_POLL_BACKOFF_MS.reduce(
  (total, delayMs) => total + delayMs,
  0,
);

type SearchUntilStats = NonNullable<TapOnElementResult["searchUntil"]>;

/** What the ensureChecked phase needs from the owning tap action. */
export interface EnsureCheckedHost {
  readonly timer: Timer;
  tapVerificationRefresh(context: {
    refresh?: AndroidTapVerification["refresh"];
    screenSize?: ObserveResult["screenSize"];
    signal?: AbortSignal;
  }): AndroidTapVerification["refresh"];
  findElementInHierarchy(
    options: TapVerificationOptions,
    hierarchy: ViewHierarchyResult,
  ): { selection: ElementSelectionResult };
  withObservationScreenSize(
    options: TapVerificationOptions,
    observation: Partial<Pick<ObserveResult, "viewHierarchy" | "screenSize">>,
  ): TapVerificationOptions;
  replaceObservationHierarchy(
    observation: ObserveResult,
    hierarchy: ViewHierarchyResult,
    refreshedFromDevice: boolean,
  ): void;
  elementAffordances(element: Element): string[];
  elementIdentity(element: Element): string;
}

/** Pre-tap guard, fresh-toggle refresh and post-tap checked-state polling for tapOn ensureChecked. */
export class TapEnsureCheckedPhase {
  constructor(private readonly host: EnsureCheckedHost) {}

  beforeTap(
    options: TapOnElementOptions,
    element: Element,
    selectedElement: TapOnSelectedElement | undefined,
    searchUntil: SearchUntilStats,
  ): TapOnElementResult | undefined {
    if (options.ensureChecked === undefined) {
      return undefined;
    }
    if (!isTruthyFlag(element.checkable)) {
      const affordances = this.host.elementAffordances(element);
      throw new ActionableError(
        `tapOn ensureChecked requires a toggle element; ${this.host.elementIdentity(element)} has affordances: ${affordances.join(", ") || "none"}`,
      );
    }
    if (isTruthyFlag(element.checked) !== options.ensureChecked) {
      return undefined;
    }
    return {
      success: true,
      action: options.action,
      element,
      selectedElement,
      searchUntil,
      skipped: "already-checked",
    };
  }

  async refreshSelection(
    options: TapVerificationOptions,
    observation: ObserveResult,
    selection: ElementSelectionResult,
    signal?: AbortSignal,
  ): Promise<{ selection: ElementSelectionResult; viewHierarchy: ViewHierarchyResult }> {
    if (options.ensureChecked === undefined) {
      return { selection, viewHierarchy: observation.viewHierarchy as ViewHierarchyResult };
    }
    const freshHierarchy = await this.host.tapVerificationRefresh({
      refresh: options.verification?.refresh,
      screenSize: observation.screenSize,
      signal,
    })(POST_TAP_REFRESH_TIMEOUT_MS);
    if (!freshHierarchy) {
      throw new ActionableError("tapOn ensureChecked: unable to refresh toggle before tapping");
    }
    const refound = this.host.findElementInHierarchy(
      this.host.withObservationScreenSize(options, observation),
      freshHierarchy,
    ).selection;
    if (!refound.element) {
      throw new ActionableError("tapOn ensureChecked: toggle not found in fresh hierarchy");
    }
    this.host.replaceObservationHierarchy(observation, freshHierarchy, true);
    return { selection: refound, viewHierarchy: freshHierarchy };
  }

  private async afterTap(
    options: TapVerificationOptions,
    observation: ObserveResult,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    if (options.ensureChecked === undefined) {
      return undefined;
    }
    const readChecked = (): boolean | "not found" => {
      const refound = observation.viewHierarchy
        ? this.host.findElementInHierarchy(
            this.host.withObservationScreenSize(options, observation),
            observation.viewHierarchy,
          ).selection.element
        : undefined;
      return refound ? isTruthyFlag(refound.checked) : "not found";
    };
    let observed: boolean | "not found" = readChecked();
    if (observed !== options.ensureChecked) {
      observed = await this.pollAfterTap(readChecked, options.ensureChecked, observation, {
        signal,
        refresh: options.verification?.refresh,
      });
    }
    return observed === options.ensureChecked
      ? undefined
      : `tapOn ensureChecked: tapped element but checked is now ${observed} (expected ${options.ensureChecked})`;
  }

  async applyResult(
    result: TapOnElementResult,
    options: TapVerificationOptions,
    signal?: AbortSignal,
  ): Promise<void> {
    if (options.ensureChecked === undefined) {
      return;
    }
    const observation = result.observation;
    if (observation === undefined) {
      return;
    }
    const ensureCheckedError = await this.afterTap(options, observation, signal);
    if (ensureCheckedError !== undefined) {
      result.success = false;
      result.error = ensureCheckedError;
    }
  }

  private async pollAfterTap(
    readChecked: () => boolean | "not found",
    expected: boolean,
    observation: ObserveResult,
    context: { signal?: AbortSignal; refresh?: AndroidTapVerification["refresh"] } = {},
  ): Promise<boolean | "not found"> {
    const { signal } = context;
    const deadline = this.host.timer.now() + ENSURE_CHECKED_POLL_TIMEOUT_MS;
    let observed = readChecked();
    for (let attempt = 1; this.host.timer.now() < deadline; attempt++) {
      throwIfAborted(signal);
      const delayMs = Math.min(
        ensureCheckedPollBackoff.delayForAttempt(attempt),
        deadline - this.host.timer.now(),
      );
      await this.host.timer.sleep(delayMs);
      const remainingMs = deadline - this.host.timer.now();
      if (remainingMs <= 0) {
        break;
      }
      const freshHierarchy = await this.host.tapVerificationRefresh({
        refresh: context.refresh,
        screenSize: observation.screenSize,
        signal,
      })(Math.min(POST_TAP_REFRESH_TIMEOUT_MS, remainingMs));
      if (!freshHierarchy) {
        continue;
      }
      this.host.replaceObservationHierarchy(observation, freshHierarchy, true);
      observed = readChecked();
      if (observed === expected) {
        return observed;
      }
    }
    return observed;
  }
}
