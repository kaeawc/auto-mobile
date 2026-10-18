/**
 * LaunchAppIosHierarchyWaiter - iOS launch retargeting, pre-launch termination and the wait for CtrlProxy to publish the launched app hierarchy.
 *
 * Extracted from LaunchApp (max-class-lines). Reads device state through a
 * {@link LaunchAppContextProvider} so replaced executors stay visible.
 */

import { logger } from "../../utils/logger";
import { resolveIosColdStartTerminateBackend } from "../../utils/ios-cmdline-tools/IosDeviceBackend";
import { PerformanceTracker } from "../../utils/PerformanceTracker";
import { IOSCtrlProxyClient, type IosCtrlProxy } from "../observe/ios";
import { errorMessage } from "../../utils/describeUnknownError";
import { raceWithDeadline } from "../../utils/raceWithDeadline";

import type { LaunchAppContext } from "./launchAppContext";

export class LaunchAppIosHierarchyWaiter {
  constructor(private readonly ctx: () => LaunchAppContext) {}

  requestIosLaunchRetarget(
    ctrlProxyClient: IosCtrlProxy,
    bundleId: string,
    perf: PerformanceTracker,
  ) {
    const retargetAbortController = new AbortController();
    const retarget = ctrlProxyClient.requestLaunchApp(
      bundleId,
      undefined,
      perf,
      false,
      retargetAbortController.signal,
    );
    return { retargetAbortController, retarget };
  }

  async terminateIosAppBeforeLaunch(
    terminator: NonNullable<ReturnType<typeof resolveIosColdStartTerminateBackend>>,
    bundleId: string,
  ): Promise<void> {
    try {
      await terminator.terminateApp(bundleId);
    } catch (error) {
      // Cold-start cleanup may find no running app; launching still proceeds.
      logger.debug(`[LaunchApp] Pre-launch termination unavailable: ${errorMessage(error)}`);
    } finally {
      this.ctx().cacheInvalidator.invalidate(this.ctx().device);
    }
  }

  private requestIosHierarchyForPackage(
    xcTestClient: IosCtrlProxy,
    expectedPackageName: string,
    timeoutMs: number,
  ): Promise<string> {
    return xcTestClient
      .requestHierarchySync(undefined, true, undefined, timeoutMs)
      .then((result) => {
        const pkg = (result?.hierarchy as { packageName?: string } | null)?.packageName;
        if (pkg === expectedPackageName) {
          return "sync";
        }
        // A sync can race the app's first hierarchy push and still return the
        // previous foreground app. Keep waiting for that push or the real
        // timeout instead of letting "wrong app" win the race immediately.
        return new Promise<never>(() => {});
      })
      .catch((err) => {
        logger.warn(`[LaunchApp] iOS hierarchy sync failed during race: ${err}`);
        // A transient sync failure is not terminal while the push listener is
        // still active. The timeout promise remains the readiness bound.
        return new Promise<never>(() => {});
      });
  }

  private isCachedIosHierarchyReady(
    cachedPackageName: string | undefined,
    expectedPackageName?: string,
  ): boolean {
    return Boolean(
      cachedPackageName && (!expectedPackageName || cachedPackageName === expectedPackageName),
    );
  }

  private clearIosHierarchyTimeout(timeoutHandle: NodeJS.Timeout | undefined): void {
    if (timeoutHandle) {
      this.ctx().timer.clearTimeout(timeoutHandle);
    }
  }

  /** Waits for the iOS CtrlProxy hierarchy to be ready via push or sync. Public test seam (#11865). */
  async waitForIosHierarchyReady(
    timeoutMs: number = 5000,
    expectedPackageName?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    const xcTestClient = IOSCtrlProxyClient.getInstance(this.ctx().device);
    const startTime = this.ctx().timer.now();

    // Fast path: if cache already has the correct app's hierarchy, skip the round-trip.
    // This makes warm launches (app already foreground) ~0ms instead of ~133ms.
    const cached = await xcTestClient.getLatestHierarchy(false, 0, undefined, true, 0);
    const cachedPkg = (cached?.hierarchy as { packageName?: string } | null)?.packageName;
    if (this.isCachedIosHierarchyReady(cachedPkg, expectedPackageName)) {
      logger.info(
        `[LaunchApp] iOS hierarchy already cached (pkg=${cachedPkg}, ${this.ctx().timer.now() - startTime}ms)`,
      );
      return;
    }

    // Race a push listener against a forced sync request. Push notifications only
    // fire for unsolicited hierarchy_update messages (periodic pushes), while sync
    // responses go through requestManager.resolve() without notifying push listeners.
    // By racing both, we resolve as soon as either path delivers the correct app.
    if (expectedPackageName) {
      let pushUnsubscribe: (() => void) | undefined;
      let timeoutHandle: NodeJS.Timeout | undefined;

      const pushPromise = new Promise<string>((resolve) => {
        timeoutHandle = this.ctx().timer.setTimeout(() => resolve("timeout"), timeoutMs);
        pushUnsubscribe = xcTestClient.onPushUpdate((hierarchy) => {
          if (hierarchy.packageName === expectedPackageName) {
            resolve("push");
          }
        });
      });

      const syncPromise = this.requestIosHierarchyForPackage(
        xcTestClient,
        expectedPackageName,
        timeoutMs,
      );

      let winner: string;
      try {
        winner = await raceWithDeadline([pushPromise, syncPromise], {
          timer: this.ctx().timer,
          signal,
          label: "iOS hierarchy readiness",
          relabelDefaultAbort: false,
        });
        signal?.throwIfAborted();
      } finally {
        pushUnsubscribe?.();
        this.clearIosHierarchyTimeout(timeoutHandle);
      }

      if (winner === "push" || winner === "sync") {
        logger.info(
          `[LaunchApp] iOS hierarchy ready via ${winner} after ${this.ctx().timer.now() - startTime}ms (pkg=${expectedPackageName})`,
        );

        return;
      }
    } else {
      // No expected packageName — just do one forced sync to get any hierarchy
      try {
        await xcTestClient.requestHierarchySync(undefined, true, undefined, timeoutMs);
        logger.info(
          `[LaunchApp] iOS hierarchy ready after ${this.ctx().timer.now() - startTime}ms`,
        );
        return;
      } catch (error) {
        logger.warn(`[LaunchApp] iOS hierarchy sync failed: ${errorMessage(error)}`);
      }
    }

    logger.warn(
      `[LaunchApp] Timed out waiting for iOS hierarchy after ${timeoutMs}ms (expected=${expectedPackageName})`,
    );
  }
}
