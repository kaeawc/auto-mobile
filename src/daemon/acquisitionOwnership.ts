import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Whether an acquisition call created the device session it returned, or was
 * handed one that already existed and belongs to an earlier call.
 *
 * Only the acquisition path itself can tell these apart: with device-pool
 * autolock a `getAndroid`/`getApple` call on a connection that already owns a
 * live session is handed that same session back
 * (`DevicePool.reuseOwnedAutolockSession`), and the returned UUID looks
 * identical either way.
 */
export type AcquisitionOwnership = "minted" | "reused";

/**
 * Per-execution channel carrying the disposition above from the acquisition
 * path back to the MCP request handler that invoked it (`src/server/index.ts`),
 * which must release a session a cancelled request minted and must NOT release
 * one it merely reused.
 *
 * It is deliberately NOT part of the tool result: a result-borne marker would
 * have to be stripped again at every wire boundary (the daemon proxy, plan
 * steps that embed a nested acquisition result, `structuredContent`), and one
 * missed strip leaks an internal field to clients.
 *
 * It is deliberately NOT a process-wide registry either: a snapshot or a map
 * keyed by anything coarser than the single execution is stale-prone. Two
 * concurrent same-target acquisitions on one MCP connection interleave — the
 * first mints, the second reuses — so the disposition must be recorded by the
 * call that produced the session, inside that call's own async scope.
 */
export type AcquisitionOwnershipLedger = Map<string, AcquisitionOwnership>;

const acquisitionOwnershipContext = new AsyncLocalStorage<AcquisitionOwnershipLedger>();

/** A ledger for one tool execution. */
export function createAcquisitionOwnershipLedger(): AcquisitionOwnershipLedger {
  return new Map<string, AcquisitionOwnership>();
}

/**
 * Run `fn` with `ledger` as the ambient recording target. A missing ledger runs
 * `fn` unchanged (and leaves any enclosing ledger alone) so non-acquisition
 * calls never install a scope that a nested acquisition could write into.
 */
export async function runWithAcquisitionOwnership<T>(
  ledger: AcquisitionOwnershipLedger | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  return ledger ? acquisitionOwnershipContext.run(ledger, fn) : fn();
}

/**
 * Record how `sessionUuid` came to be owned by the acquisition currently
 * running. A no-op outside an acquisition scope, so pool callers that are not
 * serving a tool call (tests, recovery, direct API use) need no special case.
 */
export function recordAcquisitionOwnership(
  sessionUuid: string,
  ownership: AcquisitionOwnership,
): void {
  acquisitionOwnershipContext.getStore()?.set(sessionUuid, ownership);
}
