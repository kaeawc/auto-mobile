/**
 * IosSdkEventIngestor - owns SDK-event ingestion for the iOS CtrlProxy client.
 *
 * Extracted from `IOSCtrlProxyClient` so the client is responsible only for
 * connection lifecycle + delegate wiring. This module fans decoded SDK events
 * (network/log/lifecycle/navigation/custom/handled_exception/crash/hang/storage)
 * out to `TelemetryRecorder` / `FailureRecorder`, and records layout telemetry
 * from converted view hierarchies.
 *
 * It implements the shared `SdkEventIngestor` interface (issue #2763); the
 * Android companion (issue #2764) implements the same interface for its own
 * ingestion.
 */

import { TelemetryRecorder } from "../../telemetry/TelemetryRecorder";
import { getFailureRecorder } from "../../failures/FailureRecorder";
import type { FailureRecorderService } from "../../failures/interfaces/FailureRecorderService";
import { defaultTimer, type Timer } from "../../../utils/SystemTimer";
import { logger } from "../../../utils/logger";
import { errorMessage } from "../../../utils/describeUnknownError";
import { serverConfig } from "../../../utils/ServerConfig";
import { NavigationScreenshotManager } from "../../navigation/NavigationScreenshotManager";
import { getDbWriteBarrier } from "../../../db/dbWriteBarrier";
import type { NavigationEvent } from "../../../utils/interfaces/NavigationGraph";
import type { ViewHierarchyNode, ViewHierarchyResult } from "../../../models";
import type { SdkEvent, SdkEventIngestor } from "../interfaces/SdkEventIngestor";
import type { CtrlProxyScreenshotResult } from "./types";
import { decodeSdkNetworkVersion, IOS_SDK_NETWORK_DIAGNOSTIC_TAG } from "./IosSdkNetworkWire";
import { buildIosLayoutTelemetryTree, hashIosLayoutTelemetryTree } from "./IosLayoutTelemetryTree";

import {
  getSdkFrameMetricsStore,
  type SdkFrameMetricsStore,
} from "../../performance/SdkFrameMetricsStore";

export const IOS_SDK_NETWORK_DIAGNOSTIC_WINDOW_MS = 10 * 60 * 1000;
const MAX_NETWORK_DIAGNOSTIC_KEYS = 64;
const MAX_RECEIVED_VERSION_LENGTH = 32;

interface LayoutCapture {
  key: string;
  updatedAt: number | undefined;
  sequence: number;
}

/**
 * The subset of `TelemetryRecorder` the ingestor depends on. Narrow so tests can
 * substitute a double; the production default is the real singleton.
 */
export type IosTelemetryRecorder = Pick<
  TelemetryRecorder,
  | "getContext"
  | "setContext"
  | "recordNetworkEvent"
  | "recordLogEvent"
  | "recordOsEvent"
  | "recordNavigationEvent"
  | "recordStorageEvent"
  | "recordLayoutEvent"
>;

/**
 * The navigation-graph operations the ingestor needs. Satisfied by
 * `NavigationGraphManager`; provided via a getter so session rebinds are picked
 * up on each event.
 */
export interface NavigationEventSink {
  recordNavigationEvent(event: NavigationEvent): Promise<void>;
  updateNodeScreenshot(
    appId: string,
    screenName: string,
    screenshotPath: string | null,
  ): Promise<void>;
}

/**
 * iOS-specific ingestor: the shared SDK-event routing plus iOS layout telemetry.
 */
export interface IosSdkEventIngestor extends SdkEventIngestor {
  /** Record a layout telemetry event from a converted iOS view hierarchy. */
  recordLayoutTelemetryEvent(hierarchy: ViewHierarchyResult): void;
}

/** The slice of `NavigationScreenshotManager` the ingestor stores screenshots through. */
export type NavigationScreenshotStore = Pick<NavigationScreenshotManager, "storeScreenshot">;

/** Injected dependencies for {@link DefaultIosSdkEventIngestor}. */
export interface IosSdkEventIngestorDeps {
  /** The iOS device/simulator UDID that owns these events. */
  deviceId: string;
  timer?: Timer;
  frameMetricsStore?: SdkFrameMetricsStore;
  /** Returns the navigation graph for the current session (session-bound). */
  getNavigationGraphManager: () => NavigationEventSink;
  /** Capture a screenshot for navigation-node association. */
  captureScreenshot: (timeoutMs: number) => Promise<CtrlProxyScreenshotResult>;
  /** Telemetry recorder; defaults to the shared singleton. */
  telemetryRecorder?: IosTelemetryRecorder;
  /** Failure recorder; defaults to the shared singleton. */
  failureRecorder?: FailureRecorderService;
  /** Whether navigation screenshots are enabled; defaults to server config. */
  navigationScreenshotsEnabled?: () => boolean;
  /** Stores captured navigation screenshots; defaults to the shared manager. */
  navigationScreenshotStore?: NavigationScreenshotStore;
}

export class DefaultIosSdkEventIngestor implements IosSdkEventIngestor {
  private readonly deviceId: string;
  private readonly timer: Timer;
  private readonly frameMetricsStore: SdkFrameMetricsStore;
  private readonly networkDiagnostics = new Map<
    string,
    { emittedAt: number; suppressedCount: number }
  >();
  private readonly getNavigationGraphManager: () => NavigationEventSink;
  private readonly captureScreenshot: (timeoutMs: number) => Promise<CtrlProxyScreenshotResult>;
  private readonly telemetryRecorderOverride?: IosTelemetryRecorder;
  private readonly failureRecorderOverride?: FailureRecorderService;
  private readonly navigationScreenshotsEnabled: () => boolean;
  private readonly navigationScreenshotStoreOverride?: NavigationScreenshotStore;
  private lastLayoutCapture?: LayoutCapture;
  private readonly pendingLayoutCaptures = new Map<number, LayoutCapture>();
  private layoutCaptureSequence = 0;

  constructor(deps: IosSdkEventIngestorDeps) {
    this.deviceId = deps.deviceId;
    this.timer = deps.timer ?? defaultTimer;
    this.frameMetricsStore = deps.frameMetricsStore ?? getSdkFrameMetricsStore();
    this.getNavigationGraphManager = deps.getNavigationGraphManager;
    this.captureScreenshot = deps.captureScreenshot;
    this.telemetryRecorderOverride = deps.telemetryRecorder;
    this.failureRecorderOverride = deps.failureRecorder;
    this.navigationScreenshotsEnabled =
      deps.navigationScreenshotsEnabled ?? (() => serverConfig.isNavigationScreenshotsEnabled());
    this.navigationScreenshotStoreOverride = deps.navigationScreenshotStore;
  }

  /**
   * Resolve the telemetry recorder fresh per call (matching the pre-extraction
   * behavior) so a runtime singleton swap is honored; tests inject an override.
   */
  private get telemetryRecorder(): IosTelemetryRecorder {
    return this.telemetryRecorderOverride ?? TelemetryRecorder.getInstance();
  }

  /** Resolve the failure recorder fresh per call; tests inject an override. */
  private get failureRecorder(): FailureRecorderService {
    return this.failureRecorderOverride ?? getFailureRecorder();
  }

  async recordSdkEvent(event: SdkEvent, applicationId: string | null): Promise<void> {
    try {
      if (event.type === "frame_metrics_event") {
        this.ingestFrameMetrics(event.payload, applicationId);
        return;
      }
      const recorder = this.telemetryRecorder;
      // Save and restore context to avoid race with Android device context
      const prevContext = recorder.getContext();
      recorder.setContext(this.deviceId, null);
      const ts = event.timestamp;
      const p = event.payload;

      try {
        // Reach the recorder's context snapshot without yielding on accepted versions.
        const version =
          event.type === "network_request" ? this.acceptNetworkVersion(event, applicationId) : null;
        if (version?.accepted === false && version.diagnosticLog) {
          await recorder.recordLogEvent(version.diagnosticLog);
        }
        if (version?.accepted === false) {
          return;
        }
        await this.recordAcceptedSdkEvent(event, recorder, ts, p, applicationId);
      } finally {
        // Restore previous context so Android events aren't affected
        recorder.setContext(prevContext.deviceId, prevContext.sessionId);
      }
    } catch (error) {
      logger.warn("[IosSdkEventIngestor] Failed to record SDK event", error);
    }
  }

  private ingestFrameMetrics(p: Record<string, unknown>, applicationId: string | null): void {
    const { fps, frameTimeMs, jankFrames } = p;
    if (
      !applicationId ||
      typeof fps !== "number" ||
      !Number.isFinite(fps) ||
      fps < 0 ||
      typeof frameTimeMs !== "number" ||
      !Number.isFinite(frameTimeMs) ||
      frameTimeMs <= 0 ||
      typeof jankFrames !== "number" ||
      !Number.isSafeInteger(jankFrames) ||
      jankFrames < 0
    ) {
      return;
    }
    this.frameMetricsStore.ingest(this.deviceId, applicationId, {
      fps,
      frameTimeMs,
      jankFrames,
      receivedAt: this.timer.now(),
    });
  }

  private recordAcceptedSdkEvent(
    event: SdkEvent,
    recorder: IosTelemetryRecorder,
    ts: number,
    p: Record<string, unknown>,
    applicationId: string | null,
  ): Promise<unknown> {
    switch (event.type) {
      case "network_request":
        return this.recordNetworkSdkEvent(recorder, ts, p, applicationId);
      case "log":
        return this.recordLogSdkEvent(recorder, ts, p, applicationId);
      case "lifecycle":
        return this.recordLifecycleSdkEvent(recorder, ts, p, applicationId);
      case "navigation":
        return this.recordNavigationSdkEvent(recorder, ts, p, applicationId);
      case "custom":
        return this.recordCustomSdkEvent(recorder, ts, p, applicationId);
      case "handled_exception":
        return this.recordHandledExceptionSdkEvent(recorder, ts, p, applicationId);
      case "crash":
        return this.recordCrashSdkEvent(recorder, ts, p, applicationId);
      case "hang":
        return this.recordHangSdkEvent(recorder, ts, p, applicationId);
      case "webview":
        return this.recordWebViewSdkEvent(recorder, ts, p, applicationId);
      case "storage_changed":
        return this.recordStorageSdkEvent(recorder, ts, p, applicationId);
      default:
        return this.recordUnknownSdkEvent(recorder, ts, p, applicationId, event);
    }
  }

  private recordNetworkSdkEvent(
    recorder: IosTelemetryRecorder,
    ts: number,
    p: Record<string, unknown>,
    applicationId: string | null,
  ): Promise<void> {
    // URLSession's adapter emits task metrics in metadata.duration_ms.
    // Keep the existing top-level duration when present.
    const metricDuration = Number((p.metadata as Record<string, string> | undefined)?.duration_ms);
    return recorder.recordNetworkEvent({
      timestamp: ts,
      applicationId,
      url: (p.url as string) ?? "",
      method: (p.method as string) ?? "GET",
      statusCode: (p.statusCode as number) ?? 0,
      durationMs:
        (p.durationMs as number | undefined) ??
        (Number.isFinite(metricDuration) ? metricDuration : 0),
      requestBodySize: (p.requestBodySize as number) ?? -1,
      responseBodySize: (p.responseBodySize as number) ?? -1,
      ...this.networkConnectionFields(p),
      ...this.networkBodyFields(p),
    });
  }

  private networkConnectionFields(p: Record<string, unknown>) {
    return {
      protocol: (p.protocolName as string) ?? (p.protocol as string) ?? null,
      requestId: (p.requestId as string) ?? null,
      connectionId: (p.connectionId as string) ?? null,
      direction: (p.direction as string) ?? null,
      metadata: (p.metadata as Record<string, string>) ?? null,
      sequenceNumber: (p.sequenceNumber as number) ?? null,
      host: (p.host as string) ?? null,
      path: (p.path as string) ?? null,
      error: (p.error as string) ?? null,
    };
  }

  private networkBodyFields(p: Record<string, unknown>) {
    return {
      requestHeaders: (p.requestHeaders as Record<string, string>) ?? null,
      responseHeaders: (p.responseHeaders as Record<string, string>) ?? null,
      requestBody: (p.requestBody as string) ?? null,
      responseBody: (p.responseBody as string) ?? null,
      contentType: (p.contentType as string) ?? null,
    };
  }

  private recordLogSdkEvent(
    recorder: IosTelemetryRecorder,
    ts: number,
    p: Record<string, unknown>,
    applicationId: string | null,
  ): Promise<void> {
    return recorder.recordLogEvent({
      timestamp: ts,
      applicationId,
      level: (p.level as number) ?? 0,
      tag: (p.tag as string) ?? "",
      message: (p.message as string) ?? "",
      filterName: (p.filterName as string) ?? "",
    });
  }

  private recordLifecycleSdkEvent(
    recorder: IosTelemetryRecorder,
    ts: number,
    p: Record<string, unknown>,
    applicationId: string | null,
  ): Promise<void> {
    return recorder.recordOsEvent({
      timestamp: ts,
      applicationId,
      category: "lifecycle",
      kind: (p.state as string) ?? "unknown",
      details: { state: (p.state as string) ?? "", bundleId: (p.bundleId as string) ?? "" },
    });
  }

  private async storeNavigationScreenshot(
    applicationId: string,
    destination: string,
  ): Promise<void> {
    try {
      const path = await this.captureNavigationScreenshot(applicationId, destination);
      if (!path) {
        return;
      }
      await this.getNavigationGraphManager().updateNodeScreenshot(applicationId, destination, path);
    } catch (error) {
      logger.warn(
        `[IosSdkEventIngestor] Navigation screenshot update failed: ${errorMessage(error)}`,
        error,
      );
    }
  }

  private async recordNavigationSdkEvent(
    recorder: IosTelemetryRecorder,
    ts: number,
    p: Record<string, unknown>,
    applicationId: string | null,
  ): Promise<void> {
    const destination = (p.destination as string) ?? "unknown";
    const navSource = (p.source as string) ?? null;
    const navArgs = (p.arguments as Record<string, string>) ?? null;
    const navMeta = (p.metadata as Record<string, string>) ?? null;
    if (applicationId && destination) {
      // The graph manager owns this event's telemetry record, as it does on Android, so it is
      // recorded once and stamped with this device (#10195). The graph write keeps host time:
      // the SDK timestamp is not in the clock the hierarchy detector correlates against. The
      // telemetry record alone carries the SDK time, as every other iOS event does, so this
      // device's timeline sorts consistently.
      // Barrier-tracked via trackExisting so graceful shutdown drains this
      // fire-and-forget write without a track() await hop perturbing the
      // nav-event↔hierarchy-update ordering (issue #2885); a mid-flight
      // shutdown race is dropped cleanly by Part 1 (issue #2792).
      const navWrite = this.getNavigationGraphManager().recordNavigationEvent({
        applicationId,
        destination,
        source: navSource,
        arguments: navArgs ?? {},
        metadata: navMeta ?? {},
        triggeringInteraction: null,
        deviceId: this.deviceId,
        telemetryTimestamp: ts,
      } as NavigationEvent);
      void getDbWriteBarrier().trackExisting(navWrite);
      await navWrite;

      if (this.navigationScreenshotsEnabled()) {
        await this.storeNavigationScreenshot(applicationId, destination);
      }
      return;
    }
    // No graph write, so no manager record: this is the only record of the event.
    await recorder.recordNavigationEvent({
      timestamp: ts,
      applicationId,
      destination,
      source: navSource,
      arguments: navArgs,
      metadata: navMeta,
      screenshotUri: null,
    });
  }

  private recordCustomSdkEvent(
    recorder: IosTelemetryRecorder,
    ts: number,
    p: Record<string, unknown>,
    applicationId: string | null,
  ): Promise<void> {
    // Custom events are merged into log events
    const customName = (p.name as string) ?? "custom";
    const customProps = (p.properties as Record<string, string>) ?? {};
    const propsStr = Object.keys(customProps).length > 0 ? ` ${JSON.stringify(customProps)}` : "";
    return recorder.recordLogEvent({
      timestamp: ts,
      applicationId,
      level: 4,
      tag: "CustomEvent",
      message: `${customName}${propsStr}`,
      filterName: "custom",
    });
  }

  private recordHandledExceptionSdkEvent(
    recorder: IosTelemetryRecorder,
    ts: number,
    p: Record<string, unknown>,
    applicationId: string | null,
  ): ReturnType<FailureRecorderService["recordNonFatal"]> {
    const failureRecorder = this.failureRecorder;
    const exType = (p.exceptionClass as string) ?? (p.errorDomain as string) ?? "unknown";
    const exMsg = (p.exceptionMessage as string) ?? (p.message as string) ?? "Handled exception";
    const stackStr = (p.stackTrace as string) ?? "";
    const stackFrames = stackStr
      .split("\n")
      .filter(Boolean)
      .map((line) => ({
        className: "",
        methodName: line.trim(),
        fileName: null as string | null,
        lineNumber: null as number | null,
        isAppCode: line.includes(applicationId ?? ""),
      }));
    return failureRecorder.recordNonFatal({
      exceptionType: exType,
      exceptionMessage: exMsg,
      stackTrace: stackFrames,
      customMessage: (p.customMessage as string) ?? undefined,
      deviceId: this.deviceId,
      deviceModel: "iOS Simulator",
      os: "iOS",
      appVersion: "1.0",
      sessionId: `ios-${this.deviceId}-${ts}`,
      currentScreen: (p.currentScreen as string) ?? (p.screen as string) ?? undefined,
    });
  }

  private recordCrashSdkEvent(
    recorder: IosTelemetryRecorder,
    ts: number,
    p: Record<string, unknown>,
    applicationId: string | null,
  ): ReturnType<FailureRecorderService["recordCrash"]> {
    const crashRecorder = this.failureRecorder;
    const crashType = (p.exceptionClass as string) ?? (p.errorDomain as string) ?? "unknown";
    const crashMsg = (p.exceptionMessage as string) ?? (p.message as string) ?? "Crash";
    const crashStack = ((p.stackTrace as string) ?? "")
      .split("\n")
      .filter(Boolean)
      .map((line) => ({
        className: "",
        methodName: line.trim(),
        fileName: null as string | null,
        lineNumber: null as number | null,
        isAppCode: line.includes(applicationId ?? ""),
      }));
    return crashRecorder.recordCrash({
      exceptionType: crashType,
      exceptionMessage: crashMsg,
      stackTrace: crashStack,
      deviceId: this.deviceId,
      deviceModel: "iOS Simulator",
      os: "iOS",
      appVersion: "1.0",
      sessionId: `ios-${this.deviceId}-${ts}`,
      currentScreen: (p.currentScreen as string) ?? (p.screen as string) ?? undefined,
    });
  }

  private recordHangSdkEvent(
    recorder: IosTelemetryRecorder,
    ts: number,
    p: Record<string, unknown>,
    applicationId: string | null,
  ): Promise<void> {
    return recorder.recordOsEvent({
      timestamp: ts,
      applicationId,
      category: "hang",
      kind: `${(p.durationMs as number) ?? 0}ms`,
      details: { durationMs: String((p.durationMs as number) ?? 0) },
    });
  }

  private recordWebViewSdkEvent(
    recorder: IosTelemetryRecorder,
    ts: number,
    p: Record<string, unknown>,
    applicationId: string | null,
  ): Promise<void> {
    return recorder.recordOsEvent({
      timestamp: ts,
      applicationId,
      category: "webview",
      kind: (p.name as string) ?? "unknown",
      details: {
        webViewId: (p.webViewId as string) ?? "",
        url: (p.url as string) ?? "",
        frameId: (p.frameId as string) ?? "",
        requestId: (p.requestId as string) ?? "",
        ...((p.metadata as Record<string, string>) ?? {}),
      },
    });
  }

  private recordStorageSdkEvent(
    recorder: IosTelemetryRecorder,
    ts: number,
    p: Record<string, unknown>,
    applicationId: string | null,
  ): Promise<void> {
    // The iOS SDK's SdkStorageChangedEvent serializes as suiteName/key/newValue/
    // valueType/changeType/sequenceNumber (ios/auto-mobile-sdk/.../SdkEvent.swift).
    // It carries no `value` and no `operation`; the recorder REQUIRES valueType +
    // changeType (issue #3001). Map: suiteName→fileName, newValue→value, pass
    // valueType through, and use the SDK-diffed changeType (add/modify/remove).
    // Older SDK builds emitted no change kind — fall back to `operation` then
    // "modify" for wire compatibility.
    const changeType = (p.changeType as string) ?? (p.operation as string) ?? "modify";
    // Resolve the prior value:
    //  - "add" ⇒ the key had no prior value by definition. Assert null
    //    EXPLICITLY: Swift's synthesized Encodable omits nil optionals, so the
    //    SDK's `previousValue: nil` for adds never reaches the wire, and without
    //    this the repository's auto-lookup could attribute a stale earlier row
    //    (e.g. a key removed while offline then re-added) as the previous value.
    //  - otherwise ⇒ thread the runner-supplied prior value when present, else
    //    omit so the repository's `previousValue !== undefined` guard falls
    //    through to the auto-lookup (#3000). An explicit null is honored verbatim.
    const previousValue: string | null | undefined =
      changeType === "add"
        ? null
        : "previousValue" in p
          ? (p.previousValue as string | null)
          : undefined;
    return recorder.recordStorageEvent({
      timestamp: ts,
      applicationId,
      fileName: (p.suiteName as string) ?? "",
      key: (p.key as string) ?? null,
      value: (p.newValue as string) ?? (p.value as string) ?? null,
      valueType: (p.valueType as string) ?? null,
      changeType,
      ...(previousValue !== undefined ? { previousValue } : {}),
    });
  }

  private recordUnknownSdkEvent(
    recorder: IosTelemetryRecorder,
    ts: number,
    p: Record<string, unknown>,
    applicationId: string | null,
    event: SdkEvent,
  ): Promise<void> {
    // Record unknown types as log events
    return recorder.recordLogEvent({
      timestamp: ts,
      applicationId,
      level: 4,
      tag: "UnknownEvent",
      message: `${event.type}: ${JSON.stringify(p).substring(0, 1000)}`,
      filterName: "custom",
    });
  }

  private acceptNetworkVersion(
    event: SdkEvent,
    applicationId: string | null,
  ):
    | { accepted: true }
    | {
        accepted: false;
        diagnosticLog?: Parameters<IosTelemetryRecorder["recordLogEvent"]>[0];
      } {
    const version = decodeSdkNetworkVersion(event.payload, applicationId);
    if (version.success) {
      return { accepted: true };
    }
    const diagnostic = version.diagnostic;
    diagnostic.receivedVersion = this.boundedReceivedVersion(diagnostic.receivedVersion);
    let key = JSON.stringify([this.deviceId, applicationId, diagnostic.receivedVersion]);
    // Reserve the final slot for all new keys once full; no eviction-based flood bypass.
    if (
      !this.networkDiagnostics.has(key) &&
      this.networkDiagnostics.size >= MAX_NETWORK_DIAGNOSTIC_KEYS - 1
    ) {
      key = "overflow";
    }
    const now = this.timer.now();
    const previous = this.networkDiagnostics.get(key);
    if (previous && now - previous.emittedAt < IOS_SDK_NETWORK_DIAGNOSTIC_WINDOW_MS) {
      previous.suppressedCount += 1;
      return { accepted: false };
    }
    if (previous) {
      diagnostic.suppressedCount = previous.suppressedCount;
    }
    this.networkDiagnostics.set(key, { emittedAt: now, suppressedCount: 0 });
    logger.warn("[IosSdkEventIngestor] Unsupported network schema", diagnostic);
    return {
      accepted: false,
      diagnosticLog: {
        timestamp: event.timestamp,
        applicationId,
        level: 5,
        tag: IOS_SDK_NETWORK_DIAGNOSTIC_TAG,
        message: JSON.stringify(diagnostic),
        filterName: "sdk_network_schema_unsupported",
      },
    };
  }

  private boundedReceivedVersion(received: unknown): unknown {
    // Keep scalar diagnostics intact; never serialize an untrusted object into a log/key.
    if (typeof received !== "string" && (typeof received !== "object" || received === null)) {
      return received;
    }
    const text =
      typeof received === "string" ? received : Array.isArray(received) ? "[array]" : "[object]";
    return text.length > MAX_RECEIVED_VERSION_LENGTH
      ? `${text.slice(0, MAX_RECEIVED_VERSION_LENGTH - 1)}…`
      : text;
  }

  /** Capture and store a screenshot for an iOS navigation event. Returns the stored path or null. */
  private async captureNavigationScreenshot(
    applicationId: string,
    destination: string,
  ): Promise<string | null> {
    try {
      const result = await this.captureScreenshot(3000);
      if (result?.data) {
        const screenshotManager =
          this.navigationScreenshotStoreOverride ?? NavigationScreenshotManager.getInstance();
        const bytes = Buffer.from(result.data, "base64");
        return await screenshotManager.storeScreenshot(
          applicationId,
          destination,
          bytes,
          result.format ?? "png",
        );
      }
    } catch (error) {
      logger.debug(`[IosSdkEventIngestor] iOS nav screenshot capture skipped: ${error}`);
    }
    return null;
  }

  /** Record a layout telemetry event from converted iOS hierarchy (ViewHierarchyResult format) */
  recordLayoutTelemetryEvent(hierarchy: ViewHierarchyResult): void {
    const recorder = this.telemetryRecorder;
    // Capture the prior context before the try so it is available in the finally
    // even if setContext/recordLayoutEvent throws. Without the finally, a recorder
    // that threw mid-record would leave the shared context pinned to the iOS udid,
    // permanently mis-attributing subsequent Android telemetry.
    let prevContext: { deviceId: string | null; sessionId: string | null } | undefined;
    try {
      prevContext = recorder.getContext();
      recorder.setContext(this.deviceId, null);
      const previous = this.latestLayoutCapture();
      // Deduplicate consecutive captures per device/ingestor, never a global set:
      // hash the full display tree + node/package/window counts, not updatedAt
      // (which changes on every poll). An equal defined timestamp is also a replay.
      if (hierarchy.updatedAt !== undefined && hierarchy.updatedAt === previous?.updatedAt) {
        return;
      }
      const windowCount = hierarchy.windows?.length ?? 0;
      const nodeCount = this.countViewHierarchyNodes(hierarchy.hierarchy.node);
      const key = hashIosLayoutTelemetryTree(
        hierarchy.hierarchy.node,
        hierarchy.packageName,
        windowCount,
        nodeCount,
      );
      if (key === previous?.key) {
        return;
      }
      const compact = buildIosLayoutTelemetryTree(hierarchy.hierarchy.node);
      const screenName = hierarchy.packageName ?? null;
      const hierarchyJson = JSON.stringify({
        screenName,
        windowCount,
        foregroundActivity: null,
        nodeCount,
        packageName: hierarchy.packageName,
        hierarchy: { node: compact.node },
        updatedAt: hierarchy.updatedAt,
        // undefined is omitted by JSON.stringify; a spread here trips the wire-parity emit scan.
        truncated: compact.truncated ? true : undefined,
      });
      const recording = recorder.recordLayoutEvent({
        timestamp: this.timer.now(),
        applicationId: screenName,
        subType: "hierarchy_change",
        composableName: null,
        composableId: null,
        recompositionCount: nodeCount,
        durationMs: null,
        likelyCause: null,
        detailsJson: hierarchyJson,
        screenName,
      });
      const capture = {
        key,
        updatedAt: hierarchy.updatedAt,
        sequence: ++this.layoutCaptureSequence,
      };
      this.trackLayoutRecording(recording, capture);
    } catch (error) {
      logger.warn(
        `[IosSdkEventIngestor] Layout telemetry recording failed: ${errorMessage(error)}`,
        error,
      );
    } finally {
      this.restoreLayoutTelemetryContext(recorder, prevContext);
    }
  }

  private restoreLayoutTelemetryContext(
    recorder: IosTelemetryRecorder,
    previous: ReturnType<IosTelemetryRecorder["getContext"]> | undefined,
  ): void {
    // Restore even when recording threw, so Android events aren't mis-attributed.
    // getContext throwing leaves nothing to restore. A restore failure must also
    // stay non-fatal because this runs outside the recording catch, in finally.
    if (previous) {
      try {
        recorder.setContext(previous.deviceId, previous.sessionId);
      } catch (error) {
        logger.warn(
          `[IosSdkEventIngestor] Failed to restore telemetry context: ${errorMessage(error)}`,
          error,
        );
      }
    }
  }

  private trackLayoutRecording(recording: Promise<boolean>, capture: LayoutCapture): void {
    // Pending writes suppress immediate duplicate calls. Only confirmed writes
    // become committed state; failures and unconfirmed writes are retryable. The
    // receipt is never awaited inline: in buffered mode it settles on the next
    // TelemetryEventBuffer flush (#14625), and awaiting it would stall this poll.
    this.pendingLayoutCaptures.set(capture.sequence, capture);
    void recording.then(
      (persisted) => {
        this.pendingLayoutCaptures.delete(capture.sequence);
        if (
          persisted &&
          (!this.lastLayoutCapture || capture.sequence > this.lastLayoutCapture.sequence)
        ) {
          this.lastLayoutCapture = capture;
        }
      },
      (error: unknown) => {
        this.pendingLayoutCaptures.delete(capture.sequence);
        logger.warn(
          `[IosSdkEventIngestor] Layout telemetry recording failed: ${errorMessage(error)}`,
          error,
        );
      },
    );
  }

  private latestLayoutCapture(): LayoutCapture | undefined {
    const pending = Array.from(this.pendingLayoutCaptures.values()).at(-1);
    return pending && pending.sequence > (this.lastLayoutCapture?.sequence ?? 0)
      ? pending
      : this.lastLayoutCapture;
  }

  /** Counts converted nodes; the converter emits a lone child as an object, not a one-item array. */
  private countViewHierarchyNodes(node: ViewHierarchyNode | undefined): number {
    if (!node) {
      return 0;
    }
    const own = node.$ || node.node ? 1 : 0;
    return [node.node ?? []]
      .flat()
      .reduce((count, child) => count + this.countViewHierarchyNodes(child), own);
  }
}
