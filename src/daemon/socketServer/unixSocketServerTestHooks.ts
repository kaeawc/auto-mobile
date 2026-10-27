import type { SocketServerInputTestHooks } from "./socketServerInputTestHooks";
import type { SocketServerOperations } from "../socketServerParts/socketServerOperations";
import type { SocketServerRuntime } from "../socketServerParts/SocketServerRuntime";
import type { DaemonRequest } from "../types";
import type { ListChangedKind, McpForwardRoute } from "../socketServer";
import type { InterceptableMethod } from "../interceptableMethod";
import type { ProgressExtendableDeadline } from "../mcpRequestTimeout";

/**
 * Typed view of the MCP forward-routing internals that daemon integration tests drive directly
 * (`socket.testHooks`). It replaces casts into the server's private members; production code
 * never reads it.
 */
export interface UnixSocketServerTestHooks {
  readonly ide: Pick<
    SocketServerOperations,
    | "requireFeatureFlagService"
    | "assertBrokerConnectionHostMutation"
    | "assertBrokerConnectionControl"
    | "resolveIdeActionDevices"
    | "assertSocketToolEnabled"
    | "handleIdeSocketRequest"
    | "handleIdeRequest"
  >;
  readonly transport: Pick<
    SocketServerOperations,
    | "processSocketRequestLine"
    | "broadcastSessionDeviceRebound"
    | "writeTerminalSocketResponse"
    | "handleConnection"
    | "handleRequest"
  >;
  /** Live per-connection state; tests read the connection ids of sockets they open. */
  readonly sessions: SocketServerRuntime["sessions"];
  /** Whether the server admits requests; tests open it without starting a listener. */
  acceptingRequests: boolean;
  readonly routing: Pick<SocketServerOperations, "getToolsCallForwardRoute">;
  readonly input: SocketServerInputTestHooks;
  readonly release: Pick<
    SocketServerOperations,
    "admitReleasedBoundSession" | "broadcastSessionReleased"
  >;
  restoreSelectorSessions(args: unknown, socketSessionId: string): Promise<void>;
  getMcpForwardRoute(
    request: DaemonRequest,
    socketSessionId: string,
  ): McpForwardRoute | Promise<McpForwardRoute>;
  withSocketSessionAutolockKey(args: unknown, socketSessionId: string, timeoutMs: number): unknown;
  recordBoundMcpClientKey(
    request: DaemonRequest,
    socketSessionId: string,
    route: McpForwardRoute,
    sessionWasActiveBeforeForward: boolean,
    response: unknown,
  ): void;
  /** The MCP client key a socket session is currently bound to, if any. */
  boundMcpClientFor(
    socketSessionId: string,
  ): ReturnType<SocketServerRuntime["boundMcpClientKeysBySocketSession"]["get"]>;
  requireCurrentFrameContext(deviceId: string, frameContext: string, action: string): void;
  broadcastListChanged: InterceptableMethod<(kind: ListChangedKind) => void>;
  /** The startup gate every forwarded request waits on; tests intercept it to hold a request mid-gate. */
  readonly waitForStartup: InterceptableMethod<
    (
      request: DaemonRequest,
      deadline: ProgressExtendableDeadline,
      signal: AbortSignal,
    ) => Promise<void>
  >;
}
