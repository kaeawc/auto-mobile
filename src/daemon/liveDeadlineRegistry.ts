import type { ProgressExtendableDeadline } from "./mcpRequestTimeout";

/**
 * In-process side channel that lets a long-running tool call read back the
 * LIVE value of the daemon's own `ProgressExtendableDeadline` for the
 * request it is currently executing (issue #6222 P1 reopen).
 *
 * `UnixSocketServer.handleIdeRequest` extends that deadline as the SAME call
 * emits progress notifications (see `onprogress` there), but that extension
 * is otherwise invisible to the tool handler on the other side of the
 * loopback HTTP call -- it only ever sees the frozen remaining-budget number
 * captured before the request was forwarded
 * (`INTERNAL_MCP_REQUEST_TIMEOUT_PARAM`). The daemon and the MCP HTTP server
 * it forwards to run in the SAME Node process (`Daemon` in `daemon.ts` owns
 * both the Unix socket server and the `createMcpServer`-backed HTTP
 * listener), so this registry shares the actual `ProgressExtendableDeadline`
 * object by reference instead of trying to serialize live updates over HTTP.
 *
 * Lifecycle: the daemon registers its deadline under a fresh key before
 * forwarding a progress-capable `tools/call`, forwards only the key as an
 * internal argument (`INTERNAL_LIVE_DEADLINE_KEY_PARAM`), and unregisters it
 * once the call settles (success, failure, or abandonment). A handler that
 * recognizes the key can read `.value` live at any point during execution.
 */
const registry = new Map<string, ProgressExtendableDeadline>();

/** Register a live deadline under `key`. Overwrites any existing entry for that key. */
export function registerLiveDeadline(key: string, deadline: ProgressExtendableDeadline): void {
  registry.set(key, deadline);
}

/** Remove the entry for `key`, if any. Safe to call more than once (e.g. from a `finally`). */
export function unregisterLiveDeadline(key: string): void {
  registry.delete(key);
}

/**
 * Read the CURRENT absolute deadline (same clock as the registering caller's
 * `Timer`) registered under `key`, or `undefined` when no such entry exists
 * -- either the key is unknown, or the call has already settled and been
 * unregistered.
 */
export function getLiveDeadlineMs(key: string): number | undefined {
  return registry.get(key)?.value;
}
