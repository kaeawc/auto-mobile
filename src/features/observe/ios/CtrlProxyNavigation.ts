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
  CtrlProxyRecentAppsResult,
  CtrlProxyLaunchAppResult,
  CtrlProxyRotateResult,
} from "./types";

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
    perf?: PerformanceTracker
  ): Promise<CtrlProxyPressHomeResult> {
    return this.sendRequest<CtrlProxyPressHomeResult>(
      "pressHome",
      "press_home",
      "request_press_home",
      { timeoutMs, perf },
      (_id, _type, timeout) => ({
        success: false,
        totalTimeMs: timeout,
        error: `Press home timed out after ${timeout}ms`,
      }),
    );
  }

  /**
   * Request to rotate device orientation.
   */
  async requestRotate(
    orientation: string,
    timeoutMs: number = 5000,
    perf?: PerformanceTracker
  ): Promise<CtrlProxyRotateResult> {
    if (!await this.context.ensureConnected(perf)) {
      return { success: false, totalTimeMs: 0, error: "Not connected", previousOrientation: "", currentOrientation: "", value: 0, rotationPerformed: false };
    }

    const requestId = this.context.requestManager.generateId("rotate");
    const promise = this.context.requestManager.register<CtrlProxyRotateResult>(
      requestId,
      "rotate",
      timeoutMs,
      (_id, _type, timeout) => ({
        success: false,
        totalTimeMs: timeout,
        error: `Rotate timed out after ${timeout}ms`,
        previousOrientation: "",
        currentOrientation: "",
        value: 0,
        rotationPerformed: false
      })
    );

    const message = {
      type: "request_rotate",
      requestId,
      orientation
    };

    const ws = this.context.getWebSocket();
    ws?.send(JSON.stringify(message));
    return promise;
  }

  /**
   * Request to launch an app by bundle ID.
   */
  async requestLaunchApp(
    bundleId: string,
    timeoutMs: number = 10000,
    perf?: PerformanceTracker,
    coldBoot: boolean = false
  ): Promise<CtrlProxyLaunchAppResult> {
    return this.sendRequest<CtrlProxyLaunchAppResult>(
      "launchApp",
      "launch_app",
      "request_launch_app",
      { timeoutMs, perf, extras: { bundleId, coldBoot } },
      (_id, _type, timeout) => ({
        success: false,
        totalTimeMs: timeout,
        error: `Launch app timed out after ${timeout}ms`,
      }),
    );
  }

  /**
   * Send a WebSocket request with perf timing for each phase:
   *   ensureConnected → wsSend → wsAwaitResponse
   */
  private async sendRequest<T>(
    idPrefix: string,
    requestType: string,
    messageType: string,
    opts: {
      timeoutMs: number;
      perf?: PerformanceTracker;
      extras?: Record<string, unknown>;
    },
    errorFactory: (id: string, type: string, timeout: number) => T,
  ): Promise<T> {
    const { timeoutMs, perf, extras } = opts;

    const connected = perf
      ? await perf.track("ensureConnected", () => this.context.ensureConnected(perf))
      : await this.context.ensureConnected();

    if (!connected) {
      return {
        ...errorFactory("", requestType, 0),
        error: "Not connected to CtrlProxy",
      } as T;
    }

    const requestId = this.context.requestManager.generateId(idPrefix);
    const promise = this.context.requestManager.register<T>(
      requestId,
      requestType,
      timeoutMs,
      errorFactory,
    );

    const message = { type: messageType, requestId, ...extras };

    if (perf) {
      perf.trackSync("wsSend", () => {
        this.context.getWebSocket()?.send(JSON.stringify(message));
      });
      return perf.track("wsAwaitResponse", () => promise);
    }

    this.context.getWebSocket()?.send(JSON.stringify(message));
    return promise;
  }

  /**
   * Request to open recent apps (app switcher).
   */
  async requestRecentApps(
    timeoutMs: number = 5000,
    perf?: PerformanceTracker
  ): Promise<CtrlProxyRecentAppsResult> {
    if (!await this.context.ensureConnected(perf)) {
      return { success: false, totalTimeMs: 0, error: "Not connected" };
    }

    const requestId = this.context.requestManager.generateId("recentApps");
    const promise = this.context.requestManager.register<CtrlProxyRecentAppsResult>(
      requestId,
      "recent_apps",
      timeoutMs,
      (_id, _type, timeout) => ({
        success: false,
        totalTimeMs: timeout,
        error: `Recent apps timed out after ${timeout}ms`
      })
    );

    const message = {
      type: "request_recent_apps",
      requestId
    };

    const ws = this.context.getWebSocket();
    ws?.send(JSON.stringify(message));
    return promise;
  }
}
