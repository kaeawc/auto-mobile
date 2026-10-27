import type { DaemonNotification } from "../types";
import type { ProxyRuntime } from "../mcpProxy/ProxyRuntime";
import type { ProxySessionOwnership } from "../mcpProxy/ProxySessionOwnership";
import type { ProxyLiveness } from "../mcpProxy/ProxyLiveness";
import type { ProxyCollaborators } from "../mcpProxy/ProxyCollaborators";
import type { ProxyToolRouting } from "../mcpProxy/ProxyToolRouting";
import type { ProxyToolCalls } from "../mcpProxy/ProxyToolCalls";

/** Typed, live view of the proxy internals needed by deterministic tests. */
export interface DaemonMcpProxyTestInternals extends Pick<
  ProxyRuntime,
  | "sessionState"
  | "pendingSessionLosses"
  | "brokerSessions"
  | "resourceSubscriptions"
  | "releaseLedger"
  | "proxyHeartbeatKeeper"
  | "latestBindingKeeper"
  | "livenessRecovery"
  | "stallHandovers"
  | "livenessAcks"
  | "sessionDeviceIds"
  | "ownedDeviceSessions"
  | "boundSessionUuidAt"
  | "boundSessionUuid"
  | "notFoundStopped"
  | "otherHeldSessions"
  | "errorClassifier"
  | "structuredToolErrorCodes"
  | "daemonShutdownBarrier"
> {
  resetConnection(): Promise<void>;
  handleSessionReleasedNotification(notification: DaemonNotification): void;
  readonly sessionOwnership: Pick<ProxySessionOwnership, "holdPreviousBinding">;
  runBoundSessionHeartbeatTick: ProxyLiveness["runBoundSessionHeartbeatTick"];
  heartbeatHeldSession: ProxySessionOwnership["heartbeatHeldSession"];
  heartbeatWithStallDetection: ProxySessionOwnership["heartbeatWithStallDetection"];
  createSessionBindingPort: ProxyCollaborators["createSessionBindingPort"];
  hasSessionCallInFlight: ProxyToolRouting["hasSessionCallInFlight"];
  noteDaemonIdleEvidence: ProxyToolRouting["noteDaemonIdleEvidence"];
  recordHeldSessionHeartbeatSuccess: ProxySessionOwnership["recordHeldSessionHeartbeatSuccess"];
  frontendRegistersTool: ProxyToolCalls["frontendRegistersTool"];
}
