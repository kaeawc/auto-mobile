/**
 * CtrlProxy iOS VoiceOver - Delegate for VoiceOver state detection.
 *
 * Sends a get_voiceover_state command over the WebSocket connection to the
 * iOS CtrlProxy, which calls UIAccessibility.isVoiceOverRunning and returns
 * the result.
 */

import { rethrowRealCtrlProxyWebSocketInTestError } from "../DeviceServiceClient";
import { DEFAULT_GESTURE_REQUEST_TIMEOUT_MS } from "../shared/SharedGestureDelegate";
import type { PerformanceTracker } from "../../../utils/PerformanceTracker";
import type { ElementBounds } from "../../../models/ElementBounds";
import type {
  DelegateContext,
  CtrlProxyVoiceOverResult,
  CtrlProxyActionResult,
  CtrlProxyMagicTapResult,
} from "./types";
import { sendCommand } from "../DeviceServiceUtils";
import { combineWithAmbientAbort, getAbortSignal } from "../../../utils/AbortContext";
import { errorMessage } from "../../../utils/describeUnknownError";
import { logger } from "../../../utils/logger";
import { ActionableError } from "../../../models/ActionableError";

/**
 * Default timeout for `requestVoiceOverState`, shared with
 * `IosVoiceOverDetector.isVoiceOverEnabled` (which calls this method without
 * an explicit `timeoutMs`) so every caller -- including the daemon's
 * `mcpRequestTimeout` budget arithmetic -- reads the same real constant
 * instead of duplicating the literal (issue #6248 review, P2).
 */
export const IOS_VOICEOVER_STATE_REQUEST_TIMEOUT_MS = 5000;

export interface VoiceOverActivationOptions {
  bounds?: ElementBounds;
  duration?: number;
}

export interface CtrlProxyRequestActionOptions {
  abortSignal?: AbortSignal;
  duration?: number;
  /** Fires once the request frame was written; after it the action may have run. */
  onDispatch?: () => void;
}

/**
 * Delegate class for VoiceOver state detection via CtrlProxy WebSocket.
 */
export class CtrlProxyVoiceOver {
  private readonly context: DelegateContext;

  constructor(context: DelegateContext) {
    this.context = context;
  }

  /** Invoke the foreground app's SDK responder chain, even with VoiceOver off. */
  async requestMagicTap(
    timeoutMs: number = 5000,
    perf?: PerformanceTracker,
    signal?: AbortSignal,
  ): Promise<CtrlProxyMagicTapResult> {
    const failure = (error: string, unsupported = false): CtrlProxyMagicTapResult => ({
      success: false,
      unsupported,
      requiresVoiceOver: false,
      totalTimeMs: 0,
      error,
    });
    return sendCommand<CtrlProxyMagicTapResult>(this.context, {
      idPrefix: "magicTap",
      responseType: "magic_tap_result",
      messageType: "request_magic_tap",
      timeoutMs,
      perf,
      abortSignal: signal,
      cancelScreenshotBackoff: false,
      notConnectedError: () => failure("Not connected to CtrlProxy"),
      unsupportedCommandError: (_type, error) => failure(error, true),
      timeoutError: () => failure("Timeout waiting for magic_tap_result"),
    });
  }

  /**
   * Request current VoiceOver state from the iOS CtrlProxy.
   *
   * @param timeoutMs - Request timeout in milliseconds (default: 5000)
   * @param perf - Optional performance tracker
   * @returns VoiceOver state result with enabled boolean
   */
  async requestVoiceOverState(
    timeoutMs: number = IOS_VOICEOVER_STATE_REQUEST_TIMEOUT_MS,
    perf?: PerformanceTracker,
    signal?: AbortSignal,
  ): Promise<CtrlProxyVoiceOverResult> {
    return sendCommand<CtrlProxyVoiceOverResult>(this.context, {
      idPrefix: "voiceover",
      responseType: "voiceover",
      messageType: "get_voiceover_state",
      timeoutMs,
      perf,
      cancelScreenshotBackoff: false,
      // See SharedGestureDelegate.requestTapCoordinates: an already-expired
      // caller deadline must not dispatch this probe after `ensureConnected()`
      // resolves (issue #6306 review).
      abortSignal: signal,
      notConnectedError: () => ({
        success: false,
        enabled: false,
        error: "Not connected to CtrlProxy",
      }),
      unsupportedCommandError: (_messageType, error) => ({
        success: false,
        enabled: false,
        totalTimeMs: 0,
        error,
      }),
      timeoutError: () => ({
        success: false,
        enabled: false,
        error: "Timeout waiting for voiceover_state_result",
      }),
    });
  }

  /**
   * Request an accessibility action on an element by resourceId or label.
   *
   * Used to perform scroll_forward/scroll_backward via the accessibility node system,
   * more reliable than coordinate gestures when VoiceOver is active.
   *
   * @param action - The action to perform (e.g. "scroll_forward", "scroll_backward")
   * @param resourceId - The resource-id / accessibility identifier of the target element
   * @param label - The accessibility label (content-desc) as fallback when no resourceId
   * @param timeoutMs - Request timeout in milliseconds (default: 5000)
   * @param perf - Optional performance tracker
   * @param options - Optional caller cancellation signal and action duration
   * @returns Action result
   */
  async requestAction(
    action: string,
    resourceId?: string,
    label?: string,
    timeoutMs: number = 5000,
    perf?: PerformanceTracker,
    options?: CtrlProxyRequestActionOptions,
  ): Promise<CtrlProxyActionResult> {
    let dispatched = false;
    const result = await sendCommand<CtrlProxyActionResult>(this.context, {
      idPrefix: "action",
      responseType: "action",
      messageType: "request_action",
      params: {
        action,
        resourceId: resourceId ?? null,
        label: label ?? null,
        duration: options?.duration,
      },
      timeoutMs,
      perf,
      cancelScreenshotBackoff: false,
      abortSignal: options?.abortSignal,
      onDispatch: () => {
        dispatched = true;
        options?.onDispatch?.();
      },
      notConnectedError: () => ({ success: false, error: "Not connected to CtrlProxy" }),
      // A write that was never answered may have run: say so, and do not invite a retry.
      timeoutError: () => ({
        success: false,
        error: "Timeout waiting for action_result",
        ...(dispatched ? { dispatched, acknowledged: false, retryable: false } : {}),
      }),
    });
    // Only the unanswered path above sets acknowledged:false; any reply confirms the runner answered.
    return dispatched
      ? { ...result, dispatched, acknowledged: result.acknowledged ?? true }
      : result;
  }

  /**
   * On iOS, occurrence is the zero-based index among case-insensitive text matches
   * within the owning text element. Without ownerResourceId, use the first owner
   * carrying a matching link in document order (previously counted tree-wide).
   * Multiple candidate owners produce a runner warning; scope with container/subtext
   * for a specific owner. The XCUITest fallback refuses owner-less occurrence > 0.
   * Android remains unchanged: count matching links in document order within the
   * owner's subtree, or the whole active-window tree when owner-less.
   */
  // Keep existing positional arguments compatible while adding cancellation and dispatch tracking.
  // oxlint-disable-next-line max-params
  async requestActivateAccessibilityLink(
    text: string,
    occurrence: number,
    ownerResourceId?: string,
    timeoutMs: number = 5000,
    perf?: PerformanceTracker,
    signal?: AbortSignal,
    onDispatch?: () => void,
  ): Promise<CtrlProxyActionResult> {
    const combinedSignal = combineWithAmbientAbort(signal);
    let dispatched = false;
    const unconfirmed = (error: string): CtrlProxyActionResult => ({
      success: false,
      error,
      dispatched,
      acknowledged: false,
      ...(dispatched ? { retryable: false } : {}),
    });
    try {
      combinedSignal?.throwIfAborted();
      const result = await sendCommand<CtrlProxyActionResult>(this.context, {
        idPrefix: "accessibility_link",
        responseType: "action",
        messageType: "request_activate_accessibility_link",
        params: { text, occurrence, ownerResourceId: ownerResourceId ?? null },
        timeoutMs,
        perf,
        cancelScreenshotBackoff: false,
        abortSignal: combinedSignal,
        onDispatch: () => {
          dispatched = true;
          onDispatch?.();
        },
        notConnectedError: () => unconfirmed("Not connected to CtrlProxy"),
        // Capability misses and runner refusals preserve their original errors.
        unsupportedCommandError: (_messageType, error) => ({ success: false, error }),
        timeoutError: () => unconfirmed("Timeout waiting for semantic link activation"),
      });
      return { ...result, dispatched, acknowledged: result.acknowledged ?? dispatched };
    } catch (error) {
      // A unit test reached the real WebSocket factory; fail it, never resolve a typed failure.
      rethrowRealCtrlProxyWebSocketInTestError(error);
      // A dispatched structured runner refusal retains its original throw contract.
      if (dispatched && error instanceof ActionableError && error !== combinedSignal?.reason) {
        throw error;
      }
      logger.warn("[CtrlProxyVoiceOver] Semantic link activation transport failed", error);
      return unconfirmed(errorMessage(error));
    } finally {
      // Pre-dispatch cancellation must escape without a failure result or fallback.
      if (!dispatched) {
        combinedSignal?.throwIfAborted();
      }
    }
  }

  /**
   * Activate an element by its accessibility label via the runner's node-action path.
   *
   * Rides the existing `request_action` command (element lookup by label, then
   * `activate`→tap / `long_press`→press in the Swift `performAction`) rather than a
   * dedicated `request_voiceover_action` command, which never existed in the Swift
   * `RequestType` and so failed to decode on-device — always falling back to a
   * coordinate tap (issue #2857). The runner replies `action_result`, which decodes
   * into a `CtrlProxyActionResult` — the same shape `requestAction` returns (the
   * two were merged in #2956).
   *
   * @param label - The accessibility label of the target element
   * @param action - The action to perform: "activate" or "long_press"
   * @param timeoutMs - Request timeout in milliseconds (default: 5000)
   * @param perf - Optional performance tracker
   * @returns Action result
   */
  /**
   * Enable or disable VoiceOver via the runner.
   *
   * On the Simulator VoiceOver is toggled host-side with `simctl` (see
   * VoiceOverToggle); on a **physical** device there is no command-line write
   * into the system-preferences domain, so the runner drives the Settings app
   * (open `App-Prefs:root=ACCESSIBILITY`, read the VoiceOver switch, tap only
   * when it differs). The runner early-returns when already in the target state
   * because once VoiceOver is on every tap requires the double-tap idiom — so a
   * blind re-tap would be interpreted as an activation, not a toggle (#2501).
   *
   * @param enabled - Target VoiceOver state
   * @param timeoutMs - Request timeout (default 30000; Settings navigation is slow)
   * @param perf - Optional performance tracker
   * @returns Action result — `success:false` with `error` when the Settings row
   *          cannot be located (locale/layout drift), never a silent success.
   */
  async requestSetVoiceOverEnabled(
    enabled: boolean,
    timeoutMs: number = 30000,
    perf?: PerformanceTracker,
  ): Promise<CtrlProxyActionResult> {
    return sendCommand<CtrlProxyActionResult>(this.context, {
      idPrefix: "voiceover_set",
      responseType: "voiceover_set",
      messageType: "set_voiceover_state",
      params: { enabled },
      timeoutMs,
      perf,
      cancelScreenshotBackoff: false,
      notConnectedError: () => ({ success: false, error: "Not connected to CtrlProxy" }),
      // The command is new: an older runner that predates it must surface as a
      // typed failure so VoiceOverToggle reports supported:false (never a silent
      // success), parity with requestVoiceOverActivate.
      unsupportedCommandError: (_messageType, error) => ({ success: false, totalTimeMs: 0, error }),
      timeoutError: () => ({ success: false, error: "Timeout waiting for voiceover_set_result" }),
    });
  }

  async requestVoiceOverActivate(
    label: string,
    action: "activate" | "long_press",
    timeoutMs: number = DEFAULT_GESTURE_REQUEST_TIMEOUT_MS,
    perf?: PerformanceTracker,
    options?: VoiceOverActivationOptions,
  ): Promise<CtrlProxyActionResult> {
    const signal = getAbortSignal();
    let dispatched = false;
    const unconfirmed = (error: string): CtrlProxyActionResult => ({
      success: false,
      error,
      dispatched,
      acknowledged: false,
      ...(dispatched ? { retryable: false } : {}),
    });
    try {
      const result = await sendCommand<CtrlProxyActionResult>(this.context, {
        idPrefix: "voiceover_action",
        responseType: "action",
        messageType: "request_action",
        params: { label, action, bounds: options?.bounds, duration: options?.duration },
        timeoutMs,
        perf,
        cancelScreenshotBackoff: false,
        abortSignal: signal,
        onDispatch: () => {
          dispatched = true;
        },
        notConnectedError: () => unconfirmed("Not connected to CtrlProxy"),
        // Pre-dispatch capability misses and positive runner refusals both permit fallback.
        unsupportedCommandError: (_messageType, error) => ({
          success: false,
          totalTimeMs: 0,
          error,
        }),
        timeoutError: () => unconfirmed("Timeout waiting for action_result"),
      });
      // Only timeout/transport paths supply acknowledged:false. A normal response
      // after dispatch confirms the runner answered, regardless of its error text.
      return { ...result, dispatched, acknowledged: result.acknowledged ?? dispatched };
    } catch (error) {
      // A unit test reached the real WebSocket factory; fail it, never resolve a typed failure.
      rethrowRealCtrlProxyWebSocketInTestError(error);
      // A dispatched ActionableError acknowledges a runner refusal, except for
      // the caller's abort reason; preserve the refusal's original throw contract.
      if (dispatched && error instanceof ActionableError && error !== signal?.reason) {
        throw error;
      }
      logger.warn("[CtrlProxyVoiceOver] Activation transport failed", error);
      return unconfirmed(errorMessage(error));
    } finally {
      // Cancellation before dispatch must escape both result and catch paths without fallback.
      if (!dispatched) {
        signal?.throwIfAborted();
      }
    }
  }
}
