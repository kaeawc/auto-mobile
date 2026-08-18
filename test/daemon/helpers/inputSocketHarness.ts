import { Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { mock } from "bun:test";
import {
  SOCKET_REQUEST_DEADLINE_MS,
  connectBounded,
  sendRawSocketRequest,
  sendSocketRequest,
} from "./socketRequest";
import { defaultTimer } from "../../../src/utils/SystemTimer";
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
  return sendSocketRequest(socketPath, method, params, timeoutMs);
}

export async function sendRequestAfterConnect(
  socketPath: string,
  request: DaemonRequest,
  onConnect: () => void
): Promise<DaemonResponse> {
  const { response } = await sendRawSocketRequest(socketPath, request, { onConnect });
  return response;
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
export async function openPersistentConnection(socketPath: string): Promise<PersistentConnection> {
  const client = new Socket();
  let buffer = "";
  const pending = new Map<string, { resolve: (response: DaemonResponse) => void; deadline: NodeJS.Timeout }>();

  client.on("data", data => {
    buffer += data.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      const response = JSON.parse(line) as DaemonResponse;
      const entry = pending.get(response.id);
      if (entry) {
        pending.delete(response.id);
        defaultTimer.clearTimeout(entry.deadline);
        entry.resolve(response);
      }
    }
  });
  await connectBounded(client, socketPath);
  // Post-connect transport errors (e.g. ECONNRESET when a test closes the
  // server mid-stream) must not become uncaught 'error' events; pending sends
  // are already bounded by their own deadlines.
  client.on("error", () => {});
  return {
    send(method, params = {}, timeoutMs) {
      const id = randomUUID();
      return new Promise<DaemonResponse>((resolve, reject) => {
        // Bounded like sendSocketRequest: an unanswered request must fail fast
        // with a diagnostic, not pend until the suite's wall-clock watchdog.
        const deadline = defaultTimer.setTimeout(() => {
          pending.delete(id);
          client.destroy();
          reject(new Error(
            `No response to ${method} on ${socketPath} within ${SOCKET_REQUEST_DEADLINE_MS}ms — `
            + "bounded socket-test deadline hit (the server hung or dropped the request)"
          ));
        }, SOCKET_REQUEST_DEADLINE_MS);
        pending.set(id, { resolve, deadline });
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
      for (const entry of pending.values()) {
        defaultTimer.clearTimeout(entry.deadline);
      }
      pending.clear();
      client.destroy();
    },
  };
}
