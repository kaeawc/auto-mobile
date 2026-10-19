import { AsyncLocalStorage } from "node:async_hooks";
import type { Client } from "@modelcontextprotocol/client";

/**
 * The socket session id of the MCP forward being opened (#4678, #11820). The forward's client
 * factory keeps the seam's signature (the bound, profile and released sessions), so the session
 * key that names the forward's caller travels with the async call chain instead.
 */
const forwardSessionKey = new AsyncLocalStorage<{
  readonly sessionKey: string;
  readonly taskOwnerKey?: string;
}>();

/**
 * Run `fn` so the forward client it opens is keyed on `sessionKey`. `taskOwnerKey` names the
 * stdio proxy that owns the forward's MCP tasks (#4668), when the frame relayed the extension.
 */
export function runWithForwardSessionKey<T>(
  sessionKey: string,
  fn: () => Promise<T>,
  taskOwnerKey?: string,
): Promise<T> {
  return forwardSessionKey.run(
    { sessionKey, ...(taskOwnerKey !== undefined && { taskOwnerKey }) },
    fn,
  );
}

/** The session key of the forward being opened on this async call chain, if any. */
export function currentForwardSessionKey(): string | undefined {
  return forwardSessionKey.getStore()?.sessionKey;
}

/** The task owner key of the forward being opened on this async call chain, if any. */
export function currentForwardTaskOwnerKey(): string | undefined {
  return forwardSessionKey.getStore()?.taskOwnerKey;
}

/** The slice of the loopback MCP client a forward uses; the SDK `Client` satisfies it. */
export type ForwardMcpClient = Pick<
  Client,
  | "callTool"
  | "request"
  | "listTools"
  | "listResources"
  | "readResource"
  | "listResourceTemplates"
  | "close"
>;

/** Opens the MCP client one control-socket forward runs through; closed when the forward ends. */
export type McpClientFactory = (
  boundSessionUuid?: string,
  toolSelectionProfileUuid?: string,
  releasedSessionUuid?: string,
) => Promise<ForwardMcpClient>;

/**
 * How long an execution key may stay unused before its cached per-device helpers (the append
 * helper's API-level probe) are dropped.
 */
export const FORWARD_KEY_IDLE_MS = 5 * 60 * 1000;
