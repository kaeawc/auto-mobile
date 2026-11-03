import { runWithToolSelectionContext } from "../../src/features/toolSelection/toolSelectionContext";

/**
 * Run `fn` as a top-level call made for MCP connection `connectionId`, as MCP ingress does
 * (#15663): the connection is the call's autolock identity and the identity its nested calls
 * inherit. `undefined` runs it as a call with no originating connection.
 */
export function asMcpConnection<T>(
  connectionId: string | undefined,
  fn: () => T | Promise<T>,
): Promise<T> {
  return runWithToolSelectionContext(
    connectionId === undefined
      ? {}
      : { autolockMcpSessionId: connectionId, callerMcpSessionId: connectionId },
    async () => await fn(),
  );
}

/**
 * Call `fn` with `args` stripped of the daemon's in-band `__mcpSessionId`, under the connection it
 * names, as MCP ingress does (#15663). Lets a test keep writing the wire shape.
 */
export function withWireConnection<A extends Record<string, unknown>, T>(
  args: A,
  fn: (args: Omit<A, "__mcpSessionId">) => T | Promise<T>,
): Promise<T> {
  const { __mcpSessionId: connectionId, ...rest } = args;
  return asMcpConnection(typeof connectionId === "string" ? connectionId : undefined, () =>
    fn(rest),
  );
}
