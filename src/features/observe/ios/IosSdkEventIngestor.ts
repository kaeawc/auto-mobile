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
import { logger } from "../../../utils/logger";
import { serverConfig } from "../../../utils/ServerConfig";
import { NavigationScreenshotManager } from "../../navigation/NavigationScreenshotManager";
import { getDbWriteBarrier } from "../../../db/dbWriteBarrier";
import type { NavigationEvent } from "../../../utils/interfaces/NavigationGraph";
import type { ViewHierarchyResult } from "../../../models";
import type { SdkEvent, SdkEventIngestor } from "../interfaces/SdkEventIngestor";
import type { CtrlProxyScreenshotResult } from "./types";

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
}

export class DefaultIosSdkEventIngestor implements IosSdkEventIngestor {
  private readonly deviceId: string;
  private readonly getNavigationGraphManager: () => NavigationEventSink;
  private readonly captureScreenshot: (timeoutMs: number) => Promise<CtrlProxyScreenshotResult>;
  private readonly telemetryRecorderOverride?: IosTelemetryRecorder;
  private readonly failureRecorderOverride?: FailureRecorderService;
  private readonly navigationScreenshotsEnabled: () => boolean;

  constructor(deps: IosSdkEventIngestorDeps) {
    this.deviceId = deps.deviceId;
    this.getNavigationGraphManager = deps.getNavigationGraphManager;
    this.captureScreenshot = deps.captureScreenshot;
    this.telemetryRecorderOverride = deps.telemetryRecorder;
    this.failureRecorderOverride = deps.failureRecorder;
    this.navigationScreenshotsEnabled =
      deps.navigationScreenshotsEnabled ?? (() => serverConfig.isNavigationScreenshotsEnabled());
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
        switch (event.type) {
          case "network_request":
            await recorder.recordNetworkEvent({
              timestamp: ts,
              applicationId,
              url: (p.url as string) ?? "",
              method: (p.method as string) ?? "GET",
              statusCode: (p.statusCode as number) ?? 0,
              durationMs: (p.durationMs as number) ?? 0,
              requestBodySize: (p.requestBodySize as number) ?? -1,
              responseBodySize: (p.responseBodySize as number) ?? -1,
              protocol: (p.protocol as string) ?? null,
              host: (p.host as string) ?? null,
              path: (p.path as string) ?? null,
              error: (p.error as string) ?? null,
              requestHeaders: (p.requestHeaders as Record<string, string>) ?? null,
              responseHeaders: (p.responseHeaders as Record<string, string>) ?? null,
              requestBody: (p.requestBody as string) ?? null,
              responseBody: (p.responseBody as string) ?? null,
              contentType: (p.contentType as string) ?? null,
            });
            break;
          case "log":
            await recorder.recordLogEvent({
              timestamp: ts,
              applicationId,
              level: (p.level as number) ?? 0,
              tag: (p.tag as string) ?? "",
              message: (p.message as string) ?? "",
              filterName: (p.filterName as string) ?? "",
            });
            break;
          case "lifecycle":
            await recorder.recordOsEvent({
              timestamp: ts,
              applicationId,
              category: "lifecycle",
              kind: (p.state as string) ?? "unknown",
              details: { state: (p.state as string) ?? "", bundleId: (p.bundleId as string) ?? "" },
            });
            break;
          case "navigation": {
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
                try {
                  const path = await this.captureNavigationScreenshot(applicationId, destination);
                  if (path) {
                    await this.getNavigationGraphManager().updateNodeScreenshot(
                      applicationId,
                      destination,
                      path,
                    );
                    try {
                      const { getDatabase } = await import("../../../db");
                      const db = getDatabase();
                      const node = await db
                        .selectFrom("navigation_nodes")
                        .select(["id"])
                        .where("app_id", "=", applicationId)
                        .where("screen_name", "=", destination)
                        .executeTakeFirst();
                      if (node) {
                        screenshotUri = `automobile:navigation/nodes/${node.id}/screenshot`;
                      }
                    } catch {
                      /* non-fatal */
                    }
                  }
                } catch {
                  /* non-fatal */
                }
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
            break;
          }
          case "custom": {
            // Custom events are merged into log events
            const customName = (p.name as string) ?? "custom";
            const customProps = (p.properties as Record<string, string>) ?? {};
            const propsStr =
              Object.keys(customProps).length > 0 ? ` ${JSON.stringify(customProps)}` : "";
            await recorder.recordLogEvent({
              timestamp: ts,
              applicationId,
              level: 4,
              tag: "CustomEvent",
              message: `${customName}${propsStr}`,
              filterName: "custom",
            });
            break;
          }
          case "handled_exception": {
            const failureRecorder = this.failureRecorder;
            const exType = (p.exceptionClass as string) ?? (p.errorDomain as string) ?? "unknown";
            const exMsg =
              (p.exceptionMessage as string) ?? (p.message as string) ?? "Handled exception";
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
            await failureRecorder.recordNonFatal({
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
            break;
          }
          case "crash": {
            const crashRecorder = this.failureRecorder;
            const crashType =
              (p.exceptionClass as string) ?? (p.errorDomain as string) ?? "unknown";
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
            await crashRecorder.recordCrash({
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
            break;
          }
          case "hang":
            await recorder.recordOsEvent({
              timestamp: ts,
              applicationId,
              category: "hang",
              kind: `${(p.durationMs as number) ?? 0}ms`,
              details: { durationMs: String((p.durationMs as number) ?? 0) },
            });
            break;
          case "webview":
            await recorder.recordOsEvent({
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
            break;
          case "storage_changed": {
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
            await recorder.recordStorageEvent({
              timestamp: ts,
              applicationId,
              fileName: (p.suiteName as string) ?? "",
              key: (p.key as string) ?? null,
              value: (p.newValue as string) ?? (p.value as string) ?? null,
              valueType: (p.valueType as string) ?? null,
              changeType,
              ...(previousValue !== undefined ? { previousValue } : {}),
            });
            break;
          }
          default:
            // Record unknown types as log events
            await recorder.recordLogEvent({
              timestamp: ts,
              applicationId,
              level: 4,
              tag: "UnknownEvent",
              message: `${event.type}: ${JSON.stringify(p).substring(0, 1000)}`,
              filterName: "custom",
            });
        }
      } finally {
        // Restore previous context so Android events aren't affected
        recorder.setContext(prevContext.deviceId, prevContext.sessionId);
      }
    } catch {
      // Non-fatal
    }
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
        timestamp: Date.now(),
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
    } catch {
      // Non-fatal — telemetry recording should never break observation
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
