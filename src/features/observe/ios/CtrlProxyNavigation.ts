import { sendIOSPressCommand, type IOSDispatchResult } from "./CtrlProxyDispatch";
/**
 * CtrlProxy iOSNavigation - Delegate for navigation operations.
 *
 * This delegate handles navigation operations including pressHome and launchApp
 * via the iOS CtrlProxy iOS WebSocket API.
 */

import type { PerformanceTracker } from "../../../utils/PerformanceTracker";
import type {
  DelegateContext,
  CtrlProxyPressHomeResult,
  CtrlProxyPressBackResult,
  CtrlProxyShakeResult,
  CtrlProxyPressButtonResult,
  CtrlProxyRecentAppsResult,
  CtrlProxyLaunchAppResult,
  CtrlProxyRotateResult,
  CtrlProxyHingeAngleResult,
} from "./types";
import { sendCommand } from "../DeviceServiceUtils";

/**
 * Delegate class for handling navigation operations.
 */
export class CtrlProxyNavigation {
  private readonly context: DelegateContext;

  constructor(context: DelegateContext) {
    this.context = context;
  }

  /**
   * Request to press the home button.
   */
  async requestPressHome(
    timeoutMs: number = 5000,
    perf?: PerformanceTracker,
    frameContext?: string,
    signal?: AbortSignal,
    onDispatch?: () => void,
  ): Promise<IOSDispatchResult<CtrlProxyPressHomeResult>> {
    return sendIOSPressCommand(
      this.context,
      {
        idPrefix: "pressHome",
        responseType: "press_home",
        messageType: "request_press_home",
        params: frameContext === undefined ? undefined : { frameContext },
        timeoutMs,
        abortSignal: signal,
        perf,
        onDispatch,
        cancelScreenshotBackoff: false,
        notConnectedMessage: "Not connected to CtrlProxy",
        errorLabel: "Press home",
      },
      true,
    );
  }

  /**
   * Request app-level back navigation.
   */
  async requestPressBack(
    timeoutMs: number = 5000,
    perf?: PerformanceTracker,
    frameContext?: string,
    signal?: AbortSignal,
    onDispatch?: () => void,
  ): Promise<IOSDispatchResult<CtrlProxyPressBackResult>> {
    return sendIOSPressCommand(this.context, {
      idPrefix: "pressBack",
      responseType: "press_back",
      messageType: "request_press_back",
      params: frameContext === undefined ? undefined : { frameContext },
      timeoutMs,
      abortSignal: signal,
      perf,
      onDispatch,
      cancelScreenshotBackoff: false,
      notConnectedMessage: "Not connected to CtrlProxy",
      errorLabel: "Press back",
    });
  }

  /**
   * Request a synthetic device shake.
   */
  async requestShake(
    timeoutMs: number = 5000,
    perf?: PerformanceTracker,
    signal?: AbortSignal,
  ): Promise<CtrlProxyShakeResult> {
    return sendCommand<CtrlProxyShakeResult>(this.context, {
      idPrefix: "shake",
      responseType: "shake",
      messageType: "request_shake",
      timeoutMs,
      abortSignal: signal,
      perf,
      cancelScreenshotBackoff: false,
      notConnectedMessage: "Not connected to CtrlProxy",
      errorLabel: "Shake",
    });
  }

  /**
   * Request to press a named iOS hardware or navigation button.
   */
  async requestPressButton(
    button: string,
    timeoutMs: number = 5000,
    perf?: PerformanceTracker,
    frameContext?: string,
    signal?: AbortSignal,
    onDispatch?: () => void,
  ): Promise<IOSDispatchResult<CtrlProxyPressButtonResult>> {
    return sendIOSPressCommand(
      this.context,
      {
        idPrefix: "pressButton",
        responseType: "press_button",
        messageType: "request_press_button",
        params: frameContext === undefined ? { action: button } : { action: button, frameContext },
        timeoutMs,
        abortSignal: signal,
        perf,
        onDispatch,
        cancelScreenshotBackoff: false,
        notConnectedMessage: "Not connected to CtrlProxy",
        errorLabel: "Press button",
      },
      button.toLowerCase() === "home",
    );
  }

  /**
   * Request to rotate device orientation.
   */
  async requestRotate(
    orientation: string,
    timeoutMs: number = 5000,
    perf?: PerformanceTracker,
  ): Promise<CtrlProxyRotateResult> {
    return sendCommand<CtrlProxyRotateResult>(this.context, {
      idPrefix: "rotate",
      responseType: "rotate",
      messageType: "request_rotate",
      params: { orientation },
      timeoutMs,
      perf,
      cancelScreenshotBackoff: false,
      notConnectedError: () => ({
        success: false,
        totalTimeMs: 0,
        error: "Not connected",
        previousOrientation: "",
        currentOrientation: "",
        value: 0,
        rotationPerformed: false,
      }),
      unsupportedCommandError: (_messageType, error) => ({
        success: false,
        totalTimeMs: 0,
        error,
        previousOrientation: "",
        currentOrientation: "",
        value: 0,
        rotationPerformed: false,
      }),
      timeoutError: (timeout) => ({
        success: false,
        totalTimeMs: timeout,
        error: `Rotate timed out after ${timeout}ms`,
        previousOrientation: "",
        currentOrientation: "",
        value: 0,
        rotationPerformed: false,
      }),
    });
  }

  async requestSetHingeAngle(
    angle: number,
    timeoutMs: number = 5000,
  ): Promise<CtrlProxyHingeAngleResult> {
    return sendCommand<CtrlProxyHingeAngleResult>(this.context, {
      idPrefix: "hingeAngle",
      responseType: "hingeAngle",
      messageType: "set_hinge_angle",
      params: { angle },
      timeoutMs,
      cancelScreenshotBackoff: false,
      notConnectedError: () => ({ success: false, totalTimeMs: 0, error: "Not connected" }),
      unsupportedCommandError: (_messageType, error) => ({
        success: false,
        totalTimeMs: 0,
        error,
      }),
      timeoutError: (timeout) => ({
        success: false,
        totalTimeMs: timeout,
        error: `Set hinge angle timed out after ${timeout}ms`,
      }),
    });
  }

  /**
   * Request to launch an app by bundle ID.
   */
  async requestLaunchApp(
    bundleId: string,
    timeoutMs: number = 10000,
    perf?: PerformanceTracker,
    coldBoot: boolean = false,
    signal?: AbortSignal,
  ): Promise<CtrlProxyLaunchAppResult> {
    return sendCommand<CtrlProxyLaunchAppResult>(this.context, {
      idPrefix: "launchApp",
      responseType: "launch_app",
      messageType: "request_launch_app",
      params: { bundleId, coldBoot },
      timeoutMs,
      perf,
      cancelScreenshotBackoff: false,
      abortSignal: signal,
      notConnectedMessage: "Not connected to CtrlProxy",
      errorLabel: "Launch app",
    });
  }

  /**
   * Request to open recent apps (app switcher).
   */
  async requestRecentApps(
    timeoutMs: number = 5000,
    perf?: PerformanceTracker,
    frameContext?: string,
    signal?: AbortSignal,
    onDispatch?: () => void,
  ): Promise<IOSDispatchResult<CtrlProxyRecentAppsResult>> {
    return sendIOSPressCommand(this.context, {
      idPrefix: "recentApps",
      responseType: "recent_apps",
      messageType: "request_recent_apps",
      params: frameContext === undefined ? undefined : { frameContext },
      timeoutMs,
      abortSignal: signal,
      perf,
      onDispatch,
      cancelScreenshotBackoff: false,
      errorLabel: "Recent apps",
    });
  }
}
