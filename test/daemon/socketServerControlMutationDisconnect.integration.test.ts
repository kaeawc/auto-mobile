import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DAEMON_REPAIR_CONTROL_METADATA_METHOD } from "../../src/daemon/daemonRestartAdmission";
import { UnixSocketServer } from "../../src/daemon/socketServer";
import type { DaemonResponse } from "../../src/daemon/types";
import { defaultTimer } from "../../src/utils/SystemTimer";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";
import {
  connectBounded,
  sendSocketRequest,
  SOCKET_REQUEST_DEADLINE_MS,
} from "./helpers/socketRequest";

function createFakeDaemonState(refreshDevices: () => Promise<number> = async () => 0) {
  return {
    isInitialized: () => true,
    getSessionManager: () => ({
      getSession: () => null,
      getAllSessions: () => [],
      releaseSession: async () => null,
    }),
    getDevicePool: () => ({
      refreshDevices,
      getStats: () => ({ total: 0, idle: 0, assigned: 0, error: 0 }),
      releaseDevice: async () => {},
    }),
  };
}

function requestFrame(id: string, method: string, params: Record<string, unknown> = {}): string {
  return `${JSON.stringify({ id, type: "mcp_request", method, params })}\n`;
}

async function waitForCondition(condition: () => boolean, description: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (condition()) {
      return;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

interface SocketServerInternals {
  activeRequestHandlers: Set<Promise<void>>;
  clientSockets: Map<string, Socket>;
  localRequestAbortControllers: Map<string, Set<AbortController>>;
}

function internals(server: UnixSocketServer): SocketServerInternals {
  return server as unknown as SocketServerInternals;
}

class PersistentSocketClient {
  readonly socket = new Socket();
  private buffer = "";
  private readonly waiters = new Map<
    string,
    {
      resolve: (response: DaemonResponse) => void;
      reject: (error: Error) => void;
    }
  >();

  async connect(socketPath: string): Promise<void> {
    this.socket.on("data", (data) => {
      this.buffer += data.toString();
      const lines = this.buffer.split("\n");
      this.buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) {
          continue;
        }
        const response = JSON.parse(line) as DaemonResponse;
        const waiter = this.waiters.get(response.id);
        if (waiter) {
          this.waiters.delete(response.id);
          waiter.resolve(response);
        }
      }
    });
    this.socket.on("close", () => {
      for (const waiter of this.waiters.values()) {
        waiter.reject(new Error("Socket closed before receiving a response"));
      }
      this.waiters.clear();
    });
    await connectBounded(this.socket, socketPath);
  }

  request(method: string, params: Record<string, unknown>): Promise<DaemonResponse> {
    const id = randomUUID();
    const pending = Promise.withResolvers<DaemonResponse>();
    const deadline = defaultTimer.setTimeout(() => {
      this.waiters.delete(id);
      pending.reject(new Error(`No response to ${method} within the bounded socket deadline`));
    }, SOCKET_REQUEST_DEADLINE_MS);
    this.waiters.set(id, {
      resolve: pending.resolve,
      reject: pending.reject,
    });
    this.socket.write(requestFrame(id, method, params));
    return pending.promise.finally(() => defaultTimer.clearTimeout(deadline));
  }

  close(): void {
    this.socket.destroy();
  }
}

describe("UnixSocketServer control-mutation disconnect ownership", () => {
  let socketPath: string;
  let server: UnixSocketServer;

  beforeEach(() => {
    socketPath = join(tmpdir(), `control-mutation-disconnect-${randomUUID()}.sock`);
  });

  afterEach(async () => {
    await server?.close();
    if (existsSync(socketPath)) {
      await unlink(socketPath);
    }
  });

  test("rejects a queued metadata repair before side effects after its owner disconnects", async () => {
    const refreshStarted = Promise.withResolvers<void>();
    const releaseRefresh = Promise.withResolvers<number>();
    let repairCalls = 0;
    server = new UnixSocketServer(
      socketPath,
      "http://localhost:0/mcp",
      createFakeDaemonState(async () => {
        refreshStarted.resolve();
        return await releaseRefresh.promise;
      }),
      new FakeTimer(),
      null,
      {
        processGenerationToken: "queued-repair-generation",
        onControlMetadataRepair: async () => {
          repairCalls++;
        },
      },
    );
    await server.start();

    const status = (await sendSocketRequest(socketPath, "ide/status")).result!;
    const owner = new Socket();
    await connectBounded(owner, socketPath);
    try {
      owner.write(
        requestFrame("blocker", "daemon/refreshDevices") +
          requestFrame("queued-repair", DAEMON_REPAIR_CONTROL_METADATA_METHOD, status),
      );
      await refreshStarted.promise;

      const ownerClosed = once(owner, "close");
      owner.destroy();
      await ownerClosed;
      await waitForCondition(
        () => internals(server).clientSockets.size === 0,
        "the owner disconnect cleanup",
      );

      releaseRefresh.resolve(0);
      await waitForCondition(
        () => internals(server).activeRequestHandlers.size === 0,
        "the disconnected request queue to drain",
      );

      expect(repairCalls).toBe(0);
      expect(internals(server).localRequestAbortControllers.size).toBe(0);
    } finally {
      releaseRefresh.resolve(0);
      owner.destroy();
    }
  });

  test("a stale socket close does not abort a newer socket with the same session ID", async () => {
    const repairStarted = Promise.withResolvers<void>();
    const releaseRepair = Promise.withResolvers<void>();
    let repairSignal: AbortSignal | undefined;
    server = new UnixSocketServer(
      socketPath,
      "http://localhost:0/mcp",
      createFakeDaemonState(),
      new FakeTimer(),
      null,
      {
        processGenerationToken: "replacement-owner-generation",
        onControlMetadataRepair: async (signal) => {
          repairSignal = signal;
          repairStarted.resolve();
          await releaseRepair.promise;
        },
      },
      new FakeIdGenerator(["reused-session", "reused-session"]),
    );
    await server.start();

    const staleOwner = new Socket();
    const currentOwner = new PersistentSocketClient();
    await connectBounded(staleOwner, socketPath);
    await waitForCondition(
      () => internals(server).clientSockets.has("reused-session"),
      "the first socket to register",
    );
    const staleServerSocket = internals(server).clientSockets.get("reused-session")!;
    await currentOwner.connect(socketPath);
    await waitForCondition(
      () => internals(server).clientSockets.get("reused-session") !== staleServerSocket,
      "the replacement socket to register",
    );
    const currentServerSocket = internals(server).clientSockets.get("reused-session");

    try {
      const status = await currentOwner.request("ide/status", {});
      const repair = currentOwner.request(DAEMON_REPAIR_CONTROL_METADATA_METHOD, status.result!);
      await repairStarted.promise;

      const staleServerClosed = once(staleServerSocket, "close");
      staleOwner.destroy();
      await staleServerClosed;

      expect(internals(server).clientSockets.get("reused-session")).toBe(currentServerSocket);
      expect(repairSignal?.aborted).toBe(false);

      releaseRepair.resolve();
      expect(await repair).toMatchObject({
        success: true,
        result: { repaired: true },
      });
      expect(internals(server).localRequestAbortControllers.size).toBe(0);
    } finally {
      releaseRepair.resolve();
      staleOwner.destroy();
      currentOwner.close();
    }
  });
});
