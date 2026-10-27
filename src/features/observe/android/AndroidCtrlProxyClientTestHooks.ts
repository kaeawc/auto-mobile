import type { CtrlProxyGestures } from "./CtrlProxyGestures";
import type { ForcedRestartBudget } from "../../../ctrlProxy/ForcedRestartBudget";
import type { RequestManager } from "../../../utils/RequestManager";
import type { CtrlProxyText } from "./CtrlProxyText";
import type { CtrlProxyStorage } from "./CtrlProxyStorage";
import type { CtrlProxyCertificates } from "./CtrlProxyCertificates";
import type { CtrlProxyFocus } from "./CtrlProxyFocus";
import type { CtrlProxyPackages } from "./CtrlProxyPackages";
import type { CtrlProxyPrototypes } from "./CtrlProxyPrototypes";
import type { CtrlProxyHighlights } from "./CtrlProxyHighlights";
import type { CachedHierarchy } from "./types";
import type { AndroidInboundMessageRouter } from "./AndroidInboundMessageRouter";
import type { CtrlSocket, DelegateContext } from "../shared/types";
import type { CtrlProxyHierarchy } from "./CtrlProxyHierarchy";
import type { CertificatesDelegateContext, HierarchyDelegateContext } from "./types";
import type WebSocket from "ws";
import type { WorkProfileMonitor } from "../../../utils/WorkProfileMonitor";
import type { AndroidScreenshotRequester } from "./AndroidScreenshotRequester";

/** Constructor-injected collaborators and flags a test may read back to prove wiring. */
export type AndroidCtrlProxyInjectedState = Readonly<
  Record<
    | "ctrlProxyForwardLease"
    | "forwardClientProbe"
    | "loggerInstance"
    | "transientObserver"
    | "timer"
    | "device"
    | "adb"
    | "webSocketFactory"
    | "certificateFileSystem"
    | "serviceManagerFactory"
    | "idGenerator"
    | "screenshotBackoffScheduler"
    | "portAllocationId",
    unknown
  >
>;

/**
 * The one typed view of `AndroidCtrlProxyClient` internals that unit tests need
 * (`client.testHooks`). It replaces ad hoc casts into private state; production
 * code never reads it.
 */
export interface AndroidCtrlProxyClientTestHooks {
  readonly requestManager: RequestManager;
  readonly forcedRestartBudget: ForcedRestartBudget;
  text(): CtrlProxyText;
  gestures(): CtrlProxyGestures;
  storage(): CtrlProxyStorage;
  certificates(): CtrlProxyCertificates;
  focus(): CtrlProxyFocus;
  packages(): CtrlProxyPackages;
  prototypes(): CtrlProxyPrototypes;
  highlights(): CtrlProxyHighlights;
  /** Own-property handler table keyed by wire message type. */
  webSocketMessageHandlers(): AndroidInboundMessageRouter["webSocketMessageHandlers"];
  createDelegateContext(): DelegateContext;
  createHierarchyDelegateContext(): HierarchyDelegateContext;
  hierarchy(): CtrlProxyHierarchy;
  injected(): AndroidCtrlProxyInjectedState;
  isCommandSupported(messageType: string): boolean;
  /** Commands the device refused; tests add to it to arrange the refusal path. */
  readonly rejectedCommands: Set<string>;
  readonly screenshotObservationStreamSuppressions: Set<string>;
  workProfileMonitor: WorkProfileMonitor | null;
  createCertificatesDelegateContext(): CertificatesDelegateContext;
  getScreenshotRequester(): AndroidScreenshotRequester;
  finishEstablishedConnection(socket: CtrlSocket): void;
  handleMessage(data: WebSocket.Data): Promise<void>;
  onConnectionEstablished(): void;
  setCachedHierarchy(value: CachedHierarchy | null): void;
  /** Replaces the screenshot-backoff cancel, so a test can count or silence it. */
  overrideCancelScreenshotBackoff(cancel: () => void): void;
  /** Replaces the connect step, so a test can skip real connection provisioning. */
  overrideConnectWebSocket(connect: () => Promise<boolean>): void;
  /** Adds to (or replaces within) the platform-specific delegate-context fields. */
  extendDelegateContextFields(extra: () => Partial<DelegateContext>): void;
  /** The memoised gestures delegate; assign a prebuilt one to drive it with a custom context. */
  installedGestures: CtrlProxyGestures | null;
  cachedHierarchy(): CachedHierarchy | null;
  handleWebSocketMessage(data: string): Promise<void>;
  getWebSocketUrl(): string;
  removeCtrlProxyPortForward(port: number): Promise<boolean>;
  recoveryPromise: Promise<boolean> | null;
  isRecoveringService: boolean;
  connectionAttempts: number;
  lastConnectionAttempt: number;
  connectionResetMs: number;
  portForwardingSetup: boolean;
  localPort: number;
}
