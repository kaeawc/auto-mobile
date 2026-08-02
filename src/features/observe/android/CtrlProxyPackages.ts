/**
 * CtrlProxyPackages - Delegate for PackageManager-backed queries over WebSocket.
 *
 * Replaces ADB `pm list packages` / `dumpsys package <pkg>` / `pm dump <pkg>` round-trips
 * with a direct PackageManager call inside the accessibility service.
 */

import WebSocket from "ws";
import type { DelegateContext } from "./types";
import { generateSecureId } from "./types";
import type {
  A11yInstalledPackagesResult,
  A11yPackageInfoResult,
  A11yLaunchIntentResult,
} from "./types";
import { ctrlProxyRequests, serializeCtrlProxyRequest } from "./ctrlProxyProtocol";
import { logger } from "../../../utils/logger";

export interface PackageInfoOptions {
  includePermissions?: boolean;
}

export class CtrlProxyPackages {
  private readonly context: DelegateContext;

  constructor(context: DelegateContext) {
    this.context = context;
  }

  async requestInstalledPackages(
    includeSystem: boolean = true,
    userId?: number,
    timeoutMs: number = 5000
  ): Promise<A11yInstalledPackagesResult> {
    const startTime = this.context.timer.now();

    try {
      const ws0 = this.context.getWebSocket();
      const connected = ws0 !== null && ws0 !== undefined && ws0.readyState === WebSocket.OPEN;
      // Why: package queries are an optimization over ADB. Don't trigger a slow
      // WebSocket setup just for the optimistic path — let callers fall back to ADB.
      if (!connected) {
        return {
          success: false,
          userId: userId ?? -1,
          packages: [],
          totalTimeMs: this.context.timer.now() - startTime,
          error: "WebSocket not connected",
        };
      }

      // Check the socket is OPEN BEFORE registering, so an already-closed socket
      // never leaves a registered request orphaned (a later cancelAll would reject
      // an un-awaited promise as an unhandled rejection).
      const ws = this.context.getWebSocket();
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        throw new Error("WebSocket not connected");
      }

      const requestId = `installed_packages_${this.context.timer.now()}_${generateSecureId()}`;
      const resultPromise = this.context.requestManager.register<A11yInstalledPackagesResult>(
        requestId,
        "installed_packages",
        timeoutMs,
        (_id, _type, timeout) => ({
          success: false,
          userId: userId ?? -1,
          packages: [],
          totalTimeMs: this.context.timer.now() - startTime,
          error: `Installed packages timeout after ${timeout}ms`,
        })
      );

      try {
        ws.send(
          serializeCtrlProxyRequest(
            ctrlProxyRequests.requestInstalledPackages({ requestId, includeSystem, userId })
          )
        );
      } catch (sendError) {
        // Settle the registered request rather than orphaning it (see requestPackageInfo).
        logger.warn(`[CtrlProxyPackages] installed_packages send failed: ${sendError}`);
        this.context.requestManager.resolveError(
          requestId,
          `${sendError}`,
          this.context.timer.now() - startTime
        );
      }

      return await resultPromise;
    } catch (error) {
      return {
        success: false,
        userId: userId ?? -1,
        packages: [],
        totalTimeMs: this.context.timer.now() - startTime,
        error: `${error}`,
      };
    }
  }

  async requestPackageInfo(
    packageName: string,
    options: PackageInfoOptions = {},
    timeoutMs: number = 5000
  ): Promise<A11yPackageInfoResult> {
    const startTime = this.context.timer.now();

    try {
      const ws0 = this.context.getWebSocket();
      const connected = ws0 !== null && ws0 !== undefined && ws0.readyState === WebSocket.OPEN;
      // Why: package queries are an optimization over ADB. Don't trigger a slow
      // WebSocket setup just for the optimistic path — let callers fall back to ADB.
      if (!connected) {
        return {
          success: false,
          packageName,
          isSystem: false,
          requestedPermissions: [],
          grantedPermissions: {},
          totalTimeMs: this.context.timer.now() - startTime,
          error: "WebSocket not connected",
        };
      }

      // Check the socket is OPEN BEFORE registering, so an already-closed socket
      // never leaves a registered request orphaned (a later cancelAll would reject
      // an un-awaited promise as an unhandled rejection).
      const ws = this.context.getWebSocket();
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        throw new Error("WebSocket not connected");
      }

      const requestId = `package_info_${this.context.timer.now()}_${generateSecureId()}`;
      const resultPromise = this.context.requestManager.register<A11yPackageInfoResult>(
        requestId,
        "package_info",
        timeoutMs,
        (_id, _type, timeout) => ({
          success: false,
          packageName,
          isSystem: false,
          requestedPermissions: [],
          grantedPermissions: {},
          totalTimeMs: this.context.timer.now() - startTime,
          error: `Package info timeout after ${timeout}ms`,
        })
      );

      try {
        ws.send(
          serializeCtrlProxyRequest(
            ctrlProxyRequests.requestPackageInfo({
              requestId,
              packageName,
              includePermissions: options.includePermissions ?? true,
            })
          )
        );
      } catch (sendError) {
        // Settle the just-registered request rather than orphaning it, so the
        // always-awaited resultPromise below returns the failure instead of a later
        // cancelAll surfacing an unhandled rejection.
        logger.warn(`[CtrlProxyPackages] package_info send failed for ${packageName}: ${sendError}`);
        this.context.requestManager.resolveError(
          requestId,
          `${sendError}`,
          this.context.timer.now() - startTime
        );
      }

      return await resultPromise;
    } catch (error) {
      return {
        success: false,
        packageName,
        isSystem: false,
        requestedPermissions: [],
        grantedPermissions: {},
        totalTimeMs: this.context.timer.now() - startTime,
        error: `${error}`,
      };
    }
  }

  async requestLaunchIntent(
    packageName: string,
    timeoutMs: number = 5000
  ): Promise<A11yLaunchIntentResult> {
    const startTime = this.context.timer.now();

    try {
      const ws0 = this.context.getWebSocket();
      const connected = ws0 !== null && ws0 !== undefined && ws0.readyState === WebSocket.OPEN;
      // Why: package queries are an optimization over ADB. Don't trigger a slow
      // WebSocket setup just for the optimistic path — let callers fall back to ADB.
      if (!connected) {
        return {
          success: false,
          packageName,
          totalTimeMs: this.context.timer.now() - startTime,
          error: "WebSocket not connected",
        };
      }

      // Check the socket is OPEN BEFORE registering, so an already-closed socket
      // never leaves a registered request orphaned (a later cancelAll would reject
      // an un-awaited promise as an unhandled rejection).
      const ws = this.context.getWebSocket();
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        throw new Error("WebSocket not connected");
      }

      const requestId = `launch_intent_${this.context.timer.now()}_${generateSecureId()}`;
      const resultPromise = this.context.requestManager.register<A11yLaunchIntentResult>(
        requestId,
        "launch_intent",
        timeoutMs,
        (_id, _type, timeout) => ({
          success: false,
          packageName,
          totalTimeMs: this.context.timer.now() - startTime,
          error: `Launch intent timeout after ${timeout}ms`,
        })
      );

      try {
        ws.send(
          serializeCtrlProxyRequest(ctrlProxyRequests.requestLaunchIntent({ requestId, packageName }))
        );
      } catch (sendError) {
        // Settle the registered request rather than orphaning it (see requestPackageInfo).
        logger.warn(`[CtrlProxyPackages] launch_intent send failed for ${packageName}: ${sendError}`);
        this.context.requestManager.resolveError(
          requestId,
          `${sendError}`,
          this.context.timer.now() - startTime
        );
      }

      return await resultPromise;
    } catch (error) {
      return {
        success: false,
        packageName,
        totalTimeMs: this.context.timer.now() - startTime,
        error: `${error}`,
      };
    }
  }

}
