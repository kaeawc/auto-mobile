import { AsyncLocalStorage } from "node:async_hooks";
import { ActionableError } from "../../../models/ActionableError";
import type { ObserveResult } from "../../../models";
import type { ObservationBackend, ObservationFallbackReason } from "../../../models/ObserveResult";
import {
  findIosSdkBridgeTarget,
  type IosSdkBridgeTarget,
} from "../../observe/ios/iosSdkObservationMerge";
import type { IosSdkTapOutcome } from "../IosSdkBridgeTapRouter";
import { findIosSdkWebTarget, type IosSdkWebTarget } from "../../observe/ios/iosSdkWebMerge";
import type { IosSdkBridgeTextRouter, IosSdkTextAction } from "../IosSdkBridgeTextRouter";
import type { IosSdkWebTextAction, IosSdkWebTextRouter } from "../IosSdkWebTextRouter";
import type { SendKeysSemanticKey, TextActionResult } from "../SendKeys";

/** The focused field's bridge identity: a native bridge node, or a DOM element of a web view. */
export type IosSdkTextTarget = IosSdkBridgeTarget | IosSdkWebTarget;

function isWebTarget(target: IosSdkTextTarget): target is IosSdkWebTarget {
  return "webViewId" in target;
}

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
  /** Routes a web-view DOM field (#5162); without it such a field uses XCTest. */
  webRouter?: IosSdkWebTextRouter;
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
 *
 * A DOM field of an opted-in web view (#5162) is cleared with the web view's `clear`, takes text
 * with `setValue` only after that clear (`setValue` replaces the value, so appending at the caret
 * stays on XCTest), and submits its form for IME `done`. When the fresh read before its first action
 * no longer shows the element, XCTest stands in and the command reports the bridge as unavailable.
 */
export class IosSdkTextRouting {
  private target: IosSdkTextTarget | undefined;
  private current = false;
  /** The web field's page navigated since focus, so its element id no longer names it. */
  private navigated = false;
  private readonly outcomes = new AsyncLocalStorage<{
    outcome?: IosSdkTapOutcome;
    /** The command cleared the web field through the bridge, so `setValue` can type into it. */
    webCleared?: boolean;
  }>();

  constructor(private readonly deps: IosSdkTextRoutingDeps) {}

  /** The focused field's bridge identity, or undefined when it is not a bridge node. */
  setTarget(target: IosSdkTextTarget | undefined): void {
    this.target = target;
    this.current = false;
    this.navigated = false;
  }

  observed(observation: Pick<ObserveResult, "viewHierarchy">): void {
    if (!this.target) {
      return;
    }
    if (isWebTarget(this.target)) {
      const { webViewId, elementId, documentId } = this.target;
      const latest = findIosSdkWebTarget(observation.viewHierarchy, webViewId, elementId);
      if (latest && latest.documentId !== documentId) {
        // Element ids restart for each page document: the same id on a new page is another element.
        this.navigated = true;
        this.current = false;
        return;
      }
      // A web field missing from a read is not current, so its next action falls back to XCTest.
      this.current = latest !== null;
      this.target = latest ?? this.target;
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

  /**
   * Forgets the focused field after a key that can move focus or leave the page (Tab, or any IME
   * action), so later text actions follow keyboard focus through XCTest instead of acting on the
   * field the command started on.
   */
  focusMayHaveMoved(): void {
    this.setTarget(undefined);
  }

  /**
   * IME `done` on a web field submits its form through the web view. Every other IME action, and
   * every IME action on a native bridge field, has no bridge form and reports the XCTest fallback.
   */
  async ime(
    key: SendKeysSemanticKey,
    signal: AbortSignal | undefined,
    xctest: () => Promise<TextActionResult>,
    onDispatch?: () => void,
  ): Promise<TextActionResult> {
    if (!this.target) {
      return xctest();
    }
    if (isWebTarget(this.target) && key === "done") {
      return this.routeWeb("submit", signal, xctest, { onDispatch });
    }
    this.record({ backend: "xctest", fallbackReason: "unsupported" });
    return xctest();
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
    if (isWebTarget(this.target)) {
      return this.routeWeb(action === "insertText" ? "setValue" : "clear", options.signal, xctest, {
        text,
      });
    }
    if (!this.current) {
      await this.deps.observe(options.signal);
    }
    const target = this.target;
    if (isWebTarget(target)) {
      return xctest();
    }
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

  private async routeWeb(
    action: IosSdkWebTextAction,
    signal: AbortSignal | undefined,
    xctest: () => Promise<TextActionResult>,
    { text, onDispatch }: { text?: string; onDispatch?: () => void },
  ): Promise<TextActionResult> {
    if (!this.current) {
      await this.deps.observe(signal);
    }
    this.throwIfNavigated();
    const target = this.target;
    const standIn = this.webStandIn(action);
    if (standIn || !target || !isWebTarget(target)) {
      this.record(standIn ?? { backend: "xctest", fallbackReason: "unavailable" });
      return xctest();
    }
    const store = this.outcomes.getStore();
    const router = this.deps.webRouter;
    if (!router) {
      return xctest();
    }
    onDispatch?.();
    const outcome = await router.perform({ action, target, text, signal });
    if (!outcome) {
      return xctest();
    }
    this.record(outcome);
    if (outcome.backend === "xctest") {
      return xctest();
    }
    if (action === "clear" && store) {
      store.webCleared = true;
    }
    return { success: true };
  }

  /** A web field whose page navigated fails closed: its element id may name another element. */
  private throwIfNavigated(): void {
    if (this.navigated) {
      throw new ActionableError(
        "The page navigated since sendKeys focused the field, so its element id may name another " +
          "element. Re-observe and retry; XCTest does not stand in, because the field may be gone.",
      );
    }
  }

  /** Why XCTest must stand in for this web action before it is sent, or null when it can be sent. */
  private webStandIn(action: IosSdkWebTextAction): IosSdkTapOutcome | null {
    if (!this.current) {
      // The fresh read no longer shows the element (or no snapshot merged).
      return { backend: "xctest", fallbackReason: "unavailable" };
    }
    if (action === "setValue" && this.outcomes.getStore()?.webCleared !== true) {
      // setValue replaces the value; appending at the caret has no web form.
      return { backend: "xctest", fallbackReason: "unsupported" };
    }
    return null;
  }

  /** A fallback anywhere in the command is what the command reports. */
  private record(outcome: IosSdkTapOutcome): void {
    const store = this.outcomes.getStore();
    if (store && store.outcome?.backend !== "xctest") {
      store.outcome = outcome;
    }
  }
}
