import type WebSocket from "ws";
import type { RequestManager } from "../../../utils/RequestManager";
import type { ViewHierarchyResult } from "../../../models";
import type { ScreenScaleMetadata } from "../../../models/ScreenScaleMetadata";
import type { TrackedScreenGeometry } from "../TrackedScreenGeometry";
import type { CoordinateSpace } from "../../../daemon/canonicalPixels";
import type { ScreenshotMetadata } from "../ScreenshotMetadata";
import type { DecodedSdkEvent } from "./decodeSdkEventBatches";
import type { CtrlProxyCachedHierarchy, WebSocketMessage, XCTestHierarchy } from "./types";

type SdkEventBatch = {
  bundleId?: string;
  events?: Array<{ eventType: string; payload: string }>;
};

export interface ScreenshotObservationStreamOptions {
  screenshotBase64: string;
  screenWidth: number;
  screenHeight: number;
  metadata?: ScreenshotMetadata;
  captureSequence?: number;
  coordinateSpace?: CoordinateSpace;
  nativeScale?: number;
  frameContext?: string;
  rotation?: number;
}

/**
 * Typed view of the `IOSCtrlProxyClient` internals that unit tests need to drive
 * deterministically. Obtained through `IOSCtrlProxyClient.testHooks`; production code
 * never reads it, so the client keeps its members private.
 */
export interface IosCtrlProxyClientTestHooks {
  readonly requestManager: RequestManager;
  readonly screenGeometry: TrackedScreenGeometry;
  readonly hierarchyObservationStreamSuppressions: Map<string, NodeJS.Timeout>;
  readonly pendingConnectAbort: { socket: WebSocket } | null;
  readonly pendingRestartToken: number | undefined;
  readonly sdkEventPollGeneration: number;
  readonly sdkEventPollConsecutiveEmpty: number;
  recoveryPromise: Promise<boolean> | null;
  isRequestingServiceRestart: boolean;
  cachedHierarchy: CtrlProxyCachedHierarchy | null;
  reportedScaleMetadata: ScreenScaleMetadata | null;
  processMessage(message: WebSocketMessage): void;
  handleMessage(data: WebSocket.Data): void;
  pushHierarchyToObservationStream(
    hierarchy: ViewHierarchyResult,
    source: XCTestHierarchy | undefined,
  ): void;
  pushScreenshotToObservationStream(options: ScreenshotObservationStreamOptions): void;
  decodeSdkEventBatches(batches: SdkEventBatch[], generation: number): DecodedSdkEvent[];
  runSdkEventPollCycle(generation: number): Promise<void>;
  currentSdkEventPollIntervalMs(): number;
  stopSdkEventPolling(): void;
  updatePort(port: number): void;
  getWebSocketUrl(): string;
  connectWebSocket(): Promise<boolean>;
  onConnectAttemptFailed(): void;
  onConnectionClosed(): void;
  scheduleReconnect(): void;
}
