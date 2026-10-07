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
  /** CtrlProxy requests in flight through the owner's clients for this device. */
  inFlightRequests?: number;
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

/**
 * A lease owner's answer to `daemon/relinquishDeviceLease`: its use of the
 * device, and whether it gave the lease up. The owner decides and releases in
 * one synchronous step, so activity it starts afterwards is never taken from
 * under it (#10506 review).
 */
export interface DeviceLeaseRelinquishResult extends DeviceLeaseOwnerStatus {
  released: boolean;
  reason: string;
  transient?: boolean;
}

export type ForwardLeaseRelinquishReport =
  | Exclude<ForwardLeaseOwnerReport, { kind: "status" }>
  | { kind: "relinquish"; result: DeviceLeaseRelinquishResult };

/** Asks a lease owner to give a device's lease up when it no longer uses it. */
export interface ForwardLeaseRelinquishProbe {
  requestRelinquish(socketPath: string, deviceId: string): Promise<ForwardLeaseRelinquishReport>;
}

export type ForwardLeaseReclaimDecision =
  /** The owner released the lease itself; compete for it with an ordinary acquire. */
  | { action: "acquire"; reason: string }
  /**
   * The owner cannot be asked (its socket is unreachable or now served by a
   * different daemon), so take the lease over from it directly.
   */
  | { action: "takeover"; reason: string }
  | {
      action: "refuse";
      reason: string;
      /**
       * The refusal is time-based (recent use, or a busy owner that did not
       * answer) and may lift within the caller's budget, so a readiness wait
       * should retry rather than fail fast (#10485 review).
       */
      transient?: boolean;
    };

export interface ForwardLeaseReclaimInput {
  ownerPid: number;
  metadata: ForwardLeaseOwnerMetadata | undefined;
  report: ForwardLeaseRelinquishReport | undefined;
}

/**
 * Decide how a requester may get a live owner's forwarding lease. A dead owner
 * never reaches here: the lock primitive already reclaims it.
 */
export function decideForwardLeaseReclaim(
  input: ForwardLeaseReclaimInput,
): ForwardLeaseReclaimDecision {
  const { ownerPid, metadata, report } = input;
  if (!metadata || !report) {
    return {
      action: "refuse",
      reason: "the owner records no control socket, so its use of the device cannot be checked",
    };
  }
  switch (report.kind) {
    case "unreachable":
      return {
        action: "takeover",
        reason: `its control socket ${metadata.socketPath} is unreachable (${report.detail})`,
      };
    case "no-response":
    case "unsupported":
      return {
        action: "refuse",
        reason: `its control socket ${metadata.socketPath} could not report lease status (${report.detail})`,
        transient: report.kind === "no-response",
      };
    case "relinquish":
      return decideFromRelinquishResult(ownerPid, metadata, report.result);
  }
}

function decideFromRelinquishResult(
  ownerPid: number,
  metadata: ForwardLeaseOwnerMetadata,
  result: DeviceLeaseRelinquishResult,
): ForwardLeaseReclaimDecision {
  if (result.pid !== ownerPid) {
    return {
      action: "takeover",
      reason: `its control socket ${metadata.socketPath} is now served by PID ${result.pid}, so the owner is orphaned`,
    };
  }
  if (result.released) {
    return { action: "acquire", reason: result.reason };
  }
  return {
    action: "refuse",
    reason: result.reason,
    ...(result.transient === true ? { transient: true } : {}),
  };
}

export type OwnerRelinquishDecision =
  | { release: true; reason: string }
  | { release: false; reason: string; transient?: boolean };

/**
 * The owner-side rule for `daemon/relinquishDeviceLease`: give the lease up
 * only with no live session, tool call, CtrlProxy request or stream on the
 * device and no use within `idleMs`. `idleForMs` already counts the lease
 * acquisition, so an owner that just took the lease is not treated as idle.
 */
export function decideOwnerRelinquish(
  status: DeviceLeaseOwnerStatus,
  idleMs: number,
): OwnerRelinquishDecision {
  if (status.sessionId !== null) {
    return {
      release: false,
      reason: `it has live session ${status.sessionId} on ${status.deviceId}`,
    };
  }
  if (status.activeExecutions > 0) {
    return {
      release: false,
      reason: `it has ${status.activeExecutions} tool call(s) in flight on ${status.deviceId}`,
    };
  }
  if ((status.inFlightRequests ?? 0) > 0) {
    return {
      release: false,
      reason: `it has ${status.inFlightRequests} CtrlProxy request(s) in flight on ${status.deviceId}`,
    };
  }
  if (status.streaming === true) {
    return {
      release: false,
      reason: `a device-data stream subscriber is watching ${status.deviceId}`,
    };
  }
  if (status.idleForMs !== null && status.idleForMs < idleMs) {
    return {
      release: false,
      reason: `it used ${status.deviceId} ${Math.round(Math.max(0, status.idleForMs) / 1000)}s ago`,
      transient: true,
    };
  }
  return { release: true, reason: "it reports no live session or recent activity" };
}
