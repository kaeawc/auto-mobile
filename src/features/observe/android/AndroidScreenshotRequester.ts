import type { CtrlSocket } from "../shared/types";
/**
 * The one-shot `request_screenshot` round trip (connect, register, dispatch, await, cancel),
 * extracted from `AndroidCtrlProxyClient` (#11846). Behaviour is unchanged; the client exposes the
 * live state and connection primitives this module needs through
 * {@link AndroidScreenshotRequesterContext}. `requestScreenshot` stays a public method on the
 * client and delegates here.
 */
import WebSocket from "ws";
import { logger } from "../../../utils/logger";
import { PerformanceTracker } from "../../../utils/PerformanceTracker";
import type { RequestManager } from "../../../utils/RequestManager";
import type { Timer } from "../../../utils/SystemTimer";
import { OPERATION_CANCELLED_MESSAGE } from "../../../utils/constants";
import { rethrowRealCtrlProxyWebSocketInTestError } from "../DeviceServiceClient";
import { WEBSOCKET_NOT_CONNECTED_MESSAGE } from "../DeviceServiceUtils";
import type { ScreenGeometryBinding, TrackedScreenGeometry } from "../TrackedScreenGeometry";
import {
  SCREENSHOT_HIDE_PROTOTYPE_CAPABILITY,
  ctrlProxyRequests,
  serializeCtrlProxyRequest,
} from "./ctrlProxyProtocol";
import type { ScreenshotResult } from "./types";

/** Per-capture controls for {@link AndroidScreenshotRequester.requestScreenshot}. */
export interface AndroidScreenshotRequestOptions {
  /** Keep this capture out of the observation stream. Defaults to false. */
  suppressObservationStreamPush?: boolean;
  signal?: AbortSignal;
  displayId?: number;
  /** Ask the device to hide its prototype for this capture. Defaults to false. */
  hidePrototypes?: boolean;
}

/** Client-backed accessors resolve live state on every use, including after awaits. */
export interface AndroidScreenshotRequesterContext {
  readonly timer: Pick<Timer, "now">;
  readonly requestManager: RequestManager;
  readonly screenGeometry: Pick<TrackedScreenGeometry, "bind">;
  readonly screenshotObservationStreamSuppressions: Set<string>;
  readonly screenshotCaptureBindings: Map<string, ScreenGeometryBinding>;
  readonly lateCancelledScreenshotRequestIds: Set<string>;
  readonly socket: Pick<CtrlSocket, "readyState" | "send"> | null;
  readonly supportedCommands: ReadonlySet<string> | null;
  /** Opens (or reuses) the WebSocket; false when it could not be established. */
  connectWebSocket(perf: PerformanceTracker): Promise<boolean>;
  /** Advances the shared accessibility screenshot rate-limit floor clock (issue #4927). */
  noteScreenshotCaptureStarted(): void;
}

export class AndroidScreenshotRequester {
  constructor(private readonly context: AndroidScreenshotRequesterContext) {}

  /**
   * `hidePrototypes` asks the device to hide its prototype for this capture (#9305); it is sent only
   * to a CtrlProxy advertising `screenshot_hide_prototype_v1`, and the result's `prototypesHidden`
   * reports the outcome.
   */
  async requestScreenshot(
    timeoutMs: number,
    perf: PerformanceTracker,
    options: AndroidScreenshotRequestOptions = {},
  ): Promise<ScreenshotResult> {
    const {
      suppressObservationStreamPush = false,
      signal,
      displayId,
      hidePrototypes = false,
    } = options;
    const { context } = this;
    const startTime = context.timer.now();
    let suppressedRequestId: string | undefined;
    let requestId: string | undefined;
    let removeAbortListener: (() => void) | undefined;

    try {
      const blocked = await this.connectForScreenshot(perf, signal);
      if (blocked) {
        return blocked;
      }

      requestId = context.requestManager.generateId("screenshot");
      if (suppressObservationStreamPush) {
        context.screenshotObservationStreamSuppressions.add(requestId);
        suppressedRequestId = requestId;
      } else {
        // Bind the capture identity that is current NOW, before the request goes out.
        const binding = context.screenGeometry.bind();
        if (binding) {
          context.screenshotCaptureBindings.set(requestId, binding);
        }
      }

      const sentRequestId = requestId;
      const screenshotPromise = context.requestManager.register<ScreenshotResult>(
        sentRequestId,
        "screenshot",
        timeoutMs,
        {
          timeoutErrorFactory: (_id, _type, timeout) => ({
            success: false,
            error: `Screenshot timeout after ${timeout}ms`,
          }),
        },
      );

      await perf.track("sendRequest", () =>
        this.dispatchScreenshotRequest(sentRequestId, signal, displayId, hidePrototypes),
      );

      removeAbortListener = this.registerPostDispatchAbort(sentRequestId, signal);

      const result = await perf.track("waitForScreenshot", () => screenshotPromise);
      const duration = context.timer.now() - startTime;

      this.logScreenshotResult(result, duration);

      return result;
    } catch (error) {
      // A unit test reached the real WebSocket factory; fail it, never resolve a typed failure.
      rethrowRealCtrlProxyWebSocketInTestError(error);
      const duration = context.timer.now() - startTime;
      logger.warn(`[CTRL_PROXY] Screenshot request failed after ${duration}ms: ${error}`);
      return { success: false, error: `${error}` };
    } finally {
      removeAbortListener?.();
      // Clean up the suppression token in case the response never arrived
      // (timeout/error). The message handler deletes it on a normal response;
      // this guards against leaking ids for in-flight requests that never resolve.
      if (suppressedRequestId !== undefined) {
        context.screenshotObservationStreamSuppressions.delete(suppressedRequestId);
      }
      // Drop the binding for a request that never resolved, so the map cannot grow without bound.
      if (requestId !== undefined) {
        context.screenshotCaptureBindings.delete(requestId);
      }
    }
  }

  /**
   * Establish the connection a screenshot request needs, gated on the caller's
   * cancellation on both sides of the (potentially multi-second) reconnect.
   *
   * @returns the result to return instead of capturing - a connection failure or
   *   the caller's cancellation - or undefined when dispatch should proceed.
   */
  private async connectForScreenshot(
    perf: PerformanceTracker,
    signal?: AbortSignal,
  ): Promise<ScreenshotResult | undefined> {
    if (signal?.aborted) {
      return { success: false, error: OPERATION_CANCELLED_MESSAGE };
    }

    const connected = await perf.track("ensureConnection", () =>
      this.context.connectWebSocket(perf),
    );
    if (!connected) {
      logger.warn("[CTRL_PROXY] Failed to establish WebSocket connection for screenshot");
      return { success: false, error: "Failed to connect to accessibility service" };
    }

    if (signal?.aborted) {
      // Connecting (and reconnecting) can take seconds, so the caller may well
      // have given up by the time we get here. Dispatching anyway would consume
      // the shared a11y screenshot rate limit and push a late frame onto the
      // observation stream for a capture nobody is waiting on (#6605).
      logger.debug("[CTRL_PROXY] Screenshot cancelled before dispatch");
      return { success: false, error: OPERATION_CANCELLED_MESSAGE };
    }

    return undefined;
  }

  /**
   * Put a registered screenshot request on the wire, unless the caller cancelled
   * while the connection was being established (#6605). A cancelled request is
   * settled locally instead: it must not consume the shared accessibility
   * screenshot rate limit, nor publish a late observation-stream frame.
   */
  async dispatchScreenshotRequest(
    sentRequestId: string,
    signal?: AbortSignal,
    displayId?: number,
    hidePrototypes = false,
  ): Promise<void> {
    const { context } = this;
    if (signal?.aborted) {
      // Settle the registration we just made so it neither waits out its
      // timeout nor accepts a late response.
      context.requestManager.resolveError(sentRequestId, OPERATION_CANCELLED_MESSAGE);
      return;
    }
    const socket = context.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error(WEBSOCKET_NOT_CONNECTED_MESSAGE);
    }
    const message = serializeCtrlProxyRequest(
      ctrlProxyRequests.requestScreenshot({
        requestId: sentRequestId,
        displayId,
        // A capability flag, never a request type: the legacy "assume supported" path must not
        // apply, or an older APK would silently capture with the prototype showing.
        hidePrototypes:
          hidePrototypes &&
          context.supportedCommands?.has(SCREENSHOT_HIDE_PROTOTYPE_CAPABILITY) === true,
      }),
    );
    // Shared rate-limit floor accounting (issue #4927): a one-shot screenshot (observe /
    // junit-runner) and the observation-stream scheduler both hit the same rate-limited
    // accessibility takeScreenshot(). Advancing the shared clock here (non-blocking) makes the
    // stream scheduler coalesce around a one-shot instead of the two engines rate-limiting each
    // other while a live viewer is attached. requestScreenshot always issues a real a11y capture
    // (it has no ADB path), so the stamp is unconditionally correct.
    context.noteScreenshotCaptureStarted();
    socket.send(message);
    logger.debug(`[CTRL_PROXY] Sent screenshot request (requestId: ${sentRequestId})`);
  }

  private registerPostDispatchAbort(
    sentRequestId: string,
    signal: AbortSignal | undefined,
  ): () => void {
    if (!signal) {
      return () => {};
    }

    const cancelAfterDispatch = () => {
      if (this.context.requestManager.resolveError(sentRequestId, OPERATION_CANCELLED_MESSAGE)) {
        this.context.lateCancelledScreenshotRequestIds.add(sentRequestId);
        logger.debug(
          `[CTRL_PROXY] Screenshot cancelled after dispatch (requestId: ${sentRequestId})`,
        );
      }
    };
    signal.addEventListener("abort", cancelAfterDispatch, { once: true });
    if (signal.aborted) {
      cancelAfterDispatch();
    }
    return () => signal.removeEventListener("abort", cancelAfterDispatch);
  }

  private logScreenshotResult(result: ScreenshotResult, duration: number): void {
    if (result.success) {
      const dataSize = result.data ? result.data.length : 0;
      logger.debug(`[CTRL_PROXY] Screenshot received in ${duration}ms (${dataSize} base64 chars)`);
    } else {
      logger.warn(`[CTRL_PROXY] Screenshot failed after ${duration}ms: ${result.error}`);
    }
  }
}
