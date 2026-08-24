/**
 * AndroidSdkEventIngestor - owns SDK-event ingestion for the Android CtrlProxy
 * client.
 *
 * Extracted from `AndroidCtrlProxyClient` (issue #2764) so the client is
 * responsible only for connection lifecycle + request routing. This module fans
 * decoded SDK telemetry events (network / websocket_frame / log / broadcast /
 * lifecycle / custom / storage_changed) out to `TelemetryRecorder`, and records
 * crash / ANR / handled-exception analytics through `FailureRecorder`.
 *
 * It implements the shared `SdkEventIngestor` interface (issue #2763); the iOS
 * companion (`IosSdkEventIngestor`) implements the same contract for its own
 * transport. Android delivers already-typed event objects on its WebSocket, so
 * it specializes the generic payload to {@link AndroidSdkEventPayload}.
 *
 * All ingestion is best-effort: the shared `recordSdkEvent` never throws, and the
 * crash/ANR/handled analytics helpers log-and-continue on failure — telemetry
 * must never break observation.
 */

import { TelemetryRecorder } from "../../telemetry/TelemetryRecorder";
import { getFailureRecorder } from "../../failures/FailureRecorder";
import type { FailureRecorderService } from "../../failures/interfaces/FailureRecorderService";
import { logger } from "../../../utils/logger";
import type { StackTraceElement } from "../../../server/failuresResources";
import type { SdkAnrPayload, SdkCrashPayload } from "../crash/sdkCrashIngestion";
import type { SdkEvent, SdkEventIngestor } from "../interfaces/SdkEventIngestor";
import type { StorageTelemetryInput } from "./AndroidCtrlProxyClient";

/**
 * The subset of `TelemetryRecorder` the ingestor depends on. Narrow so tests can
 * substitute a double; the production default is the shared singleton.
 */
export type AndroidTelemetryRecorder = Pick<
  TelemetryRecorder,
  "setContext" | "recordNetworkEvent" | "recordLogEvent" | "recordOsEvent" | "recordStorageEvent"
>;

/**
 * A handled-exception SDK event as delivered on the Android WebSocket. Mirrors
 * the client-side `HandledExceptionEvent` shape without importing it (the type is
 * not exported).
 */
export interface AndroidHandledExceptionEvent {
  timestamp: number;
  exceptionClass: string;
  exceptionMessage?: string;
  stackTrace: string;
  customMessage?: string;
  currentScreen?: string;
  packageName: string;
  appVersion?: string;
  deviceInfo: {
    model: string;
    manufacturer: string;
    osVersion: string;
    sdkInt: number;
  };
}

/**
 * The navigation-graph operations the ingestor needs for screen attribution.
 * Provided via a getter so session rebinds are honored on each event.
 */
export interface NavigationScreenSource {
  getCurrentScreen(): string | null;
}

/**
 * Payload for an Android SDK telemetry event. The client narrows `type` to the
 * WebSocket message type and passes the already-typed `event` object plus the
 * owning device id through as the payload.
 */
export interface AndroidSdkEventPayload {
  /** The typed SDK event object from the WebSocket message. */
  event: Record<string, unknown>;
}

/**
 * Android-specific ingestor: the shared SDK-event routing plus crash / ANR /
 * handled-exception analytics that have no cross-platform analogue.
 */
export interface AndroidSdkEventIngestor extends SdkEventIngestor<AndroidSdkEventPayload> {
  /**
   * Record a `storage_changed` telemetry event from an input the client already
   * built from the wire message. Best-effort; never throws.
   */
  recordStorageEvent(input: StorageTelemetryInput): void;
  /** Record a handled (non-fatal) exception through the failure recorder. */
  recordHandledException(event: AndroidHandledExceptionEvent): Promise<void>;
  /** Record a crash through the failure recorder analytics timeline. */
  recordCrashAnalytics(event: SdkCrashPayload): Promise<void>;
  /** Record an ANR through the failure recorder analytics timeline. */
  recordAnrAnalytics(event: SdkAnrPayload, packageName: string): Promise<void>;
}

/** Injected dependencies for {@link DefaultAndroidSdkEventIngestor}. */
export interface AndroidSdkEventIngestorDeps {
  /** The Android device serial that owns these events. */
  deviceId: string;
  /** Returns the navigation graph for the current session (session-bound). */
  getNavigationScreenSource: () => NavigationScreenSource;
  /** Parse a raw stack trace string into structured frames. */
  parseStackTrace: (stackTrace: string, packageName: string) => StackTraceElement[];
  /** Monotonic clock; used to stamp failure session ids. */
  now: () => number;
  /** Telemetry recorder; defaults to the shared singleton. */
  telemetryRecorder?: AndroidTelemetryRecorder;
  /** Failure recorder; defaults to the shared singleton. */
  failureRecorder?: FailureRecorderService;
}

export class DefaultAndroidSdkEventIngestor implements AndroidSdkEventIngestor {
  private readonly deviceId: string;
  private readonly getNavigationScreenSource: () => NavigationScreenSource;
  private readonly parseStackTrace: (
    stackTrace: string,
    packageName: string,
  ) => StackTraceElement[];
  private readonly now: () => number;
  private readonly telemetryRecorderOverride?: AndroidTelemetryRecorder;
  private readonly failureRecorderOverride?: FailureRecorderService;

  constructor(deps: AndroidSdkEventIngestorDeps) {
    this.deviceId = deps.deviceId;
    this.getNavigationScreenSource = deps.getNavigationScreenSource;
    this.parseStackTrace = deps.parseStackTrace;
    this.now = deps.now;
    this.telemetryRecorderOverride = deps.telemetryRecorder;
    this.failureRecorderOverride = deps.failureRecorder;
  }

  /**
   * Resolve the telemetry recorder fresh per call (matching the pre-extraction
   * behavior) so a runtime singleton swap is honored; tests inject an override.
   */
  private get telemetryRecorder(): AndroidTelemetryRecorder {
    return this.telemetryRecorderOverride ?? TelemetryRecorder.getInstance();
  }

  /** Resolve the failure recorder fresh per call; tests inject an override. */
  private get failureRecorder(): FailureRecorderService {
    return this.failureRecorderOverride ?? getFailureRecorder();
  }

  /**
   * Route one Android SDK telemetry event to `TelemetryRecorder`. Best-effort:
   * never throws so a recorder failure cannot break observation.
   */
  async recordSdkEvent(
    sdkEvent: SdkEvent<AndroidSdkEventPayload>,
    _applicationId: string | null,
  ): Promise<void> {
    try {
      const recorder = this.telemetryRecorder;
      recorder.setContext(this.deviceId, null);
      const ts = sdkEvent.timestamp;
      const event = sdkEvent.payload.event;
      const appId = (event.applicationId as string) ?? null;

      switch (sdkEvent.type) {
        case "network_event":
          await recorder.recordNetworkEvent({
            timestamp: ts,
            applicationId: appId,
            url: event.url as string,
            method: event.method as string,
            statusCode: (event.statusCode as number) ?? 0,
            durationMs: (event.durationMs as number) ?? 0,
            requestBodySize: (event.requestBodySize as number) ?? -1,
            responseBodySize: (event.responseBodySize as number) ?? -1,
            protocol: (event.protocol as string) ?? null,
            host: (event.host as string) ?? null,
            path: (event.path as string) ?? null,
            error: (event.error as string) ?? null,
            requestHeaders: (event.requestHeaders as Record<string, string>) ?? null,
            responseHeaders: (event.responseHeaders as Record<string, string>) ?? null,
            requestBody: (event.requestBody as string) ?? null,
            responseBody: (event.responseBody as string) ?? null,
            contentType: (event.contentType as string) ?? null,
          });
          break;
        case "websocket_frame_event":
          await recorder.recordOsEvent({
            timestamp: ts,
            applicationId: appId,
            category: "websocket_frame",
            kind: (event.frameType as string) ?? "unknown",
            details: {
              connectionId: (event.connectionId as string) ?? "",
              url: (event.url as string) ?? "",
              direction: (event.direction as string) ?? "",
              payloadSize: String((event.payloadSize as number) ?? 0),
              success: String((event.success as boolean) ?? true),
            },
          });
          break;
        case "log_event":
          await recorder.recordLogEvent({
            timestamp: ts,
            applicationId: appId,
            level: (event.level as number) ?? 0,
            tag: (event.tag as string) ?? "",
            message: (event.message as string) ?? "",
            filterName: (event.filterName as string) ?? "",
          });
          break;
        case "broadcast_event":
          await recorder.recordOsEvent({
            timestamp: ts,
            applicationId: appId,
            category: "broadcast",
            kind: (event.action as string) ?? "unknown",
            details: (event.extraKeys as Record<string, string>) ?? null,
          });
          break;
        case "lifecycle_event":
          await recorder.recordOsEvent({
            timestamp: ts,
            applicationId: appId,
            category: "lifecycle",
            kind: (event.kind as string) ?? "unknown",
            details: (event.details as Record<string, string>) ?? null,
          });
          break;
        case "custom_event": {
          // Custom events are merged into log events
          const properties = event.properties as Record<string, unknown> | undefined;
          const propsStr =
            properties && Object.keys(properties).length > 0
              ? ` ${JSON.stringify(properties)}`
              : "";
          await recorder.recordLogEvent({
            timestamp: ts,
            applicationId: appId,
            level: 4, // INFO
            tag: "CustomEvent",
            message: `${(event.name as string) ?? ""}${propsStr}`,
            filterName: "custom",
          });
          break;
        }
        default:
          logger.debug(
            `[AndroidSdkEventIngestor] Ignoring unknown SDK event type: ${sdkEvent.type}`,
          );
      }
    } catch (error) {
      // Non-fatal — telemetry recording must never break observation.
      logger.debug(`[AndroidSdkEventIngestor] recordSdkEvent(${sdkEvent.type}) failed: ${error}`);
    }
  }

  /**
   * Record a `storage_changed` telemetry event. Kept separate from
   * {@link recordSdkEvent} because the client already builds the recorder input
   * from the wire message (via `storageTelemetryInputFromWire`) for the storage
   * listener/stream fan-out. Best-effort.
   */
  recordStorageEvent(input: StorageTelemetryInput): void {
    try {
      const recorder = this.telemetryRecorder;
      recorder.setContext(this.deviceId, null);
      void recorder.recordStorageEvent(input);
    } catch (error) {
      // Non-fatal — telemetry recording must never break observation.
      logger.debug(`[AndroidSdkEventIngestor] recordStorageEvent failed: ${error}`);
    }
  }

  async recordHandledException(event: AndroidHandledExceptionEvent): Promise<void> {
    try {
      const failureRecorder = this.failureRecorder;
      const stackTraceElements = this.parseStackTrace(event.stackTrace, event.packageName);

      const nonFatalInput = {
        exceptionType: event.exceptionClass,
        exceptionMessage: event.exceptionMessage ?? "Handled exception",
        stackTrace: stackTraceElements,
        customMessage: event.customMessage,
        deviceId: this.deviceId,
        deviceModel: event.deviceInfo.model,
        os: `Android ${event.deviceInfo.osVersion} (API ${event.deviceInfo.sdkInt})`,
        appVersion: event.appVersion ?? "unknown",
        sessionId: `handled-${event.packageName}-${this.now()}`,
        currentScreen: event.currentScreen ?? this.resolveCurrentScreen(),
      };

      const occurrenceId = await failureRecorder.recordNonFatal(nonFatalInput);
      logger.info(`[CTRL_PROXY] Recorded non-fatal exception: ${occurrenceId}`);
    } catch (error) {
      logger.error(`[CTRL_PROXY] Failed to record handled exception: ${error}`);
    }
  }

  async recordCrashAnalytics(event: SdkCrashPayload): Promise<void> {
    try {
      const failureRecorder = this.failureRecorder;
      const stackTraceElements = this.parseStackTrace(event.stackTrace, event.packageName);

      const crashInput = {
        exceptionType: event.exceptionClass,
        exceptionMessage: event.message ?? "Application crashed",
        stackTrace: stackTraceElements,
        threadName: event.threadName,
        deviceId: this.deviceId,
        deviceModel: event.deviceInfo.model,
        os: `Android ${event.deviceInfo.osVersion} (API ${event.deviceInfo.sdkInt})`,
        appVersion: event.appVersion ?? "unknown",
        sessionId: `crash-${event.packageName}-${this.now()}`,
        currentScreen: event.currentScreen ?? this.resolveCurrentScreen(),
      };

      const occurrenceId = await failureRecorder.recordCrash(crashInput);
      logger.info(`[CTRL_PROXY] Recorded crash: ${occurrenceId}`);
    } catch (error) {
      logger.error(`[CTRL_PROXY] Failed to record crash: ${error}`);
    }
  }

  async recordAnrAnalytics(event: SdkAnrPayload, packageName: string): Promise<void> {
    try {
      const failureRecorder = this.failureRecorder;

      // Parse stack trace if available
      const stackTraceElements = event.trace ? this.parseStackTrace(event.trace, packageName) : [];

      const anrInput = {
        reason: event.reason,
        stackTrace: stackTraceElements.length > 0 ? stackTraceElements : undefined,
        deviceId: this.deviceId,
        deviceModel: event.deviceInfo.model,
        os: `Android ${event.deviceInfo.osVersion} (API ${event.deviceInfo.sdkInt})`,
        appVersion: event.appVersion ?? "unknown",
        sessionId: `anr-${packageName}-${this.now()}`,
        currentScreen: this.resolveCurrentScreen(),
      };

      const occurrenceId = await failureRecorder.recordAnr(anrInput);
      logger.info(`[CTRL_PROXY] Recorded ANR: ${occurrenceId}`);
    } catch (error) {
      logger.error(`[CTRL_PROXY] Failed to record ANR: ${error}`);
    }
  }

  /**
   * Resolve the current screen from the navigation graph, tolerating a
   * not-yet-bound session. Returns undefined when unavailable.
   */
  private resolveCurrentScreen(): string | undefined {
    try {
      return this.getNavigationScreenSource().getCurrentScreen() ?? undefined;
    } catch (error) {
      // The navigation session may not be bound yet when an ANR/crash event
      // arrives; omitting currentScreen is fine, it's supplementary context.
      logger.debug(
        `src/features/observe/android/AndroidSdkEventIngestor.ts screen resolution failed: ${error}`,
        error,
      );
      return undefined;
    }
  }
}
