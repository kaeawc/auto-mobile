import { Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { mock } from "bun:test";
import { PlatformDeviceManagerFactory } from "../../../src/utils/factories/PlatformDeviceManagerFactory";
import type { DaemonRequest, DaemonResponse } from "../../../src/daemon/types";
import type { DeviceLabelMap, Session } from "../../../src/daemon/sessionManager";
import type { BootedDevice } from "../../../src/models";

/**
 * Shared fixtures + Unix-socket request helpers for the `input/*` socket-server
 * suites (tap, swipe, typeText, ...). Extracted from a byte-identical ~170-line
 * prologue that was duplicated across those files (issue #4182, item 17).
 */

export const androidDevice: BootedDevice = {
  deviceId: "emulator-5554",
  name: "Pixel",
  platform: "android",
};

export const iosDevice: BootedDevice = {
  deviceId: "ios-sim-1",
  name: "iPhone 16",
  platform: "ios",
};

export function createFakeDeviceManager(
  devices: BootedDevice[],
  succeededPlatforms: Set<"android" | "ios"> = new Set(["android", "ios"])
) {
  return {
    getBootedDevicesDetailed: mock(async () => ({
      devices,
      succeededPlatforms,
    })),
  } as unknown as ReturnType<typeof PlatformDeviceManagerFactory.getInstance>;
}

export function createFakeSession(sessionId: string, assignedDevice: string, platform: "android" | "ios"): Session {
  return {
    sessionId,
    assignedDevice,
    platform,
    createdAt: 0,
    lastUsedAt: 0,
    expiresAt: 60_000,
    cacheData: {},
    lastHeartbeat: 0,
    sessionTimeoutMs: 60_000,
    heartbeatTimeoutMs: 10_000,
    heartbeatTimeoutSource: "default",
    hasReceivedHeartbeat: false,
  };
}

export function createFakeDaemonState(
  autolockSessions: Map<string, Session> = new Map(),
  mcpAutolockSessions: Map<string, string> = new Map()
) {
  return {
    isInitialized: () => true,
    getSessionManager: () => ({
      getSession: (sessionId: string) => autolockSessions.get(sessionId) ?? null,
      getDeviceLabels: (_sessionId: string): DeviceLabelMap | undefined => undefined,
      releaseSession: async () => null,
    }),
    getDevicePool: () => ({
      refreshDevices: async () => 0,
      getStats: () => ({ total: 0, idle: 0, assigned: 0, error: 0 }),
      releaseDevice: async () => {},
      resolveAutolockSessionForMcpSession: (mcpSessionId: string | undefined, platform?: "android" | "ios") => {
        if (!mcpSessionId) {
          return undefined;
        }
        const sessionId = mcpAutolockSessions.get(mcpSessionId);
        const session = sessionId ? autolockSessions.get(sessionId) : undefined;
        return session?.platform === platform ? session.sessionId : undefined;
      },
    }),
  };
}

export function sendRequest(
  socketPath: string,
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs?: number
): Promise<DaemonResponse> {
  return new Promise((resolve, reject) => {
    const client = new Socket();
    let buffer = "";
    const request: DaemonRequest = {
      id: randomUUID(),
      type: "mcp_request",
      method,
      params,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    };

    client.connect(socketPath, () => {
      client.write(JSON.stringify(request) + "\n");
    });

    client.on("data", data => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      for (const line of lines) {
        if (!line.trim()) {
          continue;
        }
        try {
          const response = JSON.parse(line) as DaemonResponse;
          client.destroy();
          resolve(response);
          return;
        } catch {
          // Incomplete JSON, keep buffering.
        }
      }
    });

    client.on("error", reject);
    client.on("close", () => {
      if (!buffer.trim()) {
        reject(new Error("Connection closed without response"));
      }
    });
  });
}

export function sendRequestAfterConnect(
  socketPath: string,
  request: DaemonRequest,
  onConnect: () => void
): Promise<DaemonResponse> {
  return new Promise((resolve, reject) => {
    const client = new Socket();
    let buffer = "";

    client.connect(socketPath, () => {
      onConnect();
      client.write(JSON.stringify(request) + "\n");
    });

    client.on("data", data => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      for (const line of lines) {
        if (!line.trim()) {
          continue;
        }
        try {
          const response = JSON.parse(line) as DaemonResponse;
          client.destroy();
          resolve(response);
          return;
        } catch {
          // Incomplete JSON, keep buffering.
        }
      }
    });

    client.on("error", reject);
    client.on("close", () => {
      if (!buffer.trim()) {
        reject(new Error("Connection closed without response"));
      }
    });
  });
}

/** One persistent socket connection that can send several requests before closing. */
export interface PersistentConnection {
  /** Send one request over the held connection and resolve with its response (correlated by id). */
  send(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<DaemonResponse>;
  /** Disconnect, modelling the client going away (a crash/timeout mid-stream). */
  close(): void;
}

/**
 * Open ONE persistent socket and keep it connected across many requests, the way the real streaming
 * gesture client holds a single connection open for a drag's start -> moves -> end. Unlike
 * {@link sendRequest} (a throwaway socket per call), this lets a test drive a multi-frame gesture on
 * one session and then {@link PersistentConnection.close} it to model a mid-drag disconnect.
 * Responses are correlated by request id, so concurrent sends are supported.
 */
export function openPersistentConnection(socketPath: string): Promise<PersistentConnection> {
  return new Promise((resolveConn, rejectConn) => {
    const client = new Socket();
    let buffer = "";
    const pending = new Map<string, (response: DaemonResponse) => void>();

    client.on("data", data => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) {
          continue;
        }
        const response = JSON.parse(line) as DaemonResponse;
        const resolve = pending.get(response.id);
        if (resolve) {
          pending.delete(response.id);
          resolve(response);
        }
      }
    });
    client.on("error", rejectConn);
    client.connect(socketPath, () => {
      resolveConn({
        send(method, params = {}, timeoutMs) {
          const id = randomUUID();
          return new Promise<DaemonResponse>(resolve => {
            pending.set(id, resolve);
            const request: DaemonRequest = {
              id,
              type: "mcp_request",
              method,
              params,
              ...(timeoutMs === undefined ? {} : { timeoutMs }),
            };
            client.write(JSON.stringify(request) + "\n");
          });
        },
        close() {
          client.destroy();
        },
      });
    });
  });
}
