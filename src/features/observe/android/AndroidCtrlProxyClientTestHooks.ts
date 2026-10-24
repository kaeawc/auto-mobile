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
import type { DelegateContext } from "../shared/types";

/** Constructor-injected collaborators and flags a test may read back to prove wiring. */
export type AndroidCtrlProxyInjectedState = Readonly<
  Record<
    | "ctrlProxyForwardLease"
    | "forwardClientProbe"
    | "loggerInstance"
    | "transientObserver"
    | "timer"
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
  injected(): AndroidCtrlProxyInjectedState;
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
