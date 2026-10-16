/**
 * Action-style CtrlProxy requests (`request_action`, focused-input click, node actions, semantic
 * link activation) and the legacy `sendClientCommand` path, extracted from
 * `AndroidCtrlProxyClient` (#11846). Behaviour is unchanged; the client exposes the live state and
 * connection primitives this module needs through {@link AndroidActionDispatcherContext}.
 */
import { logger } from "../../../utils/logger";
import { PerformanceTracker, NoOpPerformanceTracker } from "../../../utils/PerformanceTracker";
import {
  WEBSOCKET_NOT_CONNECTED_MESSAGE,
  sendCommand,
  type SendCommandOptions,
} from "../DeviceServiceUtils";
import { combineWithAmbientAbort } from "../../../utils/AbortContext";
import { ctrlProxyRequests, serializeCtrlProxyRequest } from "./ctrlProxyProtocol";
import { rethrowRealCtrlProxyWebSocketInTestError } from "../DeviceServiceClient";
import { errorMessage } from "../../../utils/describeUnknownError";
import type { A11yActionResult, AccessibilityNodeSelector } from "./types";
import type { PerformanceTracker as PerformanceTrackerType } from "../../../utils/PerformanceTracker";
import type { RequestManager } from "../../../utils/RequestManager";
import type { Timer } from "../../../utils/SystemTimer";
import type { DelegateContext } from "../shared/types";

/** Client-backed accessors resolve live state on every use, including after awaits. */
export interface AndroidActionDispatcherContext {
  readonly timer: Timer;
  readonly requestManager: RequestManager;
  readonly pendingFocusedInputClickIds: Set<string>;
  readonly supportedCommands: ReadonlySet<string> | null;
  awaitActionWork<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T>;
  awaitCancellableRequest<T extends { success: boolean; totalTimeMs: number; error?: string }>(
    requestId: string,
    promise: Promise<T>,
    signal: AbortSignal | undefined,
    startTime: number,
  ): Promise<T>;
  connectWebSocket(perf?: PerformanceTrackerType): Promise<boolean>;
  waitForHandshake(timeoutMs?: number, signal?: AbortSignal): Promise<void>;
  isCommandSupported(messageType: string): boolean;
  cancelScreenshotBackoff(): void;
  createDelegateContext(): DelegateContext;
}

export class AndroidActionDispatcher {
  constructor(private readonly context: AndroidActionDispatcherContext) {}

  async requestAction(
    action: string,
    resourceId?: string,
    timeoutMs: number = 5000,
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
    selector?: AccessibilityNodeSelector,
    signal?: AbortSignal,
  ): Promise<A11yActionResult> {
    return this.dispatchActionRequest(
      action,
      (requestId) =>
        serializeCtrlProxyRequest(
          ctrlProxyRequests.requestAction({ requestId, action, resourceId, selector }),
        ),
      timeoutMs,
      perf,
      signal,
    );
  }

  async requestClickFocusedInput(
    timeoutMs: number = 5000,
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
    signal?: AbortSignal,
  ): Promise<A11yActionResult> {
    try {
      return await this.dispatchActionRequest(
        "click",
        (requestId) => {
          this.context.pendingFocusedInputClickIds.add(requestId);
          return serializeCtrlProxyRequest(
            ctrlProxyRequests.requestClickFocusedInput({ requestId }),
          );
        },
        timeoutMs,
        perf,
        signal,
      );
    } finally {
      this.context.pendingFocusedInputClickIds.clear();
    }
  }

  /**
   * Very old runners reject the focused-input click during decoding without echoing its id; settle
   * the pending clicks so the host can fall back instead of timing out.
   */
  settleUnattributedFocusedClickRejection(
    requestId: string | null | undefined,
    rejectedCommand: string | undefined,
    errorText: string,
  ): void {
    if (requestId || rejectedCommand !== "request_click_focused_input") {
      return;
    }
    for (const id of this.context.pendingFocusedInputClickIds) {
      this.context.requestManager.resolveError(id, errorText);
    }
  }

  /** These legacy client requests bypass the generic capability/deadline gate. */
  async sendClientCommand<T extends { success: boolean; totalTimeMs: number; error?: string }>(
    requestId: string,
    serializeRequest: (requestId: string) => string,
    options: Pick<
      SendCommandOptions<T>,
      "responseType" | "messageType" | "timeoutMs" | "responseError" | "beforeSend" | "onDispatch"
    > & { timeoutError: (timeoutMs: number) => T },
    cancellation?: { signal: AbortSignal | undefined; startTime: number },
    perf?: PerformanceTracker,
  ): Promise<T> {
    const dispatch = () =>
      sendCommand<T>(
        {
          ...this.context.createDelegateContext(),
          isCommandSupported: undefined,
          wireDeadlineParams: undefined,
          serializeRequest: () => serializeRequest(requestId),
        },
        {
          ...options,
          responseError: options.responseError ?? null,
          idPrefix: options.responseType,
          createRequestId: () => requestId,
          requireExistingConnection: true,
          cancelScreenshotBackoff: false,
          // A socket lost after the caller's connection check must take its catch path.
          notConnectedError: () => {
            throw new Error(WEBSOCKET_NOT_CONNECTED_MESSAGE);
          },
          unsupportedCommandError: (_type, error) => {
            throw new Error(error);
          },
        },
      );
    const { promise } = perf
      ? await perf.track("sendRequest", async () => ({ promise: dispatch() }))
      : { promise: dispatch() };
    // sendCommand's abortSignal rejects. These callers instead settle a typed
    // cancellation through RequestManager, including an abort during ws.send.
    return cancellation
      ? this.context.awaitCancellableRequest(
          requestId,
          promise,
          cancellation.signal,
          cancellation.startTime,
        )
      : promise;
  }

  private async dispatchActionRequest(
    action: string,
    serializeRequest: (requestId: string) => string,
    timeoutMs: number,
    perf: PerformanceTracker,
    signal?: AbortSignal,
  ): Promise<A11yActionResult> {
    const startTime = this.context.timer.now();
    const combinedSignal = combineWithAmbientAbort(signal);
    let pendingRequestId: string | undefined;
    let dispatched = false;

    this.context.cancelScreenshotBackoff();

    try {
      const connected = await this.context.awaitActionWork(
        () => perf.track("ensureConnection", () => this.context.connectWebSocket(perf)),
        combinedSignal,
      );
      combinedSignal?.throwIfAborted();
      if (!connected) {
        logger.warn("[CTRL_PROXY] Failed to establish WebSocket connection for action");
        return {
          success: false,
          action,
          totalTimeMs: this.context.timer.now() - startTime,
          error: "Failed to connect to accessibility service",
          dispatched: false,
          acknowledged: false,
        };
      }

      const requestId = this.context.requestManager.generateId("action");
      pendingRequestId = requestId;
      logger.debug(
        `[CTRL_PROXY] Creating action request (requestId: ${requestId}, action: ${action})`,
      );

      const cancellableAction = this.sendClientCommand<A11yActionResult>(
        requestId,
        serializeRequest,
        {
          responseType: "action",
          messageType: "request_action",
          timeoutMs,
          beforeSend: () => combinedSignal?.throwIfAborted(),
          onDispatch: () => {
            dispatched = true;
            logger.debug(
              `[CTRL_PROXY] Sent action request (requestId: ${requestId}, action: ${action})`,
            );
          },
          timeoutError: (timeout) => ({
            success: false,
            action,
            totalTimeMs: this.context.timer.now() - startTime,
            error: `Action timeout after ${timeout}ms`,
            acknowledged: false,
          }),
          responseError: (error, totalTimeMs) => ({
            success: false,
            action,
            totalTimeMs,
            error,
            acknowledged: true,
          }),
        },
        { signal: combinedSignal, startTime },
        perf,
      );

      const result = await perf.track("waitForAction", () => cancellableAction);
      combinedSignal?.throwIfAborted();
      const clientDuration = this.context.timer.now() - startTime;

      if (result.success) {
        logger.debug(
          `[CTRL_PROXY] Action completed: clientTime=${clientDuration}ms, deviceTotalTime=${result.totalTimeMs}ms, action=${result.action}`,
        );
      } else {
        logger.warn(`[CTRL_PROXY] Action failed after ${clientDuration}ms: ${result.error}`);
      }

      return { ...result, dispatched, acknowledged: result.acknowledged ?? true };
    } catch (error) {
      if (pendingRequestId) {
        this.context.requestManager.resolveError(
          pendingRequestId,
          String(error),
          this.context.timer.now() - startTime,
        );
      }
      // A unit test reached the real WebSocket factory; fail it, never report a failed action.
      rethrowRealCtrlProxyWebSocketInTestError(error);
      const duration = this.context.timer.now() - startTime;
      logger.warn(`[CTRL_PROXY] Action request failed after ${duration}ms: ${error}`);
      return {
        success: false,
        action,
        totalTimeMs: duration,
        error: `${error}`,
        dispatched,
        acknowledged: false,
      };
    }
  }

  async requestNodeAction(
    action: string,
    selector: AccessibilityNodeSelector,
    timeoutMs: number = 5000,
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
    signal?: AbortSignal,
  ): Promise<A11yActionResult> {
    return this.requestAction(action, selector.resourceId, timeoutMs, perf, selector, signal);
  }

  async supportsNodeActionSelectors(
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
    signal?: AbortSignal,
  ): Promise<boolean> {
    const combinedSignal = combineWithAmbientAbort(signal);
    const connected = await this.context.awaitActionWork(
      () => perf.track("ensureConnection", () => this.context.connectWebSocket(perf)),
      combinedSignal,
    );
    combinedSignal?.throwIfAborted();
    if (connected && this.context.supportedCommands === null) {
      await this.context.waitForHandshake(undefined, combinedSignal);
    }
    combinedSignal?.throwIfAborted();
    // Unknown selector support must stay closed: an old runner could click the wrong repeated node.
    return (
      connected &&
      this.context.supportedCommands !== null &&
      this.context.isCommandSupported("node_selector_actions")
    );
  }

  async supportsAccessibilityLinkActivation(
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
  ): Promise<boolean> {
    const connected = await perf.track("ensureConnection", () =>
      this.context.connectWebSocket(perf),
    );
    if (connected && this.context.supportedCommands === null) {
      await this.context.waitForHandshake();
    }
    return connected && this.context.isCommandSupported("request_activate_accessibility_link");
  }

  // Keep existing positional arguments compatible while adding cancellation and dispatch tracking.
  // oxlint-disable-next-line max-params
  async requestActivateAccessibilityLink(
    text: string,
    occurrence: number,
    selector?: AccessibilityNodeSelector,
    timeoutMs: number = 5000,
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
    signal?: AbortSignal,
    onDispatch?: () => void,
  ): Promise<A11yActionResult> {
    const startTime = this.context.timer.now();
    const action = "activate_accessibility_link";
    const combinedSignal = combineWithAmbientAbort(signal);
    const checkCancellation = (): void => combinedSignal?.throwIfAborted();
    let requestId: string | undefined;
    let dispatched = false;
    const unconfirmed = (error: string): A11yActionResult => ({
      success: false,
      action,
      totalTimeMs: this.context.timer.now() - startTime,
      error,
      dispatched,
      acknowledged: false,
      ...(dispatched ? { retryable: false } : {}),
    });
    try {
      const supported = await this.context.awaitActionWork(
        () => this.supportsAccessibilityLinkActivation(perf),
        combinedSignal,
      );
      checkCancellation();
      if (!supported) {
        return unconfirmed(
          "Connected Android runner does not support semantic accessibility-link activation",
        );
      }
      requestId = this.context.requestManager.generateId("accessibility-link");
      const result = await this.sendClientCommand<A11yActionResult>(
        requestId,
        (requestId) =>
          serializeCtrlProxyRequest(
            ctrlProxyRequests.requestActivateAccessibilityLink({
              requestId,
              text,
              occurrence,
              selector,
            }),
          ),
        {
          responseType: "accessibility-link",
          messageType: "request_activate_accessibility_link",
          timeoutMs,
          beforeSend: checkCancellation,
          onDispatch: () => {
            dispatched = true;
            onDispatch?.();
          },
          timeoutError: () =>
            unconfirmed(`Semantic link activation timed out after ${timeoutMs}ms`),
          responseError: (error, totalTimeMs) => ({
            success: false,
            action,
            totalTimeMs,
            error,
            acknowledged: true,
          }),
        },
        { signal: combinedSignal, startTime },
      );
      checkCancellation();
      return { ...result, dispatched, acknowledged: result.acknowledged ?? true };
    } catch (error) {
      if (requestId) {
        this.context.requestManager.resolveError(
          requestId,
          errorMessage(error),
          this.context.timer.now() - startTime,
        );
      }
      // A unit test reached the real WebSocket factory; fail it, never report an unconfirmed activation.
      rethrowRealCtrlProxyWebSocketInTestError(error);
      logger.warn("[CTRL_PROXY] Semantic link activation failed", error);
      return unconfirmed(errorMessage(error));
    } finally {
      if (!dispatched) {
        checkCancellation();
      }
    }
  }
}
