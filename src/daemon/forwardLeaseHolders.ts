import { join } from "node:path";
import { readExclusiveLockContent, type LockContent } from "../utils/fileLock";
import { isProcessRunning } from "../utils/processLiveness";
import { defaultTimer, type Timer } from "../utils/SystemTimer";
import { errorMessage } from "../utils/describeUnknownError";
import { logger } from "../utils/logger";
import {
  ctrlProxyForwardLeaseDir,
  deviceIdFromCtrlProxyForwardLeaseFileName,
} from "../features/observe/android/CtrlProxyForwardLease";
import {
  decodeForwardLeaseOwnerMetadata,
  type ForwardLeaseOwnerProbe,
  type ForwardLeaseOwnerReport,
} from "../features/observe/shared/ctrlProxyForwardLeaseOwnership";
import { DaemonDeviceLeaseOwnerProbe } from "./deviceLeaseOwnerQuery";
import { sortedReaddirSync } from "../utils/io";

/** One device's CtrlProxy forwarding-lease holder, read from its lock file. */
export interface ForwardLeaseHolder {
  deviceId: string;
  pid: number;
  alive: boolean;
  socketPath?: string;
  acquiredAt?: number;
}

export interface ForwardLeaseHolderSource {
  lockDir(): string;
  listFiles(dir: string): string[];
  readLock(path: string): LockContent | undefined;
  isProcessRunning(pid: number): boolean;
}

export const defaultForwardLeaseHolderSource: ForwardLeaseHolderSource = {
  lockDir: ctrlProxyForwardLeaseDir,
  listFiles: (dir) => sortedReaddirSync(dir),
  readLock: readExclusiveLockContent,
  isProcessRunning: (pid) => isProcessRunning(pid),
};

export function listForwardLeaseHolders(
  source: ForwardLeaseHolderSource = defaultForwardLeaseHolderSource,
): ForwardLeaseHolder[] {
  let dir: string;
  let files: string[];
  try {
    dir = source.lockDir();
    files = source.listFiles(dir);
  } catch (error) {
    logger.warn(`Cannot list CtrlProxy forwarding leases: ${errorMessage(error)}`, error);
    return [];
  }
  return files.flatMap((fileName): ForwardLeaseHolder[] => {
    const deviceId = deviceIdFromCtrlProxyForwardLeaseFileName(fileName);
    const content = deviceId === undefined ? undefined : source.readLock(join(dir, fileName));
    if (deviceId === undefined || !content || Number.isNaN(content.pid)) {
      return [];
    }
    const metadata = decodeForwardLeaseOwnerMetadata(content.metadata);
    return [
      {
        deviceId,
        pid: content.pid,
        alive: source.isProcessRunning(content.pid),
        ...(metadata ? { socketPath: metadata.socketPath, acquiredAt: metadata.acquiredAt } : {}),
      },
    ];
  });
}

function describeOwnerReport(report: ForwardLeaseOwnerReport | undefined): string {
  if (!report) {
    return "session unknown (no socket recorded)";
  }
  switch (report.kind) {
    case "status":
      return report.status.sessionId === null
        ? "no live session"
        : `live session ${report.status.sessionId}`;
    case "unreachable":
      return `socket unreachable (${report.detail})`;
    case "no-response":
    case "unsupported":
      return `session unknown (${report.detail})`;
  }
}

/**
 * `--daemon status` lines for leases held by processes other than `selfPid`
 * (issue #10497): PID, socket, age, and whether the holder has a live session.
 */
export async function describeForeignForwardLeaseHolders(
  selfPid: number | undefined,
  holders: ForwardLeaseHolder[] = listForwardLeaseHolders(),
  probe: ForwardLeaseOwnerProbe = new DaemonDeviceLeaseOwnerProbe(),
  timer: Timer = defaultTimer,
): Promise<string[]> {
  const foreign = holders.filter((holder) => holder.pid !== selfPid);
  const lines = await Promise.all(
    foreign.map(async (holder) => {
      const report =
        holder.alive && holder.socketPath
          ? await probe.query(holder.socketPath, holder.deviceId)
          : undefined;
      const age =
        holder.acquiredAt === undefined
          ? "age unknown"
          : `held ${Math.max(0, Math.round((timer.now() - holder.acquiredAt) / 1000))}s`;
      const state = holder.alive ? describeOwnerReport(report) : "process gone (reclaimable)";
      return (
        `  - ${holder.deviceId}: PID ${holder.pid}, socket ${holder.socketPath ?? "unknown"}, ` +
        `${age}, ${state}`
      );
    }),
  );
  return lines.length === 0
    ? []
    : ["CtrlProxy forwarding leases held by other processes:", ...lines];
}
