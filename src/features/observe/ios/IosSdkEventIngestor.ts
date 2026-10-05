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
import { buildNavigationNodeScreenshotUri } from "../../../utils/navigationResourceUri";
import type { ViewHierarchyResult } from "../../../models";
import type { SdkEvent, SdkEventIngestor } from "../interfaces/SdkEventIngestor";
import type { CtrlProxyScreenshotResult } from "./types";
import { decodeSdkNetworkVersion, IOS_SDK_NETWORK_DIAGNOSTIC_TAG } from "./IosSdkNetworkWire";

export const IOS_SDK_NETWORK_DIAGNOSTIC_WINDOW_MS = 10 * 60 * 1000;
const MAX_NETWORK_DIAGNOSTIC_KEYS = 64;
const MAX_RECEIVED_VERSION_LENGTH = 32;

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

/** Injected dependencies for {@link DefaultIosSdkEventIngestor}. */
export interface IosSdkEventIngestorDeps {
  /** The iOS device/simulator UDID that owns these events. */
  deviceId: string;
  timer?: Timer;
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
  /** Resolves the persisted node ID used to construct a screenshot resource URI. */
  findNavigationNodeId?: (
    applicationId: string,
    destination: string,
  ) => Promise<number | undefined>;
}

export class DefaultIosSdkEventIngestor implements IosSdkEventIngestor {
  private readonly deviceId: string;
  private readonly timer: Timer;
  private readonly networkDiagnostics = new Map<
    string,
    { emittedAt: number; suppressedCount: number }
  >();
  private readonly getNavigationGraphManager: () => NavigationEventSink;
  private readonly captureScreenshot: (timeoutMs: number) => Promise<CtrlProxyScreenshotResult>;
  private readonly telemetryRecorderOverride?: IosTelemetryRecorder;
  private readonly failureRecorderOverride?: FailureRecorderService;
  private readonly navigationScreenshotsEnabled: () => boolean;
  private readonly findNavigationNodeIdOverride?: (
    applicationId: string,
    destination: string,
  ) => Promise<number | undefined>;

  constructor(deps: IosSdkEventIngestorDeps) {
    this.deviceId = deps.deviceId;
    this.timer = deps.timer ?? defaultTimer;
    this.getNavigationGraphManager = deps.getNavigationGraphManager;
    this.captureScreenshot = deps.captureScreenshot;
    this.telemetryRecorderOverride = deps.telemetryRecorder;
    this.failureRecorderOverride = deps.failureRecorder;
    this.navigationScreenshotsEnabled =
      deps.navigationScreenshotsEnabled ?? (() => serverConfig.isNavigationScreenshotsEnabled());
    this.findNavigationNodeIdOverride = deps.findNavigationNodeId;
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

  private async navigationScreenshotUri(
    applicationId: string,
    destination: string,
  ): Promise<string | null> {
    let screenshotUri: string | null = null;
    try {
      const path = await this.captureNavigationScreenshot(applicationId, destination);
      if (!path) {
        return screenshotUri;
      }
      await this.getNavigationGraphManager().updateNodeScreenshot(applicationId, destination, path);
      try {
        const nodeId = await this.findNavigationNodeId(applicationId, destination);
        if (nodeId !== undefined) {
          // Scope by applicationId (in scope) so a cross-app client
          // resolves this node's screenshot under the named app, not
          // the daemon's current foreground app (#5851 / #5534).
          screenshotUri = buildNavigationNodeScreenshotUri(nodeId, applicationId);
        }
      } catch (error) {
        logger.warn(
          `[IosSdkEventIngestor] Navigation screenshot lookup failed: ${errorMessage(error)}`,
          error,
        );
      }
    } catch (error) {
      logger.warn(
        `[IosSdkEventIngestor] Navigation screenshot update failed: ${errorMessage(error)}`,
        error,
      );
    }
    return screenshotUri;
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
    let screenshotUri: string | null = null;
    if (applicationId && destination) {
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
      } as NavigationEvent);
      void getDbWriteBarrier().trackExisting(navWrite);
      await navWrite;

      if (this.navigationScreenshotsEnabled()) {
        screenshotUri = await this.navigationScreenshotUri(applicationId, destination);
      }
    }
    await recorder.recordNavigationEvent({
      timestamp: ts,
      applicationId,
      destination,
      source: navSource,
      arguments: navArgs,
      metadata: navMeta,
      screenshotUri,
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

  private async findNavigationNodeId(
    applicationId: string,
    destination: string,
  ): Promise<number | undefined> {
    if (this.findNavigationNodeIdOverride) {
      return this.findNavigationNodeIdOverride(applicationId, destination);
    }
    const { getDatabase } = await import("../../../db");
    const node = await getDatabase()
      .selectFrom("navigation_nodes")
      .select(["id"])
      .where("app_id", "=", applicationId)
      .where("screen_name", "=", destination)
      .executeTakeFirst();
    return node?.id;
  }

  /** Capture and store a screenshot for an iOS navigation event. Returns the stored path or null. */
  private async captureNavigationScreenshot(
    applicationId: string,
    destination: string,
  ): Promise<string | null> {
    try {
      const result = await this.captureScreenshot(3000);
      if (result?.data) {
        const screenshotManager = NavigationScreenshotManager.getInstance();
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
      const nodeCount = this.countViewHierarchyNodes(hierarchy.hierarchy);
      // Use the converted ViewHierarchyResult format — same data as the observation stream
      const hierarchyJson = JSON.stringify({
        nodeCount,
        packageName: hierarchy.packageName,
        hierarchy: hierarchy.hierarchy,
        windows: hierarchy.windows,
        updatedAt: hierarchy.updatedAt,
      });
      void recorder.recordLayoutEvent({
        timestamp: this.timer.now(),
        applicationId: hierarchy.packageName ?? null,
        subType: "hierarchy_change",
        composableName: null,
        composableId: null,
        recompositionCount: nodeCount,
        durationMs: null,
        likelyCause: null,
        detailsJson:
          hierarchyJson.length < 200000
            ? hierarchyJson
            : JSON.stringify({ nodeCount, truncated: true }),
        screenName: hierarchy.packageName ?? null,
      });
    } catch (error) {
      logger.warn(
        `[IosSdkEventIngestor] Layout telemetry recording failed: ${errorMessage(error)}`,
        error,
      );
    } finally {
      // Restore previous context so Android events aren't mis-attributed, even
      // when the body threw after setContext (getContext throwing leaves
      // prevContext undefined — nothing to restore). The restore runs in the
      // finally, OUTSIDE the catch above, so it must guard its own throw or the
      // exception would escape this best-effort method and break observation
      // (processMessage calls it).
      if (prevContext) {
        try {
          recorder.setContext(prevContext.deviceId, prevContext.sessionId);
        } catch (error) {
          logger.warn(`[IosSdkEventIngestor] Failed to restore telemetry context: ${error}`);
        }
      }
    }
  }

  private countViewHierarchyNodes(node: unknown): number {
    if (!node || typeof node !== "object") {
      return 0;
    }
    const obj = node as Record<string, unknown>;
    let count = 0;
    if (obj["$"] || obj["node"]) {
      count = 1;
    }
    const children = obj["node"];
    if (Array.isArray(children)) {
      for (const child of children) {
        count += this.countViewHierarchyNodes(child);
      }
    }
    return count;
  }
}
