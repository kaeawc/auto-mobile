import { logger } from "../utils/logger";
import type { Timer } from "../utils/SystemTimer";
import type { IosPrerequisiteDetector } from "../utils/ios-cmdline-tools/IosPrerequisiteDetector";
import type { CtrlProxyIosBuildResult, PrefetchBuilder } from "./IosCtrlProxyBuilder";

export interface IosCtrlProxyPrefetcherDeps {
  /** Only `now()` is needed, to report how long the prefetch took. */
  timer: Pick<Timer, "now">;
  /** Gate that skips the prefetch on hosts without a usable Xcode toolchain (#4407). */
  prerequisiteDetector: Pick<IosPrerequisiteDetector, "hasIosPrerequisites">;
  /** Resolves the builder to drive; evaluated lazily when the prefetch actually runs. */
  builder: () => PrefetchBuilder;
  /** Host platform; the prefetch only runs on macOS. Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
}

/**
 * The process-wide state of the startup runner-bundle prefetch (single flight, result,
 * error), kept apart from the per-configuration {@link IosCtrlProxyBuilder} instances so
 * it is built from injected interfaces and can be tested with fakes and no static resets.
 */
export class IosCtrlProxyPrefetcher {
  private promise: Promise<CtrlProxyIosBuildResult | null> | null = null;
  // True from prefetch() until its promise settles (#7032); pending() exposes the promise
  // only in that window.
  private inFlight = false;
  private result: CtrlProxyIosBuildResult | null = null;
  private error: Error | null = null;

  constructor(private readonly deps: IosCtrlProxyPrefetcherDeps) {}

  /** Prefetch at startup (background, non-blocking); later calls share the first run. */
  prefetch(): Promise<CtrlProxyIosBuildResult | null> {
    if ((this.deps.platform ?? process.platform) !== "darwin") {
      logger.info("[IOSCtrlProxyBuilder] Prefetch skipped (not macOS)");
      return Promise.resolve(null);
    }

    if (this.promise !== null) {
      logger.info("[IOSCtrlProxyBuilder] Prefetch already initiated, skipping");
      return this.promise;
    }

    logger.info("[IOSCtrlProxyBuilder] Starting download prefetch");
    const startTime = this.deps.timer.now();

    this.inFlight = true;
    this.promise = this.run()
      .then((result) => {
        const duration = this.deps.timer.now() - startTime;
        if (result && result.success) {
          this.result = result;
          logger.info(`[IOSCtrlProxyBuilder] Prefetch completed in ${duration}ms`, {
            buildPath: result.buildPath,
          });
        } else {
          logger.info(`[IOSCtrlProxyBuilder] Prefetch skipped or failed in ${duration}ms`, {
            message: result?.message,
          });
        }
        return result;
      })
      .catch((error) => {
        const duration = this.deps.timer.now() - startTime;
        this.error = error instanceof Error ? error : new Error(String(error));
        logger.warn(`[IOSCtrlProxyBuilder] Prefetch failed after ${duration}ms`, {
          error: this.error.message,
        });
        return null;
      })
      .finally(() => {
        this.inFlight = false;
      });
    return this.promise;
  }

  /**
   * The in-flight prefetch, or null when none was started or it has already settled (#7032).
   * Always resolves (never rejects): failures are recorded via {@link getError} and resolve null.
   */
  pending(): Promise<CtrlProxyIosBuildResult | null> | null {
    return this.inFlight ? this.promise : null;
  }

  /** Wait for the prefetch; resolves the prefetched result or null. */
  async wait(): Promise<CtrlProxyIosBuildResult | null> {
    if (this.promise === null) {
      return null;
    }

    try {
      await this.promise;
      return this.result;
    } catch (error) {
      // Background prefetch already failed and recorded its error via getError();
      // returning null here just means "no prefetched result", callers build on demand.
      logger.debug(`src/ctrlProxy/IosCtrlProxyBuilder.ts fallback failed: ${error}`, error);
      return null;
    }
  }

  getResult(): CtrlProxyIosBuildResult | null {
    return this.result;
  }

  getError(): Error | null {
    return this.error;
  }

  /** Forget every prefetch outcome (tests, and hosts that restart the runner). */
  reset(): void {
    this.promise = null;
    this.inFlight = false;
    this.result = null;
    this.error = null;
  }

  private async run(): Promise<CtrlProxyIosBuildResult | null> {
    // Skip cleanly on hosts that cannot consume the runner. Without the Xcode
    // toolchain (xcrun/xcodebuild) the bundle can never be installed or run, so
    // there is no reason to download and extract it at startup (issue #4407).
    // Returning null (not throwing) keeps the daemon healthy and non-iOS
    // workflows intact; the on-demand build path still runs when a device connects.
    if (!(await this.deps.prerequisiteDetector.hasIosPrerequisites())) {
      logger.info(
        "[IOSCtrlProxyBuilder] Prefetch skipped: iOS prerequisites (xcrun/xcodebuild) not detected; " +
          "the runner bundle is only needed for iOS device work",
      );
      return null;
    }

    const builder = this.deps.builder();
    const needsDownload = await builder.needsRebuild();
    if (!needsDownload) {
      const buildPath = await builder.getBuildProductsPath();
      const xctestrunPath = await builder.getXctestrunPath();
      return {
        success: true,
        message: "CtrlProxy artifacts are up to date",
        buildPath: buildPath || undefined,
        xctestrunPath: xctestrunPath || undefined,
      };
    }

    return builder.build();
  }
}
