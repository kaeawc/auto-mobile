/**
 * The remaining request/response one-offs (clipboard, settings, global action, frame-context
 * validation, device info) and the cancellable-await helper, extracted from
 * `AndroidCtrlProxyClient` (#11846). Behaviour is unchanged; the client exposes the live state and
 * connection primitives this module needs through {@link AndroidClientRequestsContext}.
 */
import { logger } from "../../../utils/logger";
import { PerformanceTracker, NoOpPerformanceTracker } from "../../../utils/PerformanceTracker";
import { WEBSOCKET_NOT_CONNECTED_MESSAGE, sendCommand } from "../DeviceServiceUtils";
import { combineWithAmbientAbort } from "../../../utils/AbortContext";
import { OPERATION_CANCELLED_MESSAGE } from "../../../utils/constants";
import { ctrlProxyRequests, serializeCtrlProxyRequest } from "./ctrlProxyProtocol";
import { rethrowRealCtrlProxyWebSocketInTestError } from "../DeviceServiceClient";
import { errorMessage } from "../../../utils/describeUnknownError";
import type {
  A11yClipboardResult,
  A11ySettingsGetResult,
  A11ySettingsPutResult,
  A11ySettingsListResult,
  SettingsNamespace,
  SettingsValueType,
} from "./types";
import type { Logger } from "../../../utils/logger";
import type { RequestManager } from "../../../utils/RequestManager";
import type { Timer } from "../../../utils/SystemTimer";
import type { DelegateContext } from "../shared/types";
import type { AndroidActionDispatcher } from "./AndroidActionDispatcher";

/** Client-backed accessors resolve live state on every use, including after awaits. */
export interface AndroidClientRequestsContext {
  readonly timer: Timer;
  readonly requestManager: RequestManager;
  readonly logger: Logger;
  readonly actions: Pick<AndroidActionDispatcher, "sendClientCommand">;
  isConnected(): boolean;
  connectWebSocket(perf?: PerformanceTracker): Promise<boolean>;
  createDelegateContext(): DelegateContext;
  awaitActionWork<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T>;
}

/** Transport controls for {@link AndroidClientRequests.requestSettingsPut}. */
export interface AndroidSettingsPutOptions {
  timeoutMs?: number;
  perf?: PerformanceTracker;
  signal?: AbortSignal;
}

/** Frame validation, cancellation and dispatch hook for a global action. */
export interface AndroidGlobalActionOptions {
  frameContext?: string;
  signal?: AbortSignal;
  onDispatch?: () => void;
}

export class AndroidClientRequests {
  constructor(private readonly context: AndroidClientRequestsContext) {}

  async requestClipboard(
    action: "copy" | "paste" | "clear" | "get",
    text?: string,
    timeoutMs: number = 5000,
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
    signal?: AbortSignal,
    onDispatch?: () => void,
  ): Promise<A11yClipboardResult & { acknowledged?: boolean }> {
    const startTime = this.context.timer.now();
    const combinedSignal = combineWithAmbientAbort(signal);
    let requestId: string | undefined;

    try {
      combinedSignal?.throwIfAborted();
      if (action === "copy" && !text) {
        return {
          success: false,
          acknowledged: false,
          action,
          totalTimeMs: this.context.timer.now() - startTime,
          error: "Text is required for copy action",
        };
      }

      const connected = await this.context.awaitActionWork(
        () => perf.track("ensureConnection", () => this.context.connectWebSocket(perf)),
        combinedSignal,
      );
      if (!connected) {
        logger.warn("[CTRL_PROXY] Failed to establish WebSocket connection for clipboard");
        return {
          success: false,
          acknowledged: false,
          action,
          totalTimeMs: this.context.timer.now() - startTime,
          error: "Failed to connect to accessibility service",
        };
      }

      combinedSignal?.throwIfAborted();
      requestId = this.context.requestManager.generateId("clipboard");
      const clipboardRequestId = requestId;

      const clipboardPromise = this.context.actions.sendClientCommand<
        A11yClipboardResult & { acknowledged?: boolean }
      >(
        clipboardRequestId,
        (requestId) =>
          serializeCtrlProxyRequest(
            ctrlProxyRequests.requestClipboard({ requestId, action, text }),
          ),
        {
          responseType: "clipboard",
          messageType: "request_clipboard",
          timeoutMs,
          beforeSend: () => combinedSignal?.throwIfAborted(),
          onDispatch: () => {
            onDispatch?.();
            logger.debug(
              `[CTRL_PROXY] Sent clipboard request (requestId: ${requestId}, action: ${action})`,
            );
          },
          responseError: null,
          timeoutError: (timeout) => ({
            success: false,
            acknowledged: false,
            action,
            totalTimeMs: this.context.timer.now() - startTime,
            error: `Clipboard ${action} timeout after ${timeout}ms`,
          }),
        },
        { signal: combinedSignal, startTime },
        perf,
      );
      const result = await perf.track("waitForClipboard", () =>
        clipboardPromise.then((result) => ({
          ...result,
          // Only a device reply confirms an outcome; timeout and local cancellation do not.
          acknowledged: result.acknowledged ?? !combinedSignal?.aborted,
        })),
      );
      const clientDuration = this.context.timer.now() - startTime;

      if (result.success) {
        logger.info(
          `[CTRL_PROXY] Clipboard ${action} completed: clientTime=${clientDuration}ms, deviceTotalTime=${result.totalTimeMs}ms`,
        );
      } else {
        logger.warn(
          `[CTRL_PROXY] Clipboard ${action} failed after ${clientDuration}ms: ${result.error}`,
        );
      }

      return result;
    } catch (error) {
      if (requestId) {
        this.context.requestManager.resolveError(
          requestId,
          String(error),
          this.context.timer.now() - startTime,
        );
      }
      // A unit test reached the real WebSocket factory; fail it, never resolve a typed failure.
      rethrowRealCtrlProxyWebSocketInTestError(error);
      const duration = this.context.timer.now() - startTime;
      logger.warn(`[CTRL_PROXY] Clipboard request failed after ${duration}ms: ${error}`);
      return {
        success: false,
        action,
        totalTimeMs: duration,
        error: `${error}`,
        acknowledged: false,
      };
    }
  }

  requestSettingsGet(
    namespace: SettingsNamespace,
    key: string,
    timeoutMs: number = 5000,
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
    signal?: AbortSignal,
  ): Promise<A11ySettingsGetResult> {
    return this.sendSettingsCommand(
      "get",
      { namespace, key },
      {
        timeoutMs,
        perf,
        signal,
        failure: (error, totalTimeMs) => ({ success: false, found: false, totalTimeMs, error }),
      },
    );
  }

  requestSettingsPut(
    namespace: SettingsNamespace,
    key: string,
    value: string | null,
    valueType: SettingsValueType = "string",
    options: AndroidSettingsPutOptions = {},
  ): Promise<A11ySettingsPutResult> {
    const { timeoutMs = 5000, perf = new NoOpPerformanceTracker(), signal } = options;
    return this.sendSettingsCommand(
      "put",
      { namespace, key, value, valueType },
      {
        timeoutMs,
        perf,
        signal,
        failure: (error, totalTimeMs) => ({ success: false, totalTimeMs, error }),
      },
    );
  }

  requestSettingsList(
    namespace: SettingsNamespace,
    timeoutMs: number = 5000,
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
    signal?: AbortSignal,
  ): Promise<A11ySettingsListResult> {
    return this.sendSettingsCommand(
      "list",
      { namespace },
      {
        timeoutMs,
        perf,
        signal,
        failure: (error, totalTimeMs) => ({ success: false, totalTimeMs, error }),
      },
    );
  }

  private async sendSettingsCommand<T>(
    operation: "get" | "put" | "list",
    params: Record<string, unknown>,
    options: {
      timeoutMs: number;
      perf: PerformanceTracker;
      signal?: AbortSignal;
      failure: (error: string, totalTimeMs: number) => T;
    },
  ): Promise<T> {
    const startTime = this.context.timer.now();
    const failure = (error: string): T =>
      options.failure(error, this.context.timer.now() - startTime);
    try {
      // Cleanup/restore callers such as Rotate must survive a cancelled ambient signal.
      const abortSignal = options.signal;
      abortSignal?.throwIfAborted();
      return await sendCommand<T>(
        {
          ...this.context.createDelegateContext(),
          // Settings historically dispatch even when omitted from the handshake or rejected.
          isCommandSupported: undefined,
        },
        {
          idPrefix: `settings_${operation}`,
          responseType: `settings_${operation}`,
          messageType: `request_settings_${operation}`,
          // The Android serializer leaves settings fields untouched; createMessage has the
          // same type, requestId, params order as the typed settings builders.
          params,
          timeoutMs: options.timeoutMs,
          perf: options.perf,
          abortSignal,
          requireExistingConnection: true,
          cancelScreenshotBackoff: false,
          notConnectedError: () => failure(WEBSOCKET_NOT_CONNECTED_MESSAGE),
          timeoutError: (timeout) => failure(`Settings ${operation} timeout after ${timeout}ms`),
          unsupportedCommandError: (_type, error) => failure(error),
        },
      );
    } catch (error) {
      const duration = this.context.timer.now() - startTime;
      logger.warn(`[CTRL_PROXY] Settings ${operation} failed after ${duration}ms`, error);
      return options.failure(`${error}`, duration);
    }
  }

  /**
   * Execute a global action (back, home, recents, etc.) via the accessibility service.
   */
  async requestGlobalAction(
    action: string,
    timeoutMs: number = 5000,
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
    options: AndroidGlobalActionOptions = {},
  ): Promise<{
    success: boolean;
    action: string;
    totalTimeMs: number;
    error?: string;
    acknowledged?: boolean;
  }> {
    const { frameContext, signal, onDispatch } = options;
    const startTime = this.context.timer.now();
    // Combine with the ambient request signal so a cancelled request (e.g.
    // session teardown mid-home-press) can free this keyed device operation
    // immediately rather than blocking on the CtrlProxy wait until its timeout
    // (issue #6289).
    const combinedSignal = combineWithAmbientAbort(signal);
    let requestId: string | undefined;
    try {
      // Fast-fail if not already connected to avoid stalling callers
      // (undelivered requests are safe to fall back to ADB keyevents)
      if (!this.context.isConnected()) {
        return {
          success: false,
          acknowledged: false,
          action,
          totalTimeMs: this.context.timer.now() - startTime,
          error: WEBSOCKET_NOT_CONNECTED_MESSAGE,
        };
      }
      if (combinedSignal?.aborted) {
        return {
          success: false,
          acknowledged: false,
          action,
          totalTimeMs: this.context.timer.now() - startTime,
          error: OPERATION_CANCELLED_MESSAGE,
        };
      }

      requestId = this.context.requestManager.generateId("global_action");
      return await this.context.actions
        .sendClientCommand<{
          success: boolean;
          action: string;
          totalTimeMs: number;
          error?: string;
          acknowledged?: boolean;
        }>(
          requestId,
          (requestId) =>
            serializeCtrlProxyRequest(
              ctrlProxyRequests.requestGlobalAction({ requestId, action, frameContext }),
            ),
          {
            responseType: "global_action",
            messageType: "request_global_action",
            timeoutMs,
            onDispatch: () => {
              onDispatch?.();
              logger.debug(
                `[CTRL_PROXY] Sent global action request (requestId: ${requestId}, action: ${action})`,
              );
            },
            responseError: null,
            timeoutError: (timeout) => ({
              success: false,
              action,
              totalTimeMs: this.context.timer.now() - startTime,
              error: `Global action timeout after ${timeout}ms`,
              acknowledged: false,
            }),
          },
          { signal: combinedSignal, startTime },
        )
        .then((result) => ({
          ...result,
          // Only a device reply confirms an outcome; timeout and local cancellation do not.
          acknowledged: result.acknowledged ?? !combinedSignal?.aborted,
        }));
    } catch (error) {
      const logger = this.context.logger;
      // The local alias keeps the injected logger visible to the catch-convention lint rule.
      logger.warn(`[CTRL_PROXY] Global action failed: ${errorMessage(error)}`, error);
      if (requestId) {
        // Settle the abandoned wait, as in requestClipboard; return the typed failure below.
        this.context.requestManager.resolveError(
          requestId,
          String(error),
          this.context.timer.now() - startTime,
        );
      }
      return {
        success: false,
        action,
        totalTimeMs: this.context.timer.now() - startTime,
        error: error instanceof Error ? error.toString() : errorMessage(error),
        acknowledged: false,
      };
    }
  }

  /**
   * Verifies that an observed frame context still matches device state immediately before
   * an ADB-only input action is issued.
   */
  async validateFrameContext(
    frameContext: string,
    timeoutMs: number = 5000,
    signal?: AbortSignal,
  ): Promise<{ success: boolean; totalTimeMs: number; error?: string }> {
    const startTime = this.context.timer.now();
    // See requestGlobalAction: cancel the CtrlProxy wait on abort so a torn-down
    // request does not keep the keyed device operation busy for the remaining
    // request budget (issue #6289).
    const combinedSignal = combineWithAmbientAbort(signal);
    let requestId: string | undefined;
    try {
      if (!this.context.isConnected()) {
        return {
          success: false,
          totalTimeMs: this.context.timer.now() - startTime,
          error: WEBSOCKET_NOT_CONNECTED_MESSAGE,
        };
      }
      if (combinedSignal?.aborted) {
        return {
          success: false,
          totalTimeMs: this.context.timer.now() - startTime,
          error: OPERATION_CANCELLED_MESSAGE,
        };
      }

      requestId = this.context.requestManager.generateId("validate_frame_context");
      return await this.context.actions.sendClientCommand(
        requestId,
        (requestId) =>
          serializeCtrlProxyRequest(
            ctrlProxyRequests.validateFrameContext({ requestId, frameContext }),
          ),
        {
          responseType: "validate_frame_context",
          messageType: "validate_frame_context",
          timeoutMs,
          timeoutError: (timeout) => ({
            success: false,
            totalTimeMs: this.context.timer.now() - startTime,
            error: `Frame context validation timeout after ${timeout}ms`,
          }),
        },
        { signal: combinedSignal, startTime },
      );
    } catch (error) {
      const logger = this.context.logger;
      logger.warn(`[CTRL_PROXY] Frame validation failed: ${errorMessage(error)}`, error);
      if (requestId) {
        this.context.requestManager.reject(
          requestId,
          error instanceof Error ? error : new Error(String(error)),
        );
      }
      return {
        success: false,
        totalTimeMs: this.context.timer.now() - startTime,
        error: error instanceof Error ? error.toString() : errorMessage(error),
      };
    }
  }

  /**
   * Await a pending CtrlProxy request, but early-resolve it with a cancellation
   * failure the moment `signal` aborts, so a cancelled caller (e.g. session
   * teardown) frees the keyed device operation immediately instead of blocking
   * until the request's timeout fires. `resolveError` no-ops if the response
   * already landed, and the listener is always removed once the promise settles.
   */
  async awaitCancellableRequest<
    T extends { success: boolean; totalTimeMs: number; error?: string },
  >(
    requestId: string,
    promise: Promise<T>,
    signal: AbortSignal | undefined,
    startTime: number,
  ): Promise<T> {
    if (!signal) {
      return promise;
    }
    const onAbort = (): void => {
      this.context.requestManager.resolveError(
        requestId,
        OPERATION_CANCELLED_MESSAGE,
        this.context.timer.now() - startTime,
      );
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
    }
    try {
      return await promise;
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  /**
   * Request device metadata from the accessibility service.
   */
  async requestDeviceInfo(
    timeoutMs: number = 5000,
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
  ): Promise<{
    success: boolean;
    screenWidth?: number;
    screenHeight?: number;
    density?: number;
    rotation?: number;
    sdkInt?: number;
    deviceModel?: string;
    isEmulator?: boolean;
    wakefulness?: string;
    foregroundActivity?: string;
    totalTimeMs: number;
    error?: string;
  }> {
    const startTime = this.context.timer.now();
    let requestId: string | undefined;
    try {
      const connected = await perf.track("ensureConnection", () =>
        this.context.connectWebSocket(perf),
      );
      if (!connected) {
        return {
          success: false,
          totalTimeMs: this.context.timer.now() - startTime,
          error: "Failed to connect to accessibility service",
        };
      }

      requestId = this.context.requestManager.generateId("device_info");
      return await this.context.actions.sendClientCommand(
        requestId,
        (requestId) =>
          serializeCtrlProxyRequest(ctrlProxyRequests.requestDeviceInfo({ requestId })),
        {
          responseType: "device_info",
          messageType: "request_device_info",
          timeoutMs,
          onDispatch: () =>
            logger.debug(`[CTRL_PROXY] Sent device info request (requestId: ${requestId})`),
          timeoutError: (timeout) => ({
            success: false,
            totalTimeMs: this.context.timer.now() - startTime,
            error: `Device info timeout after ${timeout}ms`,
          }),
        },
      );
    } catch (error) {
      const logger = this.context.logger;
      logger.warn(`[CTRL_PROXY] Device info failed: ${errorMessage(error)}`, error);
      if (requestId) {
        this.context.requestManager.reject(
          requestId,
          error instanceof Error ? error : new Error(String(error)),
        );
      }
      // A unit test reached the real WebSocket factory; fail it, never resolve a typed failure.
      rethrowRealCtrlProxyWebSocketInTestError(error);
      return {
        success: false,
        totalTimeMs: this.context.timer.now() - startTime,
        error: error instanceof Error ? error.toString() : errorMessage(error),
      };
    }
  }
}
