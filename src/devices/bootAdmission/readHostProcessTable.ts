import type { HostCommandExecutor } from "../../utils/HostCommandExecutor";
import type { HostProcessRow } from "../../models/HostProcessRow";
import { PS_SNAPSHOT_ARGS, PS_SNAPSHOT_MAX_BUFFER_BYTES, parsePsSnapshot } from "./psSnapshot";

export interface HostReadOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * One read-only `ps` snapshot of the host process table. Shared by the iOS
 * fleet cost source and the Android boot admission source (#11181), so the
 * host's single `ps` call site stays here.
 */
export async function readHostProcessTable(
  executor: HostCommandExecutor,
  options: HostReadOptions = {},
): Promise<HostProcessRow[]> {
  const ps = await executor.executeCommand("ps", PS_SNAPSHOT_ARGS, {
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    maxBuffer: PS_SNAPSHOT_MAX_BUFFER_BYTES,
  });
  const { rows, skipped } = parsePsSnapshot(ps.stdout);
  if (rows.length === 0) {
    throw new Error(`ps returned no parseable processes (${skipped} unparseable rows)`);
  }
  return rows;
}
