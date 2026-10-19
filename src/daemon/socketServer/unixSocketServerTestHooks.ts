import type { DaemonRequest } from "../types";
import type { McpForwardRoute } from "./McpForwardRouter";

/**
 * Typed view of the MCP forward-routing internals that daemon integration tests drive directly
 * (`socket.testHooks`). It replaces casts into the server's private members; production code
 * never reads it.
 */
export interface UnixSocketServerTestHooks {
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
}
