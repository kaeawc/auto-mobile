import { BootedDevice } from "../../models";
import { logger } from "../../utils/logger";
import { Timer } from "../../utils/SystemTimer";
import { IOSCtrlProxyClient, type IosCtrlProxy } from "../observe/ios";
import { errorMessage } from "../../utils/describeUnknownError";
import { raceWithDeadline } from "../../utils/raceWithDeadline";

interface IosLaunchHierarchyDependencies {
  device: BootedDevice;
  timer: Timer;
}
/** Races hierarchy push and sync readiness without changing the launch target. */
export class IosLaunchHierarchy {
  constructor(private readonly deps: IosLaunchHierarchyDependencies) {}
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
      this.deps.timer.clearTimeout(timeoutHandle);
    }
  }

  async waitForIosHierarchyReady(
    timeoutMs: number = 5000,
    expectedPackageName?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    const xcTestClient = IOSCtrlProxyClient.getInstance(this.deps.device);
    const startTime = this.deps.timer.now();

    // Fast path: if cache already has the correct app's hierarchy, skip the round-trip.
    // This makes warm launches (app already foreground) ~0ms instead of ~133ms.
    const cached = await xcTestClient.getLatestHierarchy(false, 0, undefined, true, 0);
    const cachedPkg = (cached?.hierarchy as { packageName?: string } | null)?.packageName;
    if (this.isCachedIosHierarchyReady(cachedPkg, expectedPackageName)) {
      logger.info(
        `[LaunchApp] iOS hierarchy already cached (pkg=${cachedPkg}, ${this.deps.timer.now() - startTime}ms)`,
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
        timeoutHandle = this.deps.timer.setTimeout(() => resolve("timeout"), timeoutMs);
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
          timer: this.deps.timer,
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
          `[LaunchApp] iOS hierarchy ready via ${winner} after ${this.deps.timer.now() - startTime}ms (pkg=${expectedPackageName})`,
        );

        return;
      }
    } else {
      // No expected packageName — just do one forced sync to get any hierarchy
      try {
        await xcTestClient.requestHierarchySync(undefined, true, undefined, timeoutMs);
        logger.info(`[LaunchApp] iOS hierarchy ready after ${this.deps.timer.now() - startTime}ms`);
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
