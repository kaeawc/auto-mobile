import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { logger } from "../../utils/logger";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import type { Timer } from "../../utils/SystemTimer";

/**
 * The cache of loopback MCP clients behind the control socket's forwards (#11815): one client per
 * routing key, created on demand, closed when idle. The owner keeps the maps (suites and harnesses
 * set them directly) and injects them with the hooks that tie the pool to the rest of the server,
 * so the creation, supersession and idle-close rules live here as free functions.
 */

export const MCP_CLIENT_IDLE_CLOSE_MS = 5 * 60 * 1000;
export const MCP_SESSION_TERMINATION_TIMEOUT_MS = 2_000;

export type McpClientFactory = (
  boundSessionUuid?: string,
  toolSelectionProfileUuid?: string,
  releasedSessionUuid?: string,
) => Promise<Client>;

export interface LoopbackClientPool {
  clients: Map<string, Client>;
  /** Creations in flight, so concurrent requests for one key share a single client. */
  promises: Map<string, Promise<Client>>;
  idleTimers: Map<string, NodeJS.Timeout>;
  activeForwardCounts: Map<string, number>;
  timer: Timer;
  factory: () => McpClientFactory;
  /** True once the server is closing or its lifecycle generation moved on since `generation`. */
  isSuperseded: (generation: number) => boolean;
  generation: () => number;
  /** Cross-calls go through the owner so its overrides (and test spies) still apply. */
  closeClient: (key: string, client: Client) => Promise<void>;
  clearIdleTimer: (key: string) => void;
  scheduleIdleClose: (key: string) => void;
  resetClient: (key: string, closeMode?: "wait" | "detach") => Promise<void>;
  resetClientIfCurrent: (
    key: string,
    expectedClient: Client,
    closeMode?: "wait" | "detach",
  ) => Promise<boolean>;
  /** The idle timer fired: close the client unless something still needs it. */
  onIdle: (key: string) => Promise<void>;
}

/** Get or create the MCP client for a target key. */
export async function getPooledClient(
  pool: LoopbackClientPool,
  key: string,
  boundSessionUuid?: string,
  toolSelectionProfileUuid?: string,
  releasedSessionUuid?: string,
): Promise<Client> {
  pool.clearIdleTimer(key);

  const existingClient = pool.clients.get(key);
  if (existingClient) {
    return existingClient;
  }

  const existingPromise = pool.promises.get(key);
  if (existingPromise) {
    return existingPromise;
  }

  const generation = pool.generation();
  const clientPromise = pool
    .factory()(boundSessionUuid, toolSelectionProfileUuid, releasedSessionUuid)
    .then(async (client) => {
      if (pool.isSuperseded(generation) || pool.promises.get(key) !== clientPromise) {
        await pool.closeClient(key, client);
        throw new Error("MCP client creation was superseded");
      }
      pool.clients.set(key, client);
      pool.promises.delete(key);
      return client;
    })
    .catch((error) => {
      if (pool.promises.get(key) === clientPromise) {
        pool.promises.delete(key);
      }
      throw error;
    });

  pool.promises.set(key, clientPromise);
  return clientPromise;
}

export async function resetPooledClient(
  pool: LoopbackClientPool,
  key: string,
  closeMode: "wait" | "detach" = "wait",
): Promise<void> {
  pool.clearIdleTimer(key);
  const existingClient = pool.clients.get(key);
  pool.clients.delete(key);
  pool.promises.delete(key);
  if (!existingClient) {
    return;
  }
  const close = Promise.resolve()
    .then(() => pool.closeClient(key, existingClient))
    .catch((error) => {
      logger.warn(`Error closing MCP client for key ${key}:`, error);
    });
  if (closeMode === "wait") {
    await close;
  }
}

export async function closePooledClient(timer: Timer, key: string, client: Client): Promise<void> {
  const transport = client.transport;
  if (transport instanceof StreamableHTTPClientTransport && transport.sessionId) {
    try {
      await raceWithDeadline(transport.terminateSession(), {
        timer,
        timeoutMs: MCP_SESSION_TERMINATION_TIMEOUT_MS,
        label: "MCP session termination",
        timeoutError: () => new Error("MCP session termination timed out"),
      });
    } catch (error) {
      // A failed DELETE is best-effort; closing the local client still releases its resources.
      logger.debug(`Could not terminate MCP session for key ${key}: ${error}`);
    }
  }
  await client.close();
}

export async function resetPooledClientIfCurrent(
  pool: LoopbackClientPool,
  key: string,
  expectedClient: Client,
  closeMode: "wait" | "detach" = "wait",
): Promise<boolean> {
  if (pool.clients.get(key) !== expectedClient) {
    return false;
  }
  await pool.resetClient(key, closeMode);
  return true;
}

// Clean up after a reconnect that blew its deadline without clobbering an
// unrelated request. Two teardown paths, each fenced to what this wait owns:
//   1. If our creation is still the pending one, drop it so a hung factory does
//      not leak; a resolved or superseded creation has already cleared itself.
//   2. When our own creation does resolve, close that specific client only while
//      it remains the cached one — never a replacement another request installed
//      under the same key (issue #5499). Fire-and-forget: the connection may
//      never settle, so the request must not block on it.
export function discardTimedOutReconnect(
  pool: LoopbackClientPool,
  key: string,
  connection: Promise<Client>,
  pendingCreation: Promise<Client> | undefined,
): void {
  if (pendingCreation && pool.promises.get(key) === pendingCreation) {
    pool.promises.delete(key);
  }
  void connection
    .then((client) => pool.resetClientIfCurrent(key, client, "detach"))
    .catch((error) => {
      // Creation was superseded or failed; nothing of ours remains to discard.
      logger.debug(`Timed-out MCP reconnect for key ${key} left nothing to discard: ${error}`);
    });
}

export function schedulePooledIdleClose(pool: LoopbackClientPool, key: string): void {
  pool.clearIdleTimer(key);
  const timer = pool.timer.setTimeout(() => {
    void pool.onIdle(key);
  }, MCP_CLIENT_IDLE_CLOSE_MS);
  pool.idleTimers.set(key, timer);
}

export function clearPooledIdleTimer(pool: LoopbackClientPool, key: string): void {
  const timer = pool.idleTimers.get(key);
  if (!timer) {
    return;
  }
  pool.timer.clearTimeout(timer);
  pool.idleTimers.delete(key);
}

export async function runWithActivePooledClient<T>(
  pool: LoopbackClientPool,
  clientKey: string,
  fn: () => Promise<T>,
): Promise<T> {
  pool.clearIdleTimer(clientKey);
  pool.activeForwardCounts.set(clientKey, (pool.activeForwardCounts.get(clientKey) ?? 0) + 1);
  try {
    return await fn();
  } finally {
    const remainingForClient = (pool.activeForwardCounts.get(clientKey) ?? 1) - 1;
    if (remainingForClient === 0) {
      pool.activeForwardCounts.delete(clientKey);
      // Re-arm the idle close around the whole active-client wrapper. A forward
      // can throw before its own cleanup runs (e.g. the pre-forward queue
      // timeout deadline throws before the forward-body finally), and this
      // wrapper cleared the client's idle timer on entry. Without this re-arm
      // the inactive transport would stay cached until another request or
      // daemon shutdown (issue #4610).
      pool.scheduleIdleClose(clientKey);
    } else {
      pool.activeForwardCounts.set(clientKey, remainingForClient);
    }
  }
}
