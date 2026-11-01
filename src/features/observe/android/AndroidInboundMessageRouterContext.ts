import type { BootedDevice } from "../../../models";
import type { ScreenIdentity } from "../../../models/ObserveResult";
import type { RequestManager } from "../../../utils/RequestManager";
import type { Timer } from "../../../utils/SystemTimer";
import type { AdbExecutor } from "../../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import type {
  NavigationEvent,
  NavigationGraphService,
} from "../../navigation/NavigationGraphManager";
import type { StorageChangedEvent } from "../../storage/storageTypes";
import type { SdkAnrPayload, SdkCrashPayload } from "../crash/sdkCrashIngestion";
import type { ScreenshotMetadata } from "../ScreenshotMetadata";
import type { ScreenGeometryBinding } from "../TrackedScreenGeometry";
import type { AndroidPackageEvent } from "./AndroidAppEventRecorder";
import type {
  AndroidHandledExceptionEvent,
  AndroidSdkEventIngestor,
} from "./AndroidSdkEventIngestor";
import type { CtrlProxyCertificates } from "./CtrlProxyCertificates";
import type { CtrlProxyFocus } from "./CtrlProxyFocus";
import type { CtrlProxyHierarchy } from "./CtrlProxyHierarchy";
import type { PrototypeChannelRelay } from "../../prototype/prototypeChannelHost";
import type { CtrlProxyPrototypes } from "./CtrlProxyPrototypes";
import type {
  AndroidDisplayTransition,
  InteractionEvent,
  WsFrameMetricsMessage,
} from "./androidCtrlProxyInboundProtocol";
import type { AccessibilityHierarchy, AndroidPerfTiming } from "./types";

interface InboundConnectionContext {
  readonly transientObserver: boolean;
  readonly closed: boolean;
  readonly device: BootedDevice;
  readonly adb: AdbExecutor;
  readonly timer: Pick<Timer, "now">;
  readonly rejectedCommands: Set<string>;
  supportedCommands: Set<string> | null;
  readonly onDisplayTransition: ((event: AndroidDisplayTransition) => void) | undefined;
  refreshObservationStreamHierarchyCadence(intervalMs?: number | null): void;
}

interface InboundRequestContext {
  readonly requestManager: Pick<RequestManager, "resolve" | "resolveError">;
  resolvePendingResponse<Message extends { requestId?: string | null }, Payload>(
    message: Message,
    buildPayload: (message: Message & { requestId: string }) => Payload,
  ): void;
  settleUnattributedFocusedClickRejection(
    requestId: string | null | undefined,
    rejectedCommand: string | undefined,
    errorText: string,
  ): void;
}

interface InboundHierarchyContext {
  readonly hierarchy: Pick<CtrlProxyHierarchy, "markRequestIdEchoAdvertised">;
  readonly _hierarchy: Pick<CtrlProxyHierarchy, "rejectPendingHierarchy"> | null;
  handleHierarchyUpdate(
    data: AccessibilityHierarchy,
    perfTiming?: AndroidPerfTiming[],
    frameContext?: string,
    requestId?: string | null,
  ): void;
}

interface InboundScreenshotContext {
  readonly lateCancelledScreenshotRequestIds: Set<string>;
  readonly screenshotObservationStreamSuppressions: Set<string>;
  readonly screenshotCaptureBindings: Map<string, ScreenGeometryBinding>;
  pushScreenshotToObservationStream(
    screenshotBase64: string,
    options?: {
      metadata?: ScreenshotMetadata;
      binding?: ScreenGeometryBinding;
      frameContext?: string;
      rotation?: number;
    },
  ): void;
}

interface InboundNavigationContext {
  readonly sdkNavigationAppIds: Set<string>;
  readonly maxCachedInteractions: number;
  readonly lastInteractionByApp: Map<
    string,
    {
      type: string;
      elementText?: string;
      elementResourceId?: string;
      timestamp: number | undefined;
      receivedAtMs: number;
    }
  >;
  recordSdkScreenIdentity(applicationId: string, identity: ScreenIdentity): void;
  clearSdkScreenIdentity(applicationId?: string): void;
  ensureBuildContext(appId: string): void;
  attachRecentInteraction(event: NavigationEvent): void;
  enqueueNavigationGraphWrite(received: NavigationEvent): Promise<void>;
  getNavigationGraphManager(): Pick<NavigationGraphService, "updateNodeScreenshot">;
  pruneStaleInteractions(now: number): void;
  notifyInteractionListeners(event: InteractionEvent): void;
}

interface InboundDelegateContext {
  readonly certificates: Pick<CtrlProxyCertificates, "handleCaCertRemovalResult">;
  readonly focus: Pick<CtrlProxyFocus, "convertAccessibilityNodeToElement">;
  readonly prototypes: Pick<
    CtrlProxyPrototypes,
    "handlePrototypeEvent" | "handlePrototypeRequest" | "handlePrototypeRequestCancel"
  > & { readonly channels: Pick<PrototypeChannelRelay, "handleFrame"> };
  readonly storage: { notifyStorageChangeListeners(event: StorageChangedEvent): void };
}

interface InboundSdkEventContext {
  getSdkEventIngestor(): Pick<AndroidSdkEventIngestor, "recordStorageEvent">;
  recordSdkTelemetryEvent(message: {
    type: string;
    timestamp?: number;
    event?: Record<string, unknown>;
  }): Promise<void>;
}

interface InboundAppEventContext {
  handlePackageEvent(event: AndroidPackageEvent, timestamp?: number): Promise<void>;
  handleHandledExceptionEvent(event: AndroidHandledExceptionEvent): Promise<void>;
  handleCrashEvent(event: SdkCrashPayload): Promise<void>;
  handleAnrEvent(event: SdkAnrPayload): Promise<void>;
  handleFrameMetricsEvent(data: NonNullable<WsFrameMetricsMessage["frameMetrics"]>): void;
}

/** Accessor-backed properties and forwarding methods read live client state on every call. */
export interface AndroidInboundMessageRouterContext
  extends
    InboundConnectionContext,
    InboundRequestContext,
    InboundHierarchyContext,
    InboundScreenshotContext,
    InboundNavigationContext,
    InboundDelegateContext,
    InboundSdkEventContext,
    InboundAppEventContext {}
