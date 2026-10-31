import { createServer, Server as NetServer, Socket } from "node:net";
import { existsSync, unlinkSync } from "node:fs";
import { unlink } from "node:fs/promises";
import path from "node:path";
import {
  DaemonSocketReachability,
  type DaemonSocketReachabilityLike,
} from "../client/daemonSocketReachability";
import { AuxiliarySocketBindConflict } from "../auxiliarySocketAvailability";
import { AuxiliarySocketOwner } from "../auxiliarySocketOwner";
import {
  classifySocketPath,
  readSocketFileIdentity,
  statFileIdentity,
  type SocketFileIdentity,
  type SocketPathFs,
} from "../socketFileIdentity";
import { decideStaleAuxSocketReclaim } from "../staleAuxSocketReclaim";
import { errorMessage } from "../../utils/describeUnknownError";
import { ActionableError } from "../../models/ActionableError";
import { logger } from "../../utils/logger";
import { Timer, defaultTimer } from "../../utils/SystemTimer";
import { ensureSecureDir, secureFile } from "../../utils/filesystem/securePermissions";
import { AUX_SOCKET_MAX_FRAME_BYTES, LineFramer } from "../wire/LineFramer";
import { DEFAULT_SOCKET_IDLE_TIMEOUT_MS } from "./SocketServerTypes";

/** Open connections across every auxiliary socket server in this process. */
const liveAuxConnections = new Set<Socket>();
/** Connections ever accepted across every auxiliary socket server in this process. */
let auxConnectionsAccepted = 0;

/**
 * Clients (stream subscribers, recorders, IDE plugins) connected to any
 * auxiliary daemon socket, for the orphaned private-daemon watchdog (#10497).
 */
export function getLiveAuxSocketConnectionCount(): number {
  return liveAuxConnections.size;
}

/** Monotonic count of auxiliary-socket connections accepted by this process. */
export function getAcceptedAuxSocketConnectionCount(): number {
  return auxConnectionsAccepted;
}

export const AUX_SOCKET_BIND_LIVENESS_PROBE_TIMEOUT_MS = 1_000;

/** How a socket server probes a socket left at its path, and records the socket it binds. */
export interface SocketBindOwnership {
  socketReachability?: DaemonSocketReachabilityLike;
  socketOwner?: AuxiliarySocketOwner;
}

/**
 * Abstract base class for Unix domain socket servers.
 * Handles common functionality: socket lifecycle, line protocol, connection management.
 */
export abstract class BaseSocketServer {
  protected server: NetServer | null = null;
  protected readonly platform: NodeJS.Platform = process.platform;
  protected readonly socketPathFs: SocketPathFs = { exists: existsSync, stat: statFileIdentity };
  // Identity of the socket inode this server created, so close() never unlinks a
  // socket a successor process has already rebound at the same path.
  private socketFileIdentity: SocketFileIdentity | null = null;
  protected readonly socketPath: string;
  protected readonly timer: Timer;
  protected readonly serverName: string;
  protected readonly idleTimeoutMs: number;
  /** Largest inbound frame (bytes, newline excluded) a peer may send on this server. */
  protected readonly maxFrameBytes: number = AUX_SOCKET_MAX_FRAME_BYTES;
  private readonly socketReachability: DaemonSocketReachabilityLike;
  private readonly socketOwner: AuxiliarySocketOwner;

  constructor(
    socketPath: string,
    timer: Timer = defaultTimer,
    serverName: string = "Socket",
    {
      idleTimeoutMs = DEFAULT_SOCKET_IDLE_TIMEOUT_MS,
      socketReachability = new DaemonSocketReachability(),
      socketOwner = new AuxiliarySocketOwner(),
    }: SocketBindOwnership & { idleTimeoutMs?: number } = {},
  ) {
    this.socketPath = socketPath;
    this.timer = timer;
    this.serverName = serverName;
    this.idleTimeoutMs = idleTimeoutMs;
    this.socketReachability = socketReachability;
    this.socketOwner = socketOwner;
  }

  /**
   * Start the socket server.
   */
  async start(): Promise<void> {
    const directory = path.dirname(this.socketPath);
    // Owner-only (0o700) so the control socket is not world-traversable. On macOS
    // socket-file permission bits are not reliably enforced on connect(), so the
    // containing directory's mode is the primary access control (issue #4750).
    await ensureSecureDir(directory);

    await this.reclaimExistingSocketBeforeBind();

    this.server = createServer((socket) => {
      this.handleConnection(socket);
    });

    return new Promise((resolve, reject) => {
      this.server!.listen(this.socketPath, () => {
        logger.info(`[${this.serverName}] Socket listening on ${this.socketPath}`);
        this.socketFileIdentity = this.readSocketFileIdentity();
        // Restrict the bound socket to the owner (0o600) before start() resolves,
        // so no client can connect while it is still world-accessible. listen()
        // creates the socket at the umask default (issue #4750).
        secureFile(this.socketPath)
          .then(() => {
            if (this.socketFileIdentity) {
              try {
                this.socketOwner.publish(this.socketPath, this.serverName, this.socketFileIdentity);
              } catch (error) {
                // Advisory holder metadata must not disable an already-bound socket.
                logger.warn(
                  `[${this.serverName}] Unable to publish socket owner: ${errorMessage(error)}`,
                  error,
                );
              }
            }
            this.onServerStarted();
            resolve();
          })
          .catch(reject);
      });

      this.server!.on("error", (error) => {
        logger.error(`[${this.serverName}] Socket error: ${error}`);
        reject(error);
      });
    });
  }

  /**
   * Auxiliary sockets use a reachability probe before reclaiming a stale path
   * (issue #6543). Unlike the control socket's #6232 guard, they do not use
   * the shared PID record or create a bind lock for every stream socket.
   */
  private async reclaimExistingSocketBeforeBind(): Promise<void> {
    const decision = await decideStaleAuxSocketReclaim({
      socketPath: this.socketPath,
      platform: this.platform,
      reachability: this.socketReachability,
      probeTimeoutMs: AUX_SOCKET_BIND_LIVENESS_PROBE_TIMEOUT_MS,
      fs: this.socketPathFs,
    });
    if (decision === "absent") {
      return;
    }
    if (decision === "held") {
      throw this.socketOwner.conflict(this.socketPath, this.serverName);
    }
    if (decision === "unknown") {
      throw new AuxiliarySocketBindConflict(this.socketPath, this.serverName, "unverified");
    }
    if (decision === "conflict") {
      throw new AuxiliarySocketBindConflict(this.socketPath, this.serverName);
    }
    // Unlink synchronously without another event-loop yield after the decision, so the
    // identity check (POSIX) or the second probe (Windows) is as fresh as possible.

    try {
      unlinkSync(this.socketPath);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        // The path disappeared after the probe; there is nothing left to reclaim.
        logger.debug(
          `[${this.serverName}] Auxiliary socket path already removed: ${this.socketPath}`,
        );
        return;
      }
      throw new ActionableError(
        `[${this.serverName}] Unable to reclaim auxiliary socket ${this.socketPath} before binding`,
        { cause: error },
      );
    }
  }

  /**
   * Stop the socket server.
   */
  async close(): Promise<void> {
    this.onServerClosing();

    if (!this.server) {
      return;
    }

    // Decide ownership BEFORE closing. A unix-socket server's close() unlinks the
    // path it listens on, so if a successor process has already rebound this path
    // (fast restart) we must NOT close — that would remove their socket and sever
    // live subscribers (e.g. IDE-plugin observation streams). Instead unref and
    // leave the dead listener for process teardown.
    const state = classifySocketPath(this.socketFileIdentity, this.socketPath);
    const ownsSocketPath = state === "owned";

    if (ownsSocketPath) {
      this.socketOwner.remove(this.socketPath);
    }

    if (state !== "replaced") {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
    } else {
      logger.warn(
        `[${this.serverName}] Socket path ${this.socketPath} no longer belongs to this server; leaving listener for process teardown`,
      );
      this.server.unref();
    }
    this.server = null;

    if (ownsSocketPath && existsSync(this.socketPath)) {
      await unlink(this.socketPath);
    }
    this.socketFileIdentity = null;
  }

  private readSocketFileIdentity(): SocketFileIdentity | null {
    return readSocketFileIdentity(this.socketPath);
  }

  /**
   * Check if the server is listening.
   */
  isListening(): boolean {
    return this.server?.listening ?? false;
  }

  /**
   * Return the concrete Unix socket path this server was created with.
   */
  getSocketPath(): string {
    return this.socketPath;
  }

  /**
   * Return true while the socket path is owned or its identity cannot be verified.
   * A listening Unix server whose path was unlinked or replaced is
   * still alive for existing connections, but new clients cannot reach it there.
   */
  hasActiveSocketPath(): boolean {
    const state = classifySocketPath(this.socketFileIdentity, this.socketPath);
    return state === "owned" || state === "unverifiable";
  }

  /**
   * Handle a new connection. Sets up line-based protocol.
   */
  protected handleConnection(socket: Socket): void {
    const framer = new LineFramer(this.maxFrameBytes, {
      onLine: (line) => {
        if (line.trim()) {
          this.processLine(socket, line).catch((error) => {
            logger.error(`[${this.serverName}] Request error: ${error}`);
          });
        }
      },
      onOverflow: () => {
        logger.warn(
          `[${this.serverName}] Inbound frame exceeded ${this.maxFrameBytes} bytes, rejecting connection`,
        );
        this.onFrameOverflow(socket);
      },
    });

    if (this.idleTimeoutMs > 0 && typeof socket.setTimeout === "function") {
      socket.setTimeout(this.idleTimeoutMs);
      socket.on("timeout", () => {
        logger.warn(
          `[${this.serverName}] Idle timeout after ${this.idleTimeoutMs}ms, destroying socket`,
        );
        socket.destroy();
      });
    }

    socket.on("data", (data) => {
      framer.push(data);
    });

    socket.on("error", (error) => {
      logger.error(`[${this.serverName}] Connection error: ${error}`);
      this.onConnectionError(socket, error);
    });

    liveAuxConnections.add(socket);
    auxConnectionsAccepted++;
    socket.on("close", () => {
      liveAuxConnections.delete(socket);
      this.onConnectionClose(socket);
    });

    this.onConnectionEstablished(socket);
  }

  /**
   * Called once when a peer's pending inbound frame exceeds `maxFrameBytes`.
   * The default drops the connection; request/response servers answer first.
   */
  protected onFrameOverflow(socket: Socket): void {
    socket.destroy();
  }

  /**
   * Process a single line of input. Subclasses implement this.
   */
  protected abstract processLine(socket: Socket, line: string): Promise<void>;

  /**
   * Called when the server starts. Override for custom initialization.
   */
  protected onServerStarted(): void {
    // Default: no-op
  }

  /**
   * Called before the server closes. Override for custom cleanup.
   */
  protected onServerClosing(): void {
    // Default: no-op
  }

  /**
   * Called when a connection is established. Override for custom handling.
   */
  protected onConnectionEstablished(_socket: Socket): void {
    // Default: no-op
  }

  /**
   * Called when a connection error occurs. Override for custom handling.
   */
  protected onConnectionError(_socket: Socket, _error: Error): void {
    // Default: no-op
  }

  /**
   * Called when a connection closes. Override for custom handling.
   */
  protected onConnectionClose(_socket: Socket): void {
    // Default: no-op
  }

  /** Returns `socket.write()` result so callers can react to backpressure; `false` if destroyed. */
  protected sendJson(socket: Socket, data: unknown): boolean {
    if (socket.destroyed) {
      return false;
    }
    return socket.write(JSON.stringify(data) + "\n");
  }

  /**
   * Parse JSON from a line, returning null if invalid.
   */
  protected parseJson<T>(line: string): T | null {
    try {
      return JSON.parse(line) as T;
    } catch (error) {
      // A malformed or partial line (e.g. from a client disconnecting mid-write)
      // is not actionable here; the caller drops it and waits for the next line.
      logger.debug(
        `src/daemon/socketServer/BaseSocketServer.ts line parse failed: ${error}`,
        error,
      );
      return null;
    }
  }
}
