import type { DaemonMcpProxyConfig } from "../daemonMcpProxy";
import { defaultIdGenerator } from "../../utils/IdGenerator";
import { getDefaultSessionHeartbeatTimeoutMs } from "../sessionManager";
import { PROXY_HEARTBEAT_INTERVAL_MS } from "../sessionLivenessWindows";

const DAEMON_MCP_HEARTBEAT_INTERVAL_MS = PROXY_HEARTBEAT_INTERVAL_MS;

export function heartbeatIntervalMs(config: DaemonMcpProxyConfig): number {
  const configuredTimeout = config.heartbeatTimeoutMs;
  const configuredInterval = config.heartbeatIntervalMs;
  if (
    configuredTimeout !== undefined &&
    (!Number.isFinite(configuredTimeout) || configuredTimeout <= 0)
  ) {
    throw new Error("heartbeat timeout must be a positive finite number");
  }
  const interval =
    configuredInterval ??
    (configuredTimeout === undefined
      ? DAEMON_MCP_HEARTBEAT_INTERVAL_MS
      : Math.max(1, Math.floor(configuredTimeout / 2)));
  if (!Number.isFinite(interval) || interval <= 0) {
    throw new Error("heartbeat interval must be a positive finite number");
  }
  return Math.max(1, interval);
}

/** The heartbeat request timeout: how long a heartbeat is given before it counts as unanswered. */
export function heartbeatRequestTimeoutMs(leaseMs: number, intervalMs: number): number {
  return Math.max(1, Math.min(Math.floor(leaseMs / 2), intervalMs * 2));
}

/** The harness-supplied stable owner token when given, otherwise a per-process one (#10050). */
export function resolveLivenessOwnerToken(config: DaemonMcpProxyConfig): string {
  const suppliedToken = config.livenessOwnerToken?.trim();
  return suppliedToken ? suppliedToken : (config.idGenerator ?? defaultIdGenerator).next();
}

/** The harness-supplied stable owner token, or undefined when this proxy minted its own. */
export function stableLivenessOwnerToken(config: DaemonMcpProxyConfig): string | undefined {
  const suppliedToken = config.livenessOwnerToken?.trim();
  return suppliedToken ? suppliedToken : undefined;
}

/** The heartbeat lease the proxy believes the daemon enforces on the sessions it holds. */
export function heartbeatLeashMs(config: DaemonMcpProxyConfig): number {
  return config.heartbeatTimeoutMs ?? getDefaultSessionHeartbeatTimeoutMs();
}
