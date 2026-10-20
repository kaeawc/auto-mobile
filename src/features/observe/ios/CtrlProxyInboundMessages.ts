import { SdkCapabilityProbeSupersededError } from "./SdkCapabilityProbeSupersededError";
import type { Timer } from "../../../utils/SystemTimer";
import type { RequestManager } from "../../../utils/RequestManager";
import type { ViewHierarchyResult } from "../../../models";
import type {
  WebSocketMessage,
  XCTestHierarchy,
  CtrlProxyCachedHierarchy,
  CtrlProxyPerfTiming,
  CtrlProxyPerformanceSnapshot,
} from "./types";
import type { CtrlProxySdkCapabilities } from "./CtrlProxySdkCapabilities";
import type { IosHierarchyMessageEffects } from "./IosHierarchyMessageEffects";
import {
  decodeCtrlProxyMessage,
  gesturePhaseSummary,
  type DecodedCtrlProxyMessage,
} from "./decodeCtrlProxyMessage";
import { iosRunnerRefusalError } from "./IosRunnerStalledError";
import { displayTransitions } from "../DisplayTransition";
import { logger } from "../../../utils/logger";
import { errorMessage } from "../../../utils/describeUnknownError";
interface InboundMessagesHost {
  readonly timer: Timer;
  readonly requestManager: RequestManager;
  readonly deviceId: string;
  readonly transientObserver: boolean;
  readonly observerHierarchyRequestIds: Set<string>;
  readonly rejectedCommands: Set<string>;
  readonly sdkCapability: Pick<
    CtrlProxySdkCapabilities,
    "invalidateSdkCapabilities" | "refreshSdkCapabilitiesAndSync"
  >;
  cachedHierarchy: CtrlProxyCachedHierarchy | null;
  cachedHierarchyDisplayRevision: number;
  supportedCommands: Set<string> | null;
  supportedFeatures: Set<string> | null;
  getMessageEffects(): IosHierarchyMessageEffects;
  syncHierarchyCadenceToDevice(): void;
  handlePerformanceUpdate(snapshot: CtrlProxyPerformanceSnapshot): void;
}

/** Routes runner messages in order, rejecting stale pushes before any side effects. */
export class CtrlProxyInboundMessages {
  constructor(private readonly host: InboundMessagesHost) {}

  // #9259 re-broadcasts lagged by ~3–10s; 30s leaves headroom while bounding
  // the older-push guard when the device clock takes a larger backward step.
  private static readonly MAX_HIERARCHY_REBROADCAST_GAP_MS = 30_000;

  // Count only advancing-clock older pushes: #9259 re-broadcasts the same stale
  // tree after navigation, so repeats must never accumulate toward recovery.
  private static readonly MAX_CONSECUTIVE_OLDER_HIERARCHY_PUSHES = 5;

  private consecutiveOlderHierarchyPushes = 0;

  private lastDroppedOlderPushUpdatedAt: number | null = null;

  private logTapDiagnostics(message: WebSocketMessage, hasDecodedResult: boolean): void {
    if (message.type !== "tap_coordinates_result" || message.tapDiagnostics === undefined) {
      return;
    }
    // Native JSON.stringify preserves the optional wire payload, including malformed values.
    logger.debug(`[CTRLPROXY_TAP_DIAG] ${JSON.stringify(message.tapDiagnostics)}`);
    const diagnostics = message.tapDiagnostics;
    if (
      hasDecodedResult &&
      diagnostics &&
      typeof diagnostics === "object" &&
      diagnostics.deliveryWarning === "eventDisplayMismatch"
    ) {
      logger.warn(
        `[CTRLPROXY_TAP_DIAG] deliveryWarning=eventDisplayMismatch route=${diagnostics.route ?? "unknown"} targetDisplayId=${diagnostics.targetDisplayId ?? "nil"} requestId=${message.requestId}`,
      );
    }
  }

  resetOlderHierarchyPushRun(): void {
    this.consecutiveOlderHierarchyPushes = 0;
    this.lastDroppedOlderPushUpdatedAt = null;
  }

  ignoreOlderHierarchyPush(message: WebSocketMessage): boolean {
    if (message.type !== "hierarchy_update" || message.requestId || !message.data) {
      return false;
    }
    if (
      this.host.cachedHierarchy === null ||
      !(message.data.updatedAt < this.host.cachedHierarchy.hierarchy.updatedAt)
    ) {
      this.resetOlderHierarchyPushRun();
      return false;
    }
    const cachedTimestamp = this.host.cachedHierarchy.hierarchy.updatedAt;
    const pushedTimestamp = message.data.updatedAt;
    const clockStep =
      cachedTimestamp - pushedTimestamp > CtrlProxyInboundMessages.MAX_HIERARCHY_REBROADCAST_GAP_MS;
    this.consecutiveOlderHierarchyPushes =
      this.lastDroppedOlderPushUpdatedAt !== null &&
      pushedTimestamp > this.lastDroppedOlderPushUpdatedAt
        ? this.consecutiveOlderHierarchyPushes + 1
        : 1;
    if (
      clockStep ||
      this.consecutiveOlderHierarchyPushes >=
        CtrlProxyInboundMessages.MAX_CONSECUTIVE_OLDER_HIERARCHY_PUSHES
    ) {
      logger.warn(
        `[IOSCtrlProxyClient] Resetting hierarchy push baseline (${clockStep ? "backward clock step" : "consecutive older push limit"}): pushed=${pushedTimestamp} cached=${cachedTimestamp}`,
      );
      this.resetOlderHierarchyPushRun();
      return false;
    }
    this.lastDroppedOlderPushUpdatedAt = pushedTimestamp;
    logger.debug(
      `[IOSCtrlProxyClient] Ignoring older hierarchy push: pushed=${pushedTimestamp} cached=${cachedTimestamp}`,
    );
    return true;
  }

  processMessage(message: WebSocketMessage): void {
    const { type, requestId } = message;
    if (
      this.host.transientObserver &&
      !["connected", "hierarchy_update", "screenshot", "error"].includes(type)
    ) {
      return;
    }

    // Handle push messages (no requestId)
    if (type === "connected") {
      this.processConnectedMessage(message);
      return;
    }

    if (this.isSdkCapabilityFailure(message)) {
      this.host.sdkCapability.invalidateSdkCapabilities();
    }

    if (type === "hierarchy_update" && message.data) {
      if (!this.prepareHierarchyMessage(message, requestId)) {
        return;
      }
    }

    // Handle request/response messages (with requestId) first
    if (requestId && this.resolveMessageResponse(message, type, requestId)) {
      return;
    }

    this.processPushMessage(type, message);
  }

  private processPushMessage(type: string, message: WebSocketMessage): void {
    // Handle push messages (no requestId)
    if (type === "hierarchy_update" && message.data) {
      this.processHierarchyPush(message);
      return;
    }

    // Handle performance update push messages from CADisplayLink FPS monitoring
    if (type === "performance_update") {
      if (message.performanceData) {
        this.host.handlePerformanceUpdate(message.performanceData);
      } else {
        logger.warn(
          `[IOSCtrlProxyClient] Received performance_update but no performanceData field`,
        );
      }
      return;
    }
  }

  private processConnectedMessage(message: WebSocketMessage): void {
    if (this.host.transientObserver) {
      return;
    }
    this.host.rejectedCommands.clear();
    this.host.supportedCommands = Array.isArray(message.supportedCommands)
      ? new Set(message.supportedCommands)
      : null;
    this.host.supportedFeatures = Array.isArray(message.supportedFeatures)
      ? new Set(message.supportedFeatures)
      : null;
    try {
      this.host.syncHierarchyCadenceToDevice();
    } catch (error) {
      logger.warn(
        `[IOSCtrlProxyClient] Hierarchy cadence sync failed: ${errorMessage(error)}`,
        error,
      );
    }
    this.host.sdkCapability.invalidateSdkCapabilities();
    void this.host.sdkCapability.refreshSdkCapabilitiesAndSync().catch((error) => {
      if (error instanceof SdkCapabilityProbeSupersededError) {
        // The newer foreground generation refreshes its own capabilities.
        logger.debug(`[IOSCtrlProxyClient] SDK capability refresh superseded: ${error.message}`);
        return;
      }
      logger.warn(
        `[IOSCtrlProxyClient] SDK capability refresh failed: ${errorMessage(error)}`,
        error,
      );
    });
    logger.info(`[IOSCtrlProxyClient] Received connected message`);
    return;
  }

  private prepareHierarchyMessage(
    message: WebSocketMessage,
    requestId: string | undefined,
  ): boolean {
    if (
      this.host.transientObserver &&
      (!requestId || !this.host.observerHierarchyRequestIds.has(requestId))
    ) {
      return false;
    }
    // Reject out-of-order pushes before they can affect cache or observation state.
    if (this.host.getMessageEffects().ignoreOlderPush(message)) {
      return false;
    }
    // Retain the additive #4548 scale metadata on RECEIPT — the moment the hierarchy first
    // arrives — independent of whether it is later pushed to the observation stream. The push
    // is skipped entirely when there is no device-data server, and suppressed for explicit
    // initial-frame requests, so retaining inside pushHierarchyToObservationStream would leave
    // getScreenScaleMetadata() null on exactly the paths #4549 must still be able to read.
    const observerResponse = requestId
      ? this.host.observerHierarchyRequestIds.delete(requestId)
      : false;
    if (!observerResponse) {
      this.host.getMessageEffects().retainScaleMetadata(message.data! as XCTestHierarchy);
      this.host.getMessageEffects().recordNavigation(message.data!, message.perfTiming);
    }
    // Record layout telemetry event using converted hierarchy (same format as observation stream)
    const converted = this.host.getMessageEffects().convert(message.data!);
    if (!observerResponse) {
      this.host.getMessageEffects().recordLayoutTelemetry(converted);
    }
    // Only push to observation stream for request-response updates (with requestId).
    // Push messages (no requestId) are handled in the dedicated push-message branch below
    // to avoid duplicate hierarchy events.
    this.publishHierarchyResponse(message, requestId, converted, observerResponse);
    return true;
  }

  private publishHierarchyResponse(
    message: WebSocketMessage,
    requestId: string | undefined,
    converted: ViewHierarchyResult,
    observerResponse: boolean,
  ): void {
    if (requestId) {
      const suppressObservationStreamPush = this.host
        .getMessageEffects()
        .consumeStreamSuppression(requestId);
      if (!suppressObservationStreamPush && !observerResponse) {
        this.host
          .getMessageEffects()
          .pushToObservationStream(
            converted,
            message.data as XCTestHierarchy,
            message.frameContext,
          );
      } else {
        logger.debug(
          "[IOSCtrlProxyClient] Suppressed hierarchy observation stream push for explicit initial-frame request",
        );
      }
    }
  }

  private resolveMessageResponse(
    message: WebSocketMessage,
    type: string,
    requestId: string,
  ): boolean {
    const phases = gesturePhaseSummary(message.perfTiming);
    if (phases) {
      const line = `[IOSCtrlProxyClient] type=${type} requestId=${requestId} ${phases}`;
      if (!this.host.requestManager.isPending(requestId)) {
        logger.warn(`${line} lateResponse=true`);
      } else {
        logger.debug(line);
      }
    }
    const decoded = decodeCtrlProxyMessage(message);
    this.logTapDiagnostics(message, decoded?.result !== undefined);
    return this.resolveDecodedMessage(message, decoded);
  }

  private resolveDecodedMessage(
    message: WebSocketMessage,
    decoded: DecodedCtrlProxyMessage | null,
  ): boolean {
    if (decoded) {
      if (decoded.runnerBusy && decoded.errorMessage !== undefined) {
        // Diagnostic/observer requests share this decoder and must never change
        // runner lifecycle. Normal hierarchy observation owns bounded recovery.
        this.host.requestManager.reject(
          decoded.requestId,
          iosRunnerRefusalError(decoded.errorMessage, decoded.runnerStalled),
        );
        return true;
      }
      if (decoded.errorMessage !== undefined) {
        this.rememberRejectedCommand(message.error);
        this.host.requestManager.resolveError(
          decoded.requestId,
          decoded.errorMessage,
          decoded.totalTimeMs ?? 0,
          decoded.perfTiming ? { perfTiming: decoded.perfTiming } : undefined,
        );
        return true;
      }
      this.host.getMessageEffects().resolveRequest(decoded.requestId, decoded.result);
      return true;
    }
    return false;
  }

  private processHierarchyPush(message: WebSocketMessage): void {
    // Push update from server
    const now = this.host.timer.now();
    const previous = this.host.cachedHierarchy;
    this.host.cachedHierarchy = {
      hierarchy: message.data!,
      receivedAt: now,
      captureReceivedAt:
        previous !== null && previous.hierarchy.updatedAt === message.data!.updatedAt
          ? (previous.captureReceivedAt ?? previous.receivedAt)
          : now,
      fresh: true,
      perfTiming: message.perfTiming as CtrlProxyPerfTiming | undefined,
      frameContext: message.frameContext,
    };
    this.resetOlderHierarchyPushRun();
    this.host.cachedHierarchyDisplayRevision =
      previous?.hierarchy.updatedAt === message.data!.updatedAt
        ? this.host.cachedHierarchyDisplayRevision
        : displayTransitions.revision(this.host.deviceId);
    logger.info(`[IOSCtrlProxyClient] Received hierarchy push update - UI changed`);

    // Convert and push to observation stream for IDE plugins
    const viewHierarchyResult = this.host.getMessageEffects().convert(message.data!);
    this.host
      .getMessageEffects()
      .pushToObservationStream(
        viewHierarchyResult,
        message.data! as XCTestHierarchy,
        message.frameContext,
      );

    // Start screenshot backoff sequence for real-time screenshot streaming
    this.host.getMessageEffects().startScreenshotBackoff();

    // Performance monitoring is handled in handleHierarchyUpdateForNavigation
    // which runs for ALL hierarchy_update messages (both push and request-response)

    // Notify listeners (e.g., ObserveScreen to clear its cache)
    this.host.getMessageEffects().notifyPushListeners(message.data!);
    return;
  }

  private rememberRejectedCommand(error?: string): void {
    const rejectedCommand = /^Unknown command type: (.+)$/.exec(error ?? "")?.[1];
    if (rejectedCommand) {
      this.host.rejectedCommands.add(rejectedCommand);
    }
  }

  private isSdkCapabilityFailure(message: WebSocketMessage): boolean {
    if (message.success !== false && message.ok !== false) {
      return false;
    }
    return (
      message.type === "set_network_mock_rules_result" ||
      message.type === "set_network_fault_rules_result" ||
      message.type === "set_network_error_simulation_result" ||
      message.type === "highlight_response" ||
      message.type === "execute_sql_result" ||
      message.type === "list_databases_result" ||
      message.type === "storage_capabilities_result" ||
      message.type === "list_tables_result" ||
      message.type === "table_data_result" ||
      message.type === "table_structure_result"
    );
  }
}
