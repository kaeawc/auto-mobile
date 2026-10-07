import { z } from "zod";
import { logger } from "../../../utils/logger";

/**
 * Ownership metadata and stale-owner policy for the cross-process CtrlProxy
 * forwarding lease (issue #10497).
 *
 * The lease is a per-device lock file holding the owner PID and token. A daemon
 * owner also records its control socket so another AutoMobile process can ask
 * it whether it still uses the device, and take the lease over when it does not.
 */

/** Line-3 metadata a daemon writes into its forwarding-lease lock file. */
export interface ForwardLeaseOwnerMetadata {
  socketPath: string;
  acquiredAt: number;
}

const ownerMetadataSchema = z.object({
  socketPath: z.string().min(1),
  acquiredAt: z.number().finite(),
});

export function encodeForwardLeaseOwnerMetadata(metadata: ForwardLeaseOwnerMetadata): string {
  // JSON.stringify never emits a raw newline, so the value stays on line 3.
  return JSON.stringify(metadata);
}

export function decodeForwardLeaseOwnerMetadata(
  raw: string | undefined,
): ForwardLeaseOwnerMetadata | undefined {
  if (!raw) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    // Older builds write no metadata; an unparseable line is treated the same.
    logger.debug(`[CTRL_PROXY] Ignoring unparseable forwarding-lease metadata: ${error}`);
    return undefined;
  }
  const result = ownerMetadataSchema.safeParse(parsed);
  return result.success ? result.data : undefined;
}

let ownerSocketPath: string | undefined;

/**
 * Register this process's daemon control socket. Only a daemon registers one:
 * a process without a socket writes no metadata, so a requester cannot query
 * it and keeps the pre-#10497 refusal.
 */
export function setCtrlProxyForwardLeaseOwnerSocketPath(socketPath: string | undefined): void {
  ownerSocketPath = socketPath;
}

export function getCtrlProxyForwardLeaseOwnerSocketPath(): string | undefined {
  return ownerSocketPath;
}

/** Idle period after which a daemon gives up a device's forwarding lease. */
export const DEFAULT_CTRL_PROXY_FORWARD_LEASE_IDLE_MS = 60_000;
export const CTRL_PROXY_FORWARD_LEASE_IDLE_MS_ENV = "AUTOMOBILE_CTRL_PROXY_LEASE_IDLE_MS";

export function resolveCtrlProxyForwardLeaseIdleMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[CTRL_PROXY_FORWARD_LEASE_IDLE_MS_ENV];
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CTRL_PROXY_FORWARD_LEASE_IDLE_MS;
}

/** What a lease owner reports about one device over `daemon/deviceLeaseStatus`. */
export interface DeviceLeaseOwnerStatus {
  pid: number;
  deviceId: string;
  /** The owner's live session on this device, if any. */
  sessionId: string | null;
  /** Tool executions currently bound to this device in the owner. */
  activeExecutions: number;
  /** Whether a device-data stream subscriber (e.g. the IDE plugin) watches this device. */
  streaming?: boolean;
  /** Time since the owner's last tool activity on this device; null when it has none. */
  idleForMs: number | null;
}

export type ForwardLeaseOwnerReport =
  /** Nothing accepted a connection on the owner's socket. */
  | { kind: "unreachable"; detail: string }
  /** The socket accepted but did not answer in time; the owner may be busy. */
  | { kind: "no-response"; detail: string }
  /** The owner answered but cannot report lease status (older build, not initialized). */
  | { kind: "unsupported"; detail: string }
  | { kind: "status"; status: DeviceLeaseOwnerStatus };

/** Queries a lease owner's control socket. Injected so tests need no real socket. */
export interface ForwardLeaseOwnerProbe {
  query(socketPath: string, deviceId: string): Promise<ForwardLeaseOwnerReport>;
}

export type ForwardLeaseReclaimDecision =
  | { action: "reclaim"; reason: string }
  | { action: "refuse"; reason: string };

export interface ForwardLeaseReclaimInput {
  ownerPid: number;
  metadata: ForwardLeaseOwnerMetadata | undefined;
  report: ForwardLeaseOwnerReport | undefined;
  idleMs: number;
}

/**
 * Decide whether a requester may take a live owner's forwarding lease. A dead
 * owner never reaches here: the lock primitive already reclaims it.
 */
export function decideForwardLeaseReclaim(
  input: ForwardLeaseReclaimInput,
): ForwardLeaseReclaimDecision {
  const { ownerPid, metadata, report, idleMs } = input;
  if (!metadata || !report) {
    return {
      action: "refuse",
      reason: "the owner records no control socket, so its use of the device cannot be checked",
    };
  }
  switch (report.kind) {
    case "unreachable":
      return {
        action: "reclaim",
        reason: `its control socket ${metadata.socketPath} is unreachable (${report.detail})`,
      };
    case "no-response":
    case "unsupported":
      return {
        action: "refuse",
        reason: `its control socket ${metadata.socketPath} could not report lease status (${report.detail})`,
      };
    case "status":
      return decideFromOwnerStatus(ownerPid, metadata, report.status, idleMs);
  }
}

function decideFromOwnerStatus(
  ownerPid: number,
  metadata: ForwardLeaseOwnerMetadata,
  status: DeviceLeaseOwnerStatus,
  idleMs: number,
): ForwardLeaseReclaimDecision {
  if (status.pid !== ownerPid) {
    return {
      action: "reclaim",
      reason: `its control socket ${metadata.socketPath} is now served by PID ${status.pid}, so the owner is orphaned`,
    };
  }
  if (status.sessionId !== null) {
    return {
      action: "refuse",
      reason: `it has live session ${status.sessionId} on ${status.deviceId}`,
    };
  }
  if (status.activeExecutions > 0) {
    return {
      action: "refuse",
      reason: `it has ${status.activeExecutions} tool call(s) in flight on ${status.deviceId}`,
    };
  }
  if (status.streaming === true) {
    return {
      action: "refuse",
      reason: `a device-data stream subscriber is watching ${status.deviceId}`,
    };
  }
  if (status.idleForMs !== null && status.idleForMs < idleMs) {
    return {
      action: "refuse",
      reason: `it used ${status.deviceId} ${Math.round(status.idleForMs / 1000)}s ago`,
    };
  }
  return { action: "reclaim", reason: `it reports no live session or recent activity` };
}
