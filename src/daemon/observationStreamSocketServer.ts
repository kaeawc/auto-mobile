import { createServer, Server as NetServer, Socket } from "node:net";
import { existsSync } from "node:fs";
import { unlink, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { logger } from "../utils/logger";
import type { ViewHierarchyResult } from "../models";

// Use /tmp for socket when running with external emulator (Docker container with mounted home)
const isExternalMode = process.env.AUTOMOBILE_EMULATOR_EXTERNAL === "true";
const DEFAULT_SOCKET_PATH = isExternalMode
  ? "/tmp/auto-mobile-observation-stream.sock"
  : path.join(os.homedir(), ".auto-mobile", "observation-stream.sock");

/**
 * Request format for observation stream socket
 */
interface ObservationStreamRequest {
  id: string;
  command: "subscribe" | "unsubscribe" | "request_observation";
  deviceId?: string; // Optional: subscribe to specific device
}

/**
 * Response/push message format
 */
interface ObservationStreamMessage {
  id?: string;
  type: "subscription_response" | "hierarchy_update" | "screenshot_update" | "error";
  success?: boolean;
  error?: string;
  deviceId?: string;
  timestamp?: number;
  data?: ViewHierarchyResult;
  screenshotBase64?: string;
  screenWidth?: number;
  screenHeight?: number;
}

/**
 * Subscriber info
 */
interface Subscriber {
  socket: Socket;
  deviceId: string | null; // null means subscribe to all devices
  subscriptionId: string;
}

/**
 * Callback invoked when a subscriber connects.
 * Can be used to trigger device WebSocket connections for real-time updates.
 */
export type OnSubscriberConnectedCallback = (deviceId: string | null) => void;

/**
 * Socket server that streams observation updates (hierarchy + screenshot) to connected IDE plugins.
 *
 * Unlike other socket servers which are request-response, this one maintains persistent
 * connections and pushes updates when they arrive from devices.
 *
 * Protocol:
 * - Client sends: {"id": "1", "command": "subscribe", "deviceId": "emulator-5554"}
 * - Server responds: {"id": "1", "type": "subscription_response", "success": true}
 * - Server pushes: {"type": "hierarchy_update", "deviceId": "emulator-5554", "timestamp": 123, "data": {...}}
 * - Server pushes: {"type": "screenshot_update", "deviceId": "emulator-5554", "timestamp": 123, "screenshotBase64": "..."}
 */
export class ObservationStreamSocketServer {
  private server: NetServer | null = null;
  private socketPath: string;
  private subscribers: Map<string, Subscriber> = new Map();
  private subscriptionCounter = 0;
  private onSubscriberConnected: OnSubscriberConnectedCallback | null = null;

  constructor(socketPath: string = DEFAULT_SOCKET_PATH) {
    this.socketPath = socketPath;
  }

  /**
   * Set a callback to be invoked when a subscriber connects.
   * This is used to trigger device WebSocket connections for real-time updates.
   */
  setOnSubscriberConnected(callback: OnSubscriberConnectedCallback): void {
    this.onSubscriberConnected = callback;
  }

  async start(): Promise<void> {
    const directory = path.dirname(this.socketPath);
    if (!existsSync(directory)) {
      await mkdir(directory, { recursive: true });
    }

    if (existsSync(this.socketPath)) {
      await unlink(this.socketPath);
    }

    this.server = createServer(socket => {
      this.handleConnection(socket);
    });

    return new Promise((resolve, reject) => {
      this.server!.listen(this.socketPath, () => {
        logger.info(`[ObservationStream] Socket listening on ${this.socketPath}`);
        resolve();
      });

      this.server!.on("error", error => {
        logger.error(`[ObservationStream] Socket error: ${error}`);
        reject(error);
      });
    });
  }

  async close(): Promise<void> {
    // Close all subscriber connections
    for (const [, subscriber] of this.subscribers) {
      try {
        subscriber.socket.end();
      } catch {
        // Ignore errors when closing
      }
    }
    this.subscribers.clear();

    if (!this.server) {
      return;
    }

    await new Promise<void>(resolve => {
      this.server!.close(() => resolve());
    });
    this.server = null;

    if (existsSync(this.socketPath)) {
      await unlink(this.socketPath);
    }
  }

  isListening(): boolean {
    return this.server?.listening ?? false;
  }

  /**
   * Push a hierarchy update to all subscribers interested in this device.
   */
  pushHierarchyUpdate(deviceId: string, hierarchy: ViewHierarchyResult): void {
    const message: ObservationStreamMessage = {
      type: "hierarchy_update",
      deviceId,
      timestamp: hierarchy.updatedAt ?? Date.now(),
      data: hierarchy,
    };

    this.broadcastToSubscribers(deviceId, message);
  }

  /**
   * Push a screenshot update to all subscribers interested in this device.
   */
  pushScreenshotUpdate(
    deviceId: string,
    screenshotBase64: string,
    screenWidth: number,
    screenHeight: number
  ): void {
    const message: ObservationStreamMessage = {
      type: "screenshot_update",
      deviceId,
      timestamp: Date.now(),
      screenshotBase64,
      screenWidth,
      screenHeight,
    };

    this.broadcastToSubscribers(deviceId, message);
  }

  /**
   * Get the number of active subscribers.
   */
  getSubscriberCount(): number {
    return this.subscribers.size;
  }

  private broadcastToSubscribers(deviceId: string, message: ObservationStreamMessage): void {
    const json = JSON.stringify(message) + "\n";
    let sentCount = 0;

    for (const [subscriptionId, subscriber] of this.subscribers) {
      // Send to subscribers that want all devices or specifically this device
      if (subscriber.deviceId === null || subscriber.deviceId === deviceId) {
        try {
          const result = subscriber.socket.write(json);
          logger.info(`[ObservationStream] Write to ${subscriptionId} returned: ${result}, bytes: ${json.length}`);
          sentCount++;
        } catch (error) {
          logger.warn(`[ObservationStream] Failed to send to subscriber ${subscriptionId}: ${error}`);
          // Remove dead subscriber
          this.subscribers.delete(subscriptionId);
        }
      }
    }

    if (sentCount > 0) {
      logger.info(`[ObservationStream] Pushed ${message.type} to ${sentCount} subscribers (device: ${deviceId})`);
    }
  }

  private handleConnection(socket: Socket): void {
    let buffer = "";
    let subscriptionId: string | null = null;

    socket.on("data", data => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.trim()) {
          this.processLine(socket, line).then(result => {
            if (result?.subscriptionId) {
              subscriptionId = result.subscriptionId;
            }
          }).catch(error => {
            logger.error(`[ObservationStream] Request error: ${error}`);
          });
        }
      }
    });

    socket.on("close", () => {
      if (subscriptionId) {
        this.subscribers.delete(subscriptionId);
        logger.info(`[ObservationStream] Subscriber ${subscriptionId} disconnected`);
      }
    });

    socket.on("error", error => {
      logger.error(`[ObservationStream] Connection error: ${error}`);
      if (subscriptionId) {
        this.subscribers.delete(subscriptionId);
      }
    });
  }

  private async processLine(
    socket: Socket,
    line: string
  ): Promise<{ subscriptionId?: string } | void> {
    try {
      const request = JSON.parse(line) as ObservationStreamRequest;

      switch (request.command) {
        case "subscribe": {
          const subscriptionId = `sub-${++this.subscriptionCounter}`;
          this.subscribers.set(subscriptionId, {
            socket,
            deviceId: request.deviceId ?? null,
            subscriptionId,
          });

          const response: ObservationStreamMessage = {
            id: request.id,
            type: "subscription_response",
            success: true,
          };
          socket.write(JSON.stringify(response) + "\n");

          logger.info(`[ObservationStream] New subscriber ${subscriptionId} (device: ${request.deviceId ?? "all"})`);

          // Trigger device WebSocket connections for real-time updates
          if (this.onSubscriberConnected) {
            try {
              this.onSubscriberConnected(request.deviceId ?? null);
            } catch (error) {
              logger.warn(`[ObservationStream] Error in onSubscriberConnected callback: ${error}`);
            }
          }

          return { subscriptionId };
        }

        case "unsubscribe": {
          // Find and remove the subscription for this socket
          for (const [subId, subscriber] of this.subscribers) {
            if (subscriber.socket === socket) {
              this.subscribers.delete(subId);
              logger.info(`[ObservationStream] Unsubscribed ${subId}`);
              break;
            }
          }

          const response: ObservationStreamMessage = {
            id: request.id,
            type: "subscription_response",
            success: true,
          };
          socket.write(JSON.stringify(response) + "\n");
          return;
        }

        case "request_observation": {
          // This could trigger an immediate observation request
          // For now, just acknowledge - the caller should use MCP observe tool
          const response: ObservationStreamMessage = {
            id: request.id,
            type: "subscription_response",
            success: true,
          };
          socket.write(JSON.stringify(response) + "\n");
          return;
        }

        default:
          throw new Error(`Unknown command: ${(request as any).command}`);
      }
    } catch (error) {
      logger.error(`[ObservationStream] Parse error: ${error}`);
      const errorResponse: ObservationStreamMessage = {
        type: "error",
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
      socket.write(JSON.stringify(errorResponse) + "\n");
    }
  }
}

// Singleton instance
let socketServer: ObservationStreamSocketServer | null = null;

export function getObservationStreamServer(): ObservationStreamSocketServer | null {
  return socketServer;
}

export async function startObservationStreamSocketServer(): Promise<ObservationStreamSocketServer> {
  if (!socketServer) {
    socketServer = new ObservationStreamSocketServer();
  }
  if (!socketServer.isListening()) {
    await socketServer.start();
  }
  return socketServer;
}

export async function stopObservationStreamSocketServer(): Promise<void> {
  if (!socketServer) {
    return;
  }
  await socketServer.close();
  socketServer = null;
}
