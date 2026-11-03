import { runWithToolSelectionContext } from "../../src/features/toolSelection/toolSelectionContext";

/**
 * Run `fn` as a top-level call made for MCP connection `connectionId`, as MCP ingress does
 * (#15663): the connection is the call's autolock identity and the identity its nested calls
 * inherit. `undefined` runs it as a call with no originating connection. `oneShotCli` marks it a
 * one-shot `--cli` call, which acquires anonymously (#11096).
 */
export function asMcpConnection<T>(
  connectionId: string | undefined,
  fn: () => T | Promise<T>,
  { oneShotCli = false }: { oneShotCli?: boolean } = {},
): Promise<T> {
  return runWithToolSelectionContext(
    {
      ...(connectionId === undefined
        ? {}
        : { autolockMcpSessionId: connectionId, callerMcpSessionId: connectionId }),
      ...(oneShotCli ? { oneShotCli: true } : {}),
    },
    async () => await fn(),
  );
}

/** Run `fn` as a top-level one-shot `--cli` call, optionally on connection `connectionId`. */
export function asOneShotCli<T>(fn: () => T | Promise<T>, connectionId?: string): Promise<T> {
  return asMcpConnection(connectionId, fn, { oneShotCli: true });
}

/**
 * Call `fn` with `args` stripped of the daemon's in-band `__mcpSessionId` and `__oneShotCli`,
 * under the connection and one-shot marker they name, as MCP ingress does (#15663). Lets a test
 * keep writing the wire shape.
 */
export function withWireConnection<A extends Record<string, unknown>, T>(
  args: A,
  fn: (args: Omit<A, "__mcpSessionId" | "__oneShotCli">) => T | Promise<T>,
): Promise<T> {
  const { __mcpSessionId: connectionId, __oneShotCli: oneShotCli, ...rest } = args;
  return asMcpConnection(
    typeof connectionId === "string" ? connectionId : undefined,
    () => fn(rest),
    { oneShotCli: oneShotCli === true },
  );
}
