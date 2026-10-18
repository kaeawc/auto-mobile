import type { ForcedRestartBudget } from "../../../ctrlProxy/ForcedRestartBudget";
import type { RequestManager } from "../../../utils/RequestManager";
import type { CtrlProxyText } from "./CtrlProxyText";
import type { CachedHierarchy } from "./types";

/**
 * The one typed view of `AndroidCtrlProxyClient` internals that unit tests need
 * (`client.testHooks`). It replaces ad hoc casts into private state; production
 * code never reads it.
 */
export interface AndroidCtrlProxyClientTestHooks {
  readonly requestManager: RequestManager;
  readonly forcedRestartBudget: ForcedRestartBudget;
  text(): CtrlProxyText;
  /** Own-property handler table keyed by wire message type. */
  webSocketMessageHandlers(): object;
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
