import WebSocket from "ws";
import { logger } from "../../../utils/logger";
import {
  PROTOTYPE_REQUEST_CANCEL_MESSAGE_TYPE,
  PROTOTYPE_REQUEST_MESSAGE_TYPE,
} from "../../prototype/prototypeRequestProtocol";
import { PROTOTYPE_CHANNEL_DEVICE_FRAME_TYPES } from "../../prototype/prototypeChannelHost";
import { displayTransitions } from "../DisplayTransition";
import { deriveSdkNavigationScreenIdentity } from "../sdkScreenIdentity";
import { rewriteUnknownCommandError } from "../shared/rewriteUnknownCommandError";
import { NavigationScreenshotManager } from "../../navigation/NavigationScreenshotManager";
import { getDbWriteBarrier } from "../../../db/dbWriteBarrier";
import { getDeviceDataStreamServer } from "../../../daemon/deviceDataStreamSocketServer";
import {
  ANDROID_CTRLPROXY_SCREENSHOT_METADATA,
  metadataForScreenshotFormat,
} from "../ScreenshotMetadata";
import { withResolvedTimestamp } from "../crash/sdkCrashIngestion";
import { serverConfig } from "../../../utils/ServerConfig";
import {
  ANDROID_REQUEST_ID_ECHO_CAPABILITY,
  ANDROID_REQUEST_ID_RESPONSE_TYPES,
  ctrlProxyMissingRequestIdError,
} from "./ctrlProxyProtocol";
import { StorageChangedEvent } from "../../storage/storageTypes";
import { ScreenshotResult } from "./types";
import type { AndroidInboundMessageRouterContext } from "./AndroidInboundMessageRouterContext";
import type { WebSocketMessage, WebSocketMessageHandlers } from "./androidCtrlProxyInboundProtocol";

import { AndroidInboundResponseHandlers } from "./AndroidInboundResponseHandlers";
import {
  displayTransitionFromWire,
  screenshotPerformanceMetadataFrom,
  normalizeStorageWireValue,
  storageTelemetryInputFromWire,
  parseCtrlProxyJson,
  SDK_TELEMETRY_EVENT_TYPES,
} from "./androidCtrlProxyInboundWire";
/**
 * Host-proxied prototype HTTP (#12527) and channel (#14268) frames: not in the Kotlin-mirrored wire
 * manifest.
 */
const PROTOTYPE_HOST_FRAME_TYPES: ReadonlySet<string> = new Set([
  PROTOTYPE_REQUEST_MESSAGE_TYPE,
  PROTOTYPE_REQUEST_CANCEL_MESSAGE_TYPE,
  ...PROTOTYPE_CHANNEL_DEVICE_FRAME_TYPES,
]);

export class AndroidInboundMessageRouter {
  readonly webSocketMessageHandlers;
  constructor(private readonly ctx: AndroidInboundMessageRouterContext) {
    this.webSocketMessageHandlers = {
      ...this.connectionHandlers,
      ...new AndroidInboundResponseHandlers(ctx).handlers,
      ...this.eventHandlers,
    };
  }
  private readonly connectionHandlers = {
    connected: (message) => {
      if (this.ctx.transientObserver) {
        return;
      }
      this.ctx.rejectedCommands.clear();
      this.ctx.supportedCommands = Array.isArray(message.supportedCommands)
        ? new Set(message.supportedCommands)
        : null;
      if (this.ctx.supportedCommands?.has(ANDROID_REQUEST_ID_ECHO_CAPABILITY)) {
        this.ctx.hierarchy.markRequestIdEchoAdvertised();
      }
      logger.debug(`[CTRL_PROXY] Received connection confirmation`);
      this.ctx.refreshObservationStreamHierarchyCadence();
    },

    error: (message) => {
      const rejectedCommand = /^Unknown command type: (.+)$/.exec(message.error ?? "")?.[1];
      if (rejectedCommand) {
        this.ctx.rejectedCommands.add(rejectedCommand);
      }
      const deviceError = message.error || "Runner reported an unstructured protocol error";
      // Preserve capability refusals used by fallback callers, including focused-input clicks.
      const errorText =
        rejectedCommand &&
        [
          "request_click_focused_input",
          "show_prototype",
          "dismiss_prototype",
          "put_prototype_asset",
          "remove_prototype_asset",
        ].includes(rejectedCommand)
          ? deviceError
          : rewriteUnknownCommandError(deviceError, "android");
      logger.warn(
        `[CTRL_PROXY] Runner error (requestId: ${message.requestId ?? "none"}): ${errorText}`,
      );
      this.ctx.settleUnattributedFocusedClickRejection(
        message.requestId,
        rejectedCommand,
        errorText,
      );
      if (message.requestId) {
        this.ctx.lateCancelledScreenshotRequestIds.delete(message.requestId);
        this.ctx.requestManager.resolveError(message.requestId, errorText);
        this.ctx._hierarchy?.rejectPendingHierarchy(message.requestId, errorText);
      }
    },

    hierarchy_update: (message) => {
      if (message.data) {
        this.ctx.handleHierarchyUpdate(
          message.data,
          message.perfTiming,
          message.frameContext,
          message.requestId,
        );
      }
    },

    display_transition: (message) => {
      const event = displayTransitionFromWire(message);
      if (event) {
        displayTransitions.notifyAndroidTransition(this.ctx.device.deviceId, event);
        this.ctx.onDisplayTransition?.(event);
      }
    },

    screenshot: (message) => {
      if (message.requestId) {
        const cancelledAfterDispatch = this.ctx.lateCancelledScreenshotRequestIds.delete(
          message.requestId,
        );
        const suppressObservationStreamPush =
          this.ctx.screenshotObservationStreamSuppressions.delete(message.requestId);
        const metadata = {
          ...metadataForScreenshotFormat(ANDROID_CTRLPROXY_SCREENSHOT_METADATA, message.format),
          ...screenshotPerformanceMetadataFrom(message),
        };
        const binding = this.ctx.screenshotCaptureBindings.get(message.requestId);
        this.ctx.screenshotCaptureBindings.delete(message.requestId);
        if (cancelledAfterDispatch) {
          logger.debug(
            `[CTRL_PROXY] Discarded screenshot response for cancelled request (requestId: ${message.requestId})`,
          );
        } else if (!suppressObservationStreamPush) {
          this.ctx.pushScreenshotToObservationStream(message.data, {
            metadata,
            binding,
            frameContext: message.frameContext,
            rotation: message.rotation,
          });
        } else {
          logger.debug(
            "[CTRL_PROXY] Suppressed screenshot observation stream push for explicit initial-frame request",
          );
        }
        this.ctx.requestManager.resolve<ScreenshotResult>(message.requestId, {
          success: true,
          data: message.data,
          format: message.format || "jpeg",
          timestamp: message.timestamp,
          frameContext: message.frameContext,
          rotation: message.rotation,
          displayId: message.displayId,
          panelUniqueId: message.panelUniqueId,
          ...screenshotPerformanceMetadataFrom(message),
          ...(typeof message.prototypesHidden === "boolean"
            ? { prototypesHidden: message.prototypesHidden }
            : {}),
        });
      }
    },

    screenshot_error: (message) => {
      if (message.requestId) {
        this.ctx.lateCancelledScreenshotRequestIds.delete(message.requestId);
        logger.warn(
          `[CTRL_PROXY] Screenshot error (requestId: ${message.requestId}): ${message.error}`,
        );
        this.ctx.requestManager.resolve<ScreenshotResult>(message.requestId, {
          success: false,
          error: message.error || "Unknown error",
          displayId: message.displayId,
          panelUniqueId: message.panelUniqueId,
        });
      }
    },
  } satisfies Pick<
    WebSocketMessageHandlers,
    | "connected"
    | "error"
    | "hierarchy_update"
    | "display_transition"
    | "screenshot"
    | "screenshot_error"
  >;

  private readonly eventHandlers = {
    navigation_event: async (message) => {
      const event = message.event;
      if (event) {
        // The WebSocket protocol puts timestamp on the outer message, not inside event.
        // Ensure the event has a timestamp for the navigation graph manager.
        if (event.timestamp === undefined && message.timestamp !== undefined) {
          event.timestamp = message.timestamp;
        }
        if (event.applicationId) {
          this.ctx.sdkNavigationAppIds.add(event.applicationId);
          const identity = deriveSdkNavigationScreenIdentity("android", event.applicationId, event);
          if (identity) {
            this.ctx.recordSdkScreenIdentity(event.applicationId, identity);
          }
          // Eagerly resolve build/device provenance for this app (#4984).
          // Non-blocking: later events pick up the resolved build key; this
          // event may still record under the default key.
          this.ctx.ensureBuildContext(event.applicationId);
        }
        this.ctx.attachRecentInteraction(event);

        logger.info(
          `[CTRL_PROXY] Navigation event: ${event.destination} (app: ${event.applicationId})`,
        );
        // Barrier-tracked via trackExisting so graceful shutdown drains this
        // fire-and-forget write, WITHOUT wrapping it in track(): the caller keeps
        // awaiting the original promise, so the nav-event↔hierarchy-update
        // interleaving that "preserve SDK screen names" depends on is unchanged
        // (issue #2885). If the write is still in flight when the drain window
        // closes, Part 1's dialect reject-on-closed drops the row cleanly
        // (issue #2792).
        const navWrite = this.ctx.enqueueNavigationGraphWrite(event);
        void getDbWriteBarrier().trackExisting(navWrite);
        await navWrite;
        if (this.ctx.closed) {
          // The graph write is best-effort; skipping its screenshot tail avoids released-device I/O.
          logger.debug("[CTRL_PROXY] Skipping navigation screenshot after close");
          return;
        }

        if (
          event.applicationId &&
          event.destination &&
          serverConfig.isNavigationScreenshotsEnabled()
        ) {
          await NavigationScreenshotManager.getInstance()
            .captureAndStore(this.ctx.device, this.ctx.adb, event.applicationId, event.destination)
            .then((screenshotPath) => {
              if (this.ctx.closed) {
                // The screenshot is optional; do not attach it to a session that has ended.
                logger.debug("[CTRL_PROXY] Skipping navigation screenshot update after close");
                return;
              }
              if (screenshotPath) {
                return this.ctx
                  .getNavigationGraphManager()
                  .updateNodeScreenshot(event.applicationId!, event.destination!, screenshotPath)
                  .catch((err) => logger.warn(`[CTRL_PROXY] Failed to update screenshot: ${err}`));
              }
            })
            .catch((err) => {
              // Navigation screenshots are optional and never block navigation recording.
              logger.debug(`[CTRL_PROXY] Screenshot capture skipped: ${err}`);
            });
        }
      }
    },

    package_event: async (message) => {
      const event = message.event;
      if (event) {
        await this.ctx.handlePackageEvent(event, message.timestamp);
      }
    },

    prototype_event: (message) => {
      this.ctx.prototypes.handlePrototypeEvent(message);
    },

    interaction_event: (message) => {
      const interaction = message.event;
      if (interaction) {
        const now = this.ctx.timer.now();
        this.ctx.pruneStaleInteractions(now);
        if (interaction.packageName) {
          this.ctx.lastInteractionByApp.delete(interaction.packageName);
          this.ctx.lastInteractionByApp.set(interaction.packageName, {
            type: interaction.type,
            elementText: interaction.element?.text ?? undefined,
            elementResourceId: interaction.element?.["resource-id"] ?? undefined,
            timestamp: interaction.timestamp,
            receivedAtMs: now,
          });
          while (this.ctx.lastInteractionByApp.size > this.ctx.maxCachedInteractions) {
            const oldestApplicationId = this.ctx.lastInteractionByApp.keys().next().value;
            this.ctx.lastInteractionByApp.delete(oldestApplicationId ?? "");
          }
        }
        this.ctx.notifyInteractionListeners(interaction);
      }
    },

    handled_exception_event: async (message) => {
      const event = message.event;
      if (event) {
        await this.ctx.handleHandledExceptionEvent(event);
      }
    },

    crash_event: async (message) => {
      const event = message.event;
      if (event) {
        // A crash ends the app's process; its last route no longer names anything on screen.
        if (event.packageName) {
          this.ctx.clearSdkScreenIdentity(event.packageName);
        }
        await this.ctx.handleCrashEvent(
          withResolvedTimestamp(event, message.timestamp, this.ctx.timer.now()),
        );
      }
    },

    anr_event: async (message) => {
      const event = message.event;
      if (event) {
        await this.ctx.handleAnrEvent(
          withResolvedTimestamp(event, message.timestamp, this.ctx.timer.now()),
        );
      }
    },

    frame_metrics_event: (message) => {
      if (message.frameMetrics) {
        this.ctx.handleFrameMetricsEvent(message.frameMetrics);
      }
    },

    storage_changed: (message) => {
      const normalizedValue = normalizeStorageWireValue(message.value, message.valueType);
      if (normalizedValue === undefined) {
        logger.warn(
          `[CTRL_PROXY] Ignoring unsafe legacy LONG storage value for ${message.packageName ?? "unknown"}/${message.fileName ?? "unknown"}`,
        );
        return;
      }
      const storageEvent: StorageChangedEvent = {
        packageName: message.packageName ?? "",
        fileName: message.fileName ?? "",
        key: message.key ?? null,
        // Non-string preference types arrive as bare JSON (number/boolean/array); re-encode
        // to the JSON string contract so the desktop storage_update frame decodes (#4709 review).
        value: normalizedValue,
        valueType: message.valueType ?? "STRING",
        timestamp: message.timestamp ?? this.ctx.timer.now(),
        sequenceNumber: message.sequenceNumber ?? 0,
      };
      logger.debug(
        `[CTRL_PROXY] Storage changed: ${storageEvent.packageName}/${storageEvent.fileName} key=${storageEvent.key}`,
      );

      this.ctx.storage.notifyStorageChangeListeners(storageEvent);

      const server = getDeviceDataStreamServer();
      if (server) {
        server.pushStorageUpdate(this.ctx.device.deviceId, storageEvent);
      }

      // Record to telemetry timeline (fan-out owned by the ingestor, #2764).
      const telemetryInput = storageTelemetryInputFromWire(message, storageEvent.timestamp);
      if (telemetryInput !== undefined) {
        this.ctx.getSdkEventIngestor().recordStorageEvent(telemetryInput);
      }
    },

    network_event: (message) => this.ctx.recordSdkTelemetryEvent(message),

    websocket_frame_event: (message) => this.ctx.recordSdkTelemetryEvent(message),

    log_event: (message) => this.ctx.recordSdkTelemetryEvent(message),

    broadcast_event: (message) => this.ctx.recordSdkTelemetryEvent(message),

    lifecycle_event: (message) => this.ctx.recordSdkTelemetryEvent(message),
  } satisfies Omit<
    WebSocketMessageHandlers,
    | keyof AndroidInboundResponseHandlers["handlers"]
    | "connected"
    | "error"
    | "hierarchy_update"
    | "display_transition"
    | "screenshot"
    | "screenshot_error"
  >;
  /**
   * `prototype_request` runs a host HTTP call: not awaited, since a request can run for 30s and
   * must not hold up the inbound handler drain. `prototype_request_cancel` aborts one (no reply).
   */
  private routePrototypeHostFrame(type: string, message: unknown): void {
    if (PROTOTYPE_CHANNEL_DEVICE_FRAME_TYPES.has(type)) {
      this.ctx.prototypes.channels.handleFrame(message);
      return;
    }
    if (type === PROTOTYPE_REQUEST_CANCEL_MESSAGE_TYPE) {
      this.ctx.prototypes.handlePrototypeRequestCancel(message);
      return;
    }
    this.ctx.prototypes.handlePrototypeRequest(message).catch((error) => {
      logger.warn(`[CTRL_PROXY] prototype_request failed: ${error}`);
    });
  }

  async handleWebSocketMessage(data: WebSocket.Data): Promise<void> {
    try {
      const message = parseCtrlProxyJson<WebSocketMessage>(data.toString());
      const type = (message as { type: string }).type;
      if (
        this.ctx.transientObserver &&
        !["connected", "hierarchy_update", "error"].includes(type)
      ) {
        return;
      }
      if (
        this.ctx.supportedCommands?.has(ANDROID_REQUEST_ID_ECHO_CAPABILITY) &&
        ANDROID_REQUEST_ID_RESPONSE_TYPES.has(type) &&
        !("requestId" in message && message.requestId)
      ) {
        logger.warn(ctrlProxyMissingRequestIdError(type));
        return;
      }
      if (Object.hasOwn(this.webSocketMessageHandlers, type)) {
        // The mapped type checks each entry; this cast reconnects key and value after lookup.
        const handler = this.webSocketMessageHandlers[type as WebSocketMessage["type"]] as (
          message: WebSocketMessage,
        ) => void | Promise<void>;
        await handler(message);
      } else if (SDK_TELEMETRY_EVENT_TYPES.has(type)) {
        await this.ctx.recordSdkTelemetryEvent(
          message as { type: string; timestamp?: number; event?: Record<string, unknown> },
        );
      } else if (PROTOTYPE_HOST_FRAME_TYPES.has(type)) {
        this.routePrototypeHostFrame(type, message);
      } else {
        logger.debug(`[CTRL_PROXY] Ignoring unknown WebSocket message type: ${type}`);
      }
    } catch (error) {
      logger.warn(`[CTRL_PROXY] Error handling WebSocket message: ${error}`);
    }
  }
}
