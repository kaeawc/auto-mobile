import { createConnection, Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { platform } from "node:os";
import { logger } from "../utils/logger";
import { ActionableError } from "../models";
import { DaemonRequest, DaemonResponse } from "./types";
import {
  SOCKET_PATH,
  CONNECTION_TIMEOUT_MS,
} from "./constants";
import { resolveMcpRequestTimeoutMs } from "./mcpRequestTimeout";
import { McpTimeoutError } from "./McpTimeoutError";
import { type Timer, defaultTimer } from "../utils/SystemTimer";
import {
  cleanupStaleDaemonFilesForDeadPidSync,
  getDaemonSocketPaths,
  type StaleDaemonFileCleanupOptions,
} from "./daemonFiles";

/**
 * Custom error thrown when daemon is unavailable
 */
export class DaemonUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DaemonUnavailableError";
  }
}

export interface DaemonClientRecoveryOptions extends StaleDaemonFileCleanupOptions {}

/**
 * CLI Client for communicating with the daemon via Unix socket
 *
 * Responsibilities:
 * - Check if daemon is available
 * - Connect to daemon via Unix socket
 * - Send tool call requests
 * - Receive and parse responses
 * - Handle timeouts and errors
 */
export class DaemonClient {
  private socket: Socket | null = null;
  private socketPath: string;
  private connectionTimeout: number;
  private timer: Timer;
  private pendingRequests: Map<string, {
    resolve: (value: DaemonResponse) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  }> = new Map();
  private buffer: string = "";
  private connected: boolean = false;
  private recoveryOptions: DaemonClientRecoveryOptions;

  constructor(
    socketPath: string = SOCKET_PATH,
    connectionTimeout: number = CONNECTION_TIMEOUT_MS,
    timer: Timer = defaultTimer,
    recoveryOptions: DaemonClientRecoveryOptions = {},
  ) {
    this.socketPath = socketPath;
    this.connectionTimeout = connectionTimeout;
    this.timer = timer;
    this.recoveryOptions = recoveryOptions;
  }

  /**
   * Check if daemon is available (socket file exists and is connectable).
   * Uses a lightweight raw socket probe — no logging, no DaemonClient overhead.
   */
  static async isAvailable(
    socketPath: string = SOCKET_PATH,
    recoveryOptions: DaemonClientRecoveryOptions = {}
  ): Promise<boolean> {
    // On Unix, verify the path exists and is a socket (not a stale regular file).
    // On Windows, named pipes don't have filesystem entries — skip the stat check
    // and let createConnection determine reachability.
    if (platform() !== "win32") {
      try {
        const stats = statSync(socketPath);
        if (!stats.isSocket()) {
          DaemonClient.cleanupStaleSocketIfDaemonDead(socketPath, recoveryOptions);
          return false;
        }
      } catch {
        return false;
      }
    }

    return new Promise<boolean>(resolve => {
      let settled = false;
      const settle = (value: boolean) => {
        if (!settled) {
          settled = true;
          resolve(value);
        }
      };

      const socket = createConnection(socketPath, () => {
        defaultTimer.clearTimeout(timeout);
        socket.destroy();
        settle(true);
      });
      socket.on("error", () => {
        defaultTimer.clearTimeout(timeout);
        socket.destroy();
        DaemonClient.cleanupStaleSocketIfDaemonDead(socketPath, recoveryOptions);
        settle(false);
      });
      const timeout = defaultTimer.setTimeout(() => {
        socket.destroy();
        DaemonClient.cleanupStaleSocketIfDaemonDead(socketPath, recoveryOptions);
        settle(false);
      }, 1000);
    });
  }

  /**
   * Connect to the daemon
   */
  async connect(): Promise<void> {
    if (this.connected) {
      return;
    }

    try {
      await this.connectOnce();
      return;
    } catch (error) {
      if (DaemonClient.cleanupStaleSocketIfDaemonDead(this.socketPath, this.recoveryOptions)) {
        await this.connectOnce();
        return;
      }
      throw error;
    }
  }

  private async connectOnce(): Promise<void> {
    if (this.connected) {
      return;
    }

    if (!existsSync(this.socketPath)) {
      throw new DaemonUnavailableError(
        `Daemon socket not found: ${this.socketPath}`
      );
    }

    return new Promise((resolve, reject) => {
      let settled = false;

      const rejectPendingRequests = (error: Error) => {
        for (const [, { reject, timeout }] of this.pendingRequests) {
          this.timer.clearTimeout(timeout);
          reject(error);
        }
        this.pendingRequests.clear();
      };

      const fail = (error: Error) => {
        this.timer.clearTimeout(timeout);
        this.connected = false;
        if (this.socket) {
          this.socket.destroy();
          this.socket = null;
        }
        rejectPendingRequests(error);
        if (!settled) {
          settled = true;
          reject(error);
        }
      };

      const timeout = this.timer.setTimeout(() => {
        fail(
          new DaemonUnavailableError(
            `Failed to connect to daemon within ${this.connectionTimeout}ms`
          )
        );
      }, this.connectionTimeout);

      this.socket = createConnection(this.socketPath, () => {
        this.timer.clearTimeout(timeout);
        this.connected = true;
        logger.info(`Connected to daemon at ${this.socketPath}`);
        if (!settled) {
          settled = true;
          resolve();
        }
      });

      this.socket.on("data", data => {
        this.handleData(data);
      });

      this.socket.on("error", error => {
        logger.error(`Daemon socket error: ${error.message}`);
        fail(error);
      });

      this.socket.on("close", () => {
        this.connected = false;
        logger.info("Daemon socket connection closed");
      });
    });
  }

  private static cleanupStaleSocketIfDaemonDead(
    socketPath: string,
    recoveryOptions: DaemonClientRecoveryOptions
  ): boolean {
    const socketPaths = recoveryOptions.socketPaths ?? (
      socketPath === SOCKET_PATH ? getDaemonSocketPaths() : [socketPath]
    );

    return cleanupStaleDaemonFilesForDeadPidSync({
      ...recoveryOptions,
      socketPaths,
    });
  }

  /**
   * Handle incoming data from daemon
   */
  private handleData(data: Buffer): void {
    this.buffer += data.toString();

    // Process complete JSON messages (newline-delimited)
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() || ""; // Keep incomplete line in buffer

    for (const line of lines) {
      if (line.trim()) {
        try {
          const response: DaemonResponse = JSON.parse(line);
          this.handleResponse(response);
        } catch (error) {
          logger.error(`Error parsing daemon response: ${error}`);
        }
      }
    }
  }

  /**
   * Handle a response from daemon
   */
  private handleResponse(response: DaemonResponse): void {
    const pending = this.pendingRequests.get(response.id);
    if (!pending) {
      logger.warn(`Received response for unknown request ID: ${response.id}`);
      return;
    }

    this.timer.clearTimeout(pending.timeout);
    this.pendingRequests.delete(response.id);

    if (response.success) {
      pending.resolve(response);
    } else {
      pending.reject(
        new ActionableError(response.error || "Unknown error from daemon")
      );
    }
  }

  /**
   * Call a tool on the daemon
   */
  async callTool(toolName: string, params: Record<string, any>): Promise<any> {
    return this.sendRequest("tools/call", {
      name: toolName,
      arguments: params,
    });
  }

  /**
   * Read a resource from the daemon
   */
  async readResource(uri: string): Promise<any> {
    return this.sendRequest("resources/read", { uri });
  }

  private async sendRequest(method: string, params: Record<string, any>): Promise<any> {
    // Ensure we're connected
    if (!this.connected) {
      await this.connect();
    }

    const requestId = randomUUID();

    const request: DaemonRequest = {
      id: requestId,
      type: "mcp_request",
      method,
      params,
    };

    const requestTimeoutMs = Math.max(resolveMcpRequestTimeoutMs(request), this.connectionTimeout);
    const toolName = method === "tools/call" ? params?.name ?? method : method;

    return new Promise((resolve, reject) => {
      const timeout = this.timer.setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(
          new McpTimeoutError({
            toolName,
            timeoutMs: requestTimeoutMs,
            origin: "DaemonClient.sendRequest",
          })
        );
      }, requestTimeoutMs);

      this.pendingRequests.set(requestId, {
        resolve: response => {
          resolve(response.result);
        },
        reject,
        timeout,
      });

      if (!this.socket) {
        this.timer.clearTimeout(timeout);
        this.pendingRequests.delete(requestId);
        reject(
          new DaemonUnavailableError("Socket connection lost")
        );
        return;
      }

      this.socket.write(JSON.stringify(request) + "\n");
    });
  }

  /**
   * Call a daemon method directly over the socket
   */
  async callDaemonMethod(
    method: string,
    params: Record<string, any> = {}
  ): Promise<any> {
    if (!this.connected) {
      await this.connect();
    }

    const requestId = randomUUID();

    const request: DaemonRequest = {
      id: requestId,
      type: "daemon_request",
      method,
      params,
    };

    return new Promise((resolve, reject) => {
      const timeout = this.timer.setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(
          new McpTimeoutError({
            toolName: method,
            timeoutMs: this.connectionTimeout,
            origin: "DaemonClient.callDaemonMethod",
          })
        );
      }, this.connectionTimeout);

      this.pendingRequests.set(requestId, {
        resolve: response => {
          resolve(response.result);
        },
        reject,
        timeout,
      });

      if (!this.socket) {
        this.timer.clearTimeout(timeout);
        this.pendingRequests.delete(requestId);
        reject(
          new DaemonUnavailableError("Socket connection lost")
        );
        return;
      }

      this.socket.write(JSON.stringify(request) + "\n");
    });
  }

  /**
   * Close the connection
   */
  async close(): Promise<void> {
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }

    this.connected = false;

    // Reject all pending requests
    for (const [, { timeout }] of this.pendingRequests) {
      this.timer.clearTimeout(timeout);
    }
    this.pendingRequests.clear();
  }
}

export interface DaemonClientLike {
  connect(): Promise<void>;
  close(): Promise<void>;
  callTool(toolName: string, params: Record<string, any>): Promise<any>;
  readResource(uri: string): Promise<any>;
  callDaemonMethod(method: string, params: Record<string, any>): Promise<any>;
}

export type DaemonClientFactory = () => DaemonClientLike;
