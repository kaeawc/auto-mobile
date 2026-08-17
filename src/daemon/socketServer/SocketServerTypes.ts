import { Socket } from "node:net";

/**
 * Base request interface for socket servers.
 * The id field is optional for servers that don't need request correlation.
 */
export interface SocketRequest {
  id?: string;
}

/**
 * Base response interface for socket servers.
 * The id field is optional for servers that don't need request correlation.
 */
export interface SocketResponse {
  id?: string;
  success: boolean;
  error?: string;
}

/**
 * Configuration for socket server paths.
 */
export interface SocketServerConfig {
  /** Socket path used by the daemon and clients. */
  defaultPath: string;
}

/**
 * Subscriber info for push-based socket servers.
 */
export interface Subscriber<TFilter = unknown> {
  socket: Socket;
  subscriptionId: string;
  lastActivity: number;
  filter: TFilter;
  /** When true, this subscriber is receiving backfill data and should be skipped by live pushes. */
  backfilling: boolean;
  /** Guards against stacking multiple `'drain'` listeners when the socket stays backpressured. */
  drainPending: boolean;
}

/**
 * Subscription command for push servers.
 */
export interface SubscriptionCommand {
  id: string;
  command: "subscribe" | "unsubscribe" | "update_cadence" | "pong";
  /** Server-minted subscription identity for subscription-scoped operations. */
  subscriptionId?: string;
}

/**
 * Keepalive configuration for push servers.
 */
export interface KeepaliveConfig {
  /** Interval between keepalive pings in milliseconds */
  intervalMs: number;
  /** Time without activity before considering subscriber dead */
  timeoutMs: number;
}

/**
 * Default keepalive configuration.
 */
export const DEFAULT_KEEPALIVE_CONFIG: KeepaliveConfig = {
  intervalMs: 10_000,
  timeoutMs: 30_000,
};

/** Idle I/O timeout after which `BaseSocketServer` destroys an accepted socket to release its FD. */
export const DEFAULT_SOCKET_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Get the socket path based on environment mode.
 */
export function getSocketPath(config: SocketServerConfig): string {
  return config.defaultPath;
}
