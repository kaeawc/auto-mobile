import { createServer, Server as NetServer, Socket } from "node:net";
import { existsSync, statSync } from "node:fs";
import { unlink } from "node:fs/promises";
import path from "node:path";
import { logger } from "../../utils/logger";
import { Timer, defaultTimer } from "../../utils/SystemTimer";
import { ensureSecureDir, secureFile } from "../../utils/filesystem/securePermissions";
import { DEFAULT_SOCKET_IDLE_TIMEOUT_MS } from "./SocketServerTypes";

/**
 * Abstract base class for Unix domain socket servers.
 * Handles common functionality: socket lifecycle, line protocol, connection management.
 */
export abstract class BaseSocketServer {
  protected server: NetServer | null = null;
  // Identity of the socket inode this server created, so close() never unlinks a
  // socket a successor process has already rebound at the same path.
  private socketFileIdentity: { dev: number; ino: number } | null = null;
  protected readonly socketPath: string;
  protected readonly timer: Timer;
  protected readonly serverName: string;
  protected readonly idleTimeoutMs: number;

  constructor(
    socketPath: string,
    timer: Timer = defaultTimer,
    serverName: string = "Socket",
    idleTimeoutMs: number = DEFAULT_SOCKET_IDLE_TIMEOUT_MS
  ) {
    this.socketPath = socketPath;
    this.timer = timer;
    this.serverName = serverName;
    this.idleTimeoutMs = idleTimeoutMs;
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

    if (existsSync(this.socketPath)) {
      await unlink(this.socketPath);
    }

    this.server = createServer(socket => {
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
            this.onServerStarted();
            resolve();
          })
          .catch(reject);
      });

      this.server!.on("error", error => {
        logger.error(`[${this.serverName}] Socket error: ${error}`);
        reject(error);
      });
    });
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
    const ownsSocketPath = this.isOwnedSocketFile();

    if (ownsSocketPath || !existsSync(this.socketPath)) {
      await new Promise<void>(resolve => {
        this.server!.close(() => resolve());
      });
    } else {
      logger.warn(
        `[${this.serverName}] Socket path ${this.socketPath} no longer belongs to this server; leaving listener for process teardown`
      );
      this.server.unref();
    }
    this.server = null;

    if (ownsSocketPath && existsSync(this.socketPath)) {
      await unlink(this.socketPath);
    }
    this.socketFileIdentity = null;
  }

  private readSocketFileIdentity(): { dev: number; ino: number } | null {
    try {
      const stats = statSync(this.socketPath);
      return { dev: stats.dev, ino: stats.ino };
    } catch (error) {
      // The socket file may already be gone (e.g. removed by another process);
      // returning null lets ownership checks treat it as "not our socket".
      logger.debug(`src/daemon/socketServer/BaseSocketServer.ts stat failed: ${error}`, error);
      return null;
    }
  }

  private isOwnedSocketFile(): boolean {
    if (!this.socketFileIdentity || !existsSync(this.socketPath)) {
      return false;
    }
    const currentIdentity = this.readSocketFileIdentity();
    return currentIdentity?.dev === this.socketFileIdentity.dev &&
      currentIdentity.ino === this.socketFileIdentity.ino;
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
   * Return true only while this server is listening through the same socket file
   * it created. A listening Unix server whose path was unlinked or replaced is
   * still alive for existing connections, but new clients cannot reach it there.
   */
  hasActiveSocketPath(): boolean {
    return this.isOwnedSocketFile();
  }

  /**
   * Handle a new connection. Sets up line-based protocol.
   */
  protected handleConnection(socket: Socket): void {
    let buffer = "";

    if (this.idleTimeoutMs > 0 && typeof socket.setTimeout === "function") {
      socket.setTimeout(this.idleTimeoutMs);
      socket.on("timeout", () => {
        logger.warn(
          `[${this.serverName}] Idle timeout after ${this.idleTimeoutMs}ms, destroying socket`
        );
        socket.destroy();
      });
    }

    socket.on("data", data => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.trim()) {
          this.processLine(socket, line).catch(error => {
            logger.error(`[${this.serverName}] Request error: ${error}`);
          });
        }
      }
    });

    socket.on("error", error => {
      logger.error(`[${this.serverName}] Connection error: ${error}`);
      this.onConnectionError(socket, error);
    });

    socket.on("close", () => {
      this.onConnectionClose(socket);
    });

    this.onConnectionEstablished(socket);
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
      logger.debug(`src/daemon/socketServer/BaseSocketServer.ts line parse failed: ${error}`, error);
      return null;
    }
  }
}
