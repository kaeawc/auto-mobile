import { AsyncLocalStorage } from "node:async_hooks";
import type { ObserveResult } from "../../../models";
import type { ObservationBackend, ObservationFallbackReason } from "../../../models/ObserveResult";
import {
  findIosSdkBridgeTarget,
  type IosSdkBridgeTarget,
} from "../../observe/ios/iosSdkObservationMerge";
import type { IosSdkTapOutcome } from "../IosSdkBridgeTapRouter";
import type { IosSdkBridgeTextRouter, IosSdkTextAction } from "../IosSdkBridgeTextRouter";
import type { TextActionResult } from "../SendKeys";

/** The public command-result fields for the backend that entered or cleared text (#5159). */
export function iosBackendFields(outcome: IosSdkTapOutcome | undefined): {
  backend?: ObservationBackend;
  fallbackReason?: ObservationFallbackReason;
} {
  if (!outcome) {
    return {};
  }
  return outcome.backend === "xctest"
    ? { backend: "xctest", fallbackReason: outcome.fallbackReason }
    : { backend: "sdk" };
}

export interface IosSdkTextRoutingDeps {
  router: IosSdkBridgeTextRouter;
  /** Reads the screen through the executor's observer, which calls {@link observed}. */
  observe(signal?: AbortSignal): Promise<unknown>;
}

/**
 * sendKeys' half of the iOS SDK observation bridge (#5159): when the focused field is a bridge
 * node, text entry and clear go through the bridge, and XCTest stands in only for an unavailable
 * bridge or an unsupported action.
 *
 * The bridge rejects an action whose capture identity is not its current observation, and any
 * observe moves that observation. So the target picks up the identity of every observation the
 * executor reads, and is refreshed once before its first bridge action when nothing has been read
 * since focus.
 */
export class IosSdkTextRouting {
  private target: IosSdkBridgeTarget | undefined;
  private current = false;
  private readonly outcomes = new AsyncLocalStorage<{ outcome?: IosSdkTapOutcome }>();

  constructor(private readonly deps: IosSdkTextRoutingDeps) {}

  /** The focused field's bridge identity, or undefined when it is not a bridge node. */
  setTarget(target: IosSdkBridgeTarget | undefined): void {
    this.target = target;
    this.current = false;
  }

  observed(observation: Pick<ObserveResult, "viewHierarchy">): void {
    if (!this.target) {
      return;
    }
    const latest = findIosSdkBridgeTarget(observation.viewHierarchy, this.target.elementId);
    if (latest) {
      this.target = latest;
      this.current = true;
    }
  }

  /** Runs one command and attaches the backend its text actions used. */
  async tracked<T extends TextActionResult>(
    run: () => Promise<T>,
  ): Promise<T & { iosBackend?: IosSdkTapOutcome }> {
    const store = this.outcomes.getStore() ?? {};
    const result = await this.outcomes.run(store, run);
    return store.outcome ? { ...result, iosBackend: store.outcome } : result;
  }

  /** IME actions have no bridge form: report the XCTest fallback for a bridge field. */
  imeFields(): ReturnType<typeof iosBackendFields> {
    return this.target
      ? iosBackendFields({ backend: "xctest", fallbackReason: "unsupported" })
      : {};
  }

  insert(
    text: string,
    options: { timeoutMs?: number; signal?: AbortSignal },
    xctest: () => Promise<TextActionResult>,
  ): Promise<TextActionResult> {
    return this.route("insertText", options, xctest, text);
  }

  clear(signal: AbortSignal | undefined, xctest: () => Promise<TextActionResult>) {
    return this.route("clearText", { signal }, xctest);
  }

  private async route(
    action: IosSdkTextAction,
    options: { timeoutMs?: number; signal?: AbortSignal },
    xctest: () => Promise<TextActionResult>,
    text?: string,
  ): Promise<TextActionResult> {
    if (!this.target) {
      return xctest();
    }
    if (!this.current) {
      await this.deps.observe(options.signal);
    }
    const target = this.target;
    const outcome = await this.deps.router.perform({ action, target, text, ...options });
    if (!outcome) {
      return xctest();
    }
    this.record(outcome);
    if (outcome.backend === "xctest") {
      return xctest();
    }
    if (outcome.nextObservationIdentity !== undefined) {
      this.target = { ...target, observationIdentity: outcome.nextObservationIdentity };
    }
    return { success: true };
  }

  /** A fallback anywhere in the command is what the command reports. */
  private record(outcome: IosSdkTapOutcome): void {
    const store = this.outcomes.getStore();
    if (store && store.outcome?.backend !== "xctest") {
      store.outcome = outcome;
    }
  }
}
