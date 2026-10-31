/** Package, failure and frame-metrics persistence for Android CtrlProxy events. */
import type { InstalledAppsStore } from "../../../models/InstalledAppsStore";
import type { DbWriteBarrier } from "../../../db/dbWriteBarrier";
import type { InstalledAppsCacheWriteCoordinator } from "../../../db/installedAppsCacheWriteCoordinator";
import type { StackTraceElement } from "../../../models/failureAnalytics";
import type { CrashEventSink } from "../../../utils/interfaces/CrashMonitor";
import type { Timer } from "../../../utils/SystemTimer";
import type { WorkProfileMonitor } from "../../../utils/WorkProfileMonitor";
import { logger } from "../../../utils/logger";
import type { SdkFrameMetricsStore } from "../../performance/SdkFrameMetricsStore";
import {
  normalizeCrash,
  normalizeAnr,
  type SdkCrashPayload,
  type SdkAnrPayload,
} from "../crash/sdkCrashIngestion";
import type {
  AndroidSdkEventIngestor,
  AndroidHandledExceptionEvent,
} from "./AndroidSdkEventIngestor";
import { packageEventAndroidUserId } from "./CtrlProxyPackages";

/**
 * Interface for package event from accessibility service
 */
export interface AndroidPackageEvent {
  action: "added" | "removed" | "replaced";
  packageName: string;
  /** Android user id; APKs before #10067 sent the package uid here. */
  userId: number;
  /** Raw package uid; present only on APKs whose `userId` is a real user id (#10067). */
  uid?: number | null;
  isSystem?: boolean | null;
  removedForAllUsers?: boolean | null;
}

/** The recorder only patches existing installed-app snapshots. */
export type AndroidAppEventStore = Pick<
  InstalledAppsStore,
  "upsertInstalledApp" | "removeInstalledApp" | "removeInstalledAppForDevice" | "markDeviceStale"
>;

export interface AndroidFrameMetricsEvent {
  applicationId?: string;
  fps?: number;
  frameTimeMs?: number;
  jankFrames?: number;
  totalFrames?: number;
}

/** All effects are supplied by the client; getters resolve replaceable collaborators per use. */
export interface AndroidAppEventRecorderContext {
  deviceId: string;
  platform: "android" | "ios";
  timer: Pick<Timer, "now">;
  crashEventSink: CrashEventSink;
  getSdkEventIngestor: () => Pick<
    AndroidSdkEventIngestor,
    "recordHandledException" | "recordCrashAnalytics" | "recordAnrAnalytics"
  >;
  getInstalledAppsStore: () => AndroidAppEventStore;
  getWorkProfileMonitor?: () =>
    | Pick<WorkProfileMonitor, "setProfileHasAccessibilityService">
    | null
    | undefined;
  invalidateBuildContext: (appId: string) => void;
  getLastForegroundPackage: () => string | null;
  getFrameMetricsStore: () => Pick<SdkFrameMetricsStore, "ingest">;
  getInstalledAppsCacheWriteCoordinator: () => Pick<
    InstalledAppsCacheWriteCoordinator,
    "invalidate"
  >;
  getDbWriteBarrier: () => Pick<DbWriteBarrier, "track">;
}

export class AndroidAppEventRecorder {
  constructor(private readonly context: AndroidAppEventRecorderContext) {}

  async handlePackageEvent(event: AndroidPackageEvent, timestamp?: number): Promise<void> {
    if (this.context.platform !== "android") {
      return;
    }

    if (!event.packageName || !Number.isInteger(event.userId) || event.userId < 0) {
      logger.warn("[CTRL_PROXY] Ignoring package event with missing data");
      return;
    }

    const deviceId = this.context.deviceId;
    const androidUserId = packageEventAndroidUserId(event);
    const eventTimestamp = typeof timestamp === "number" ? timestamp : this.context.timer.now();
    const repo = this.context.getInstalledAppsStore();

    // Invalidate cached build/content-hash provenance for this package (#4984) so the
    // next nav event re-resolves the hash. Fires for every action (add/replace/remove)
    // — a rebuild+reinstall, INCLUDING the same-versionCode/different-content daily-dev
    // case, must not keep recording against the previous build's hash.
    this.context.invalidateBuildContext(event.packageName);

    try {
      if (event.action === "removed") {
        if (event.removedForAllUsers) {
          await repo.removeInstalledAppForDevice(deviceId, event.packageName);
        } else {
          await repo.removeInstalledApp(deviceId, androidUserId, event.packageName);
        }
      } else {
        const isSystem = event.isSystem === true;
        await repo.upsertInstalledApp(deviceId, androidUserId, event.packageName, {
          isSystem,
          timestampMs: eventTimestamp,
        });
      }

      // Notify work profile monitor that this user has accessibility service
      // (if we're receiving package events, the service is working for this user)
      if (androidUserId > 0) {
        this.context
          .getWorkProfileMonitor?.()
          ?.setProfileHasAccessibilityService(androidUserId, true);
      }
    } catch (error) {
      logger.warn(`[CTRL_PROXY] Failed to apply package event: ${error}`);
    }
  }

  async handleHandledExceptionEvent(event: AndroidHandledExceptionEvent): Promise<void> {
    logger.info(
      `[CTRL_PROXY] Received handled exception: ${event.exceptionClass} from ${event.packageName}`,
    );
    await this.context.getSdkEventIngestor().recordHandledException(event);
  }

  async persistCrash(event: SdkCrashPayload): Promise<void> {
    try {
      await this.context.crashEventSink.saveCrash(normalizeCrash(event, this.context.deviceId));
    } catch (error) {
      logger.error(`[CTRL_PROXY] Failed to persist crash: ${error}`);
    }
  }

  /**
   * Ingest a live frame-metrics event from the in-app SDK (issue #5076) into the
   * shared store. `PerformanceMonitor` prefers this real app-frame data over the
   * dumpsys scrape when it is fresh. The event's applicationId identifies the
   * app; fall back to the last-known foreground package if the SDK omitted it.
   */
  handleFrameMetricsEvent(data: AndroidFrameMetricsEvent): void {
    const packageName = data.applicationId ?? this.context.getLastForegroundPackage();
    if (!packageName) {
      return;
    }
    this.context.getFrameMetricsStore().ingest(this.context.deviceId, packageName, {
      fps: data.fps ?? null,
      frameTimeMs: data.frameTimeMs ?? null,
      jankFrames: data.jankFrames ?? null,
      receivedAt: this.context.timer.now(),
    });
  }

  async handleCrashEvent(event: SdkCrashPayload): Promise<void> {
    logger.info(
      `[CTRL_PROXY] Received crash: ${event.exceptionClass} on thread ${event.threadName} from ${event.packageName}`,
    );
    await Promise.all([
      this.persistCrash(event),
      this.context.getSdkEventIngestor().recordCrashAnalytics(event),
    ]);
  }

  async persistAnr(event: SdkAnrPayload): Promise<void> {
    try {
      await this.context.crashEventSink.saveAnr(normalizeAnr(event, this.context.deviceId));
    } catch (error) {
      logger.error(`[CTRL_PROXY] Failed to persist ANR: ${error}`);
    }
  }

  async handleAnrEvent(event: SdkAnrPayload): Promise<void> {
    logger.info(
      `[CTRL_PROXY] Received ANR: pid=${event.pid}, process=${event.processName}, importance=${event.importance}`,
    );
    const packageName = event.packageName ?? event.processName;
    await Promise.all([
      this.persistAnr(event),
      this.context.getSdkEventIngestor().recordAnrAnalytics(event, packageName),
    ]);
  }

  async markInstalledAppsStale(reason: string): Promise<void> {
    if (this.context.platform !== "android") {
      return;
    }

    try {
      // Fired fire-and-forget on WS close, which happens during shutdown socket
      // teardown — route through the barrier so it drains (or is skipped) before
      // closeDatabase() rather than racing the closing connection (issue #2792).
      await this.context
        .getInstalledAppsCacheWriteCoordinator()
        .invalidate(this.context.deviceId, () =>
          this.context
            .getDbWriteBarrier()
            .track(() =>
              this.context.getInstalledAppsStore().markDeviceStale(this.context.deviceId),
            )
            .then(() => undefined),
        );
      logger.info(`[CTRL_PROXY] Marked installed apps cache stale (${reason})`);
    } catch (error) {
      logger.warn(`[CTRL_PROXY] Failed to mark installed apps stale: ${error}`);
    }
  }
}

/** Parse the Android SDK stack-frame syntax, preserving legacy app-code attribution. */
export function parseStackTrace(stackTrace: string, packageName: string): StackTraceElement[] {
  const elements: StackTraceElement[] = [];
  const lines = stackTrace.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    const match = trimmed.match(/^at\s+([a-zA-Z0-9$_.]+)\.([a-zA-Z0-9$_<>]+)\(([^:)]+):?(\d+)?\)$/);
    if (match) {
      const [, fullClassName, methodName, fileName, lineNumberStr] = match;
      const lineNumber = lineNumberStr ? parseInt(lineNumberStr, 10) : null;

      const isAppCode =
        fullClassName.startsWith(packageName) ||
        fullClassName.includes(packageName.split(".").slice(0, 2).join("."));

      elements.push({
        className: fullClassName,
        methodName,
        fileName,
        lineNumber,
        isAppCode,
      });
    }
  }

  return elements;
}
