/**
 * CtrlProxy iOS VoiceOver - Delegate for VoiceOver state detection.
 *
 * Sends a get_voiceover_state command over the WebSocket connection to the
 * iOS CtrlProxy, which calls UIAccessibility.isVoiceOverRunning and returns
 * the result.
 */

import type { PerformanceTracker } from "../../../utils/PerformanceTracker";
import type { DelegateContext, CtrlProxyVoiceOverResult, CtrlProxyActionResult } from "./types";
import { sendCommand } from "../DeviceServiceUtils";

/**
 * Delegate class for VoiceOver state detection via CtrlProxy WebSocket.
 */
export class CtrlProxyVoiceOver {
  private readonly context: DelegateContext;

  constructor(context: DelegateContext) {
    this.context = context;
  }

  /**
   * Request current VoiceOver state from the iOS CtrlProxy.
   *
   * @param timeoutMs - Request timeout in milliseconds (default: 5000)
   * @param perf - Optional performance tracker
   * @returns VoiceOver state result with enabled boolean
   */
  async requestVoiceOverState(
    timeoutMs: number = 5000,
    perf?: PerformanceTracker,
  ): Promise<CtrlProxyVoiceOverResult> {
    return sendCommand<CtrlProxyVoiceOverResult>(this.context, {
      idPrefix: "voiceover",
      responseType: "voiceover",
      messageType: "get_voiceover_state",
      timeoutMs,
      perf,
      cancelScreenshotBackoff: false,
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
   * @returns Action result
   */
  async requestAction(
    action: string,
    resourceId?: string,
    label?: string,
    timeoutMs: number = 5000,
    perf?: PerformanceTracker,
  ): Promise<CtrlProxyActionResult> {
    return sendCommand<CtrlProxyActionResult>(this.context, {
      idPrefix: "action",
      responseType: "action",
      messageType: "request_action",
      params: { action, resourceId: resourceId ?? null, label: label ?? null },
      timeoutMs,
      perf,
      cancelScreenshotBackoff: false,
      notConnectedError: () => ({ success: false, error: "Not connected to CtrlProxy" }),
      timeoutError: () => ({ success: false, error: "Timeout waiting for action_result" }),
    });
  }

  async requestActivateAccessibilityLink(
    text: string,
    occurrence: number,
    ownerResourceId?: string,
    timeoutMs: number = 5000,
    perf?: PerformanceTracker,
  ): Promise<CtrlProxyActionResult> {
    return sendCommand<CtrlProxyActionResult>(this.context, {
      idPrefix: "accessibility_link",
      responseType: "action",
      messageType: "request_activate_accessibility_link",
      params: { text, occurrence, ownerResourceId: ownerResourceId ?? null },
      timeoutMs,
      perf,
      cancelScreenshotBackoff: false,
      notConnectedError: () => ({ success: false, error: "Not connected to CtrlProxy" }),
      unsupportedCommandError: () => ({
        success: false,
        error: "Connected iOS runner does not support semantic accessibility-link activation",
      }),
      timeoutError: () => ({
        success: false,
        error: "Timeout waiting for semantic link activation",
      }),
    });
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
    timeoutMs: number = 5000,
    perf?: PerformanceTracker,
  ): Promise<CtrlProxyActionResult> {
    return sendCommand<CtrlProxyActionResult>(this.context, {
      idPrefix: "voiceover_action",
      responseType: "action",
      messageType: "request_action",
      params: { label, action },
      timeoutMs,
      perf,
      cancelScreenshotBackoff: false,
      notConnectedError: () => ({ success: false, error: "Not connected to CtrlProxy" }),
      // Parity with requestVoiceOverState: request_action is a real command, so this
      // is defense-in-depth against an older runner that predates it (#2956).
      unsupportedCommandError: (_messageType, error) => ({ success: false, totalTimeMs: 0, error }),
      timeoutError: () => ({ success: false, error: "Timeout waiting for action_result" }),
    });
  }
}
