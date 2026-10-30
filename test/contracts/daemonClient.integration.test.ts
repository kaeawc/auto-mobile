import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { platform, tmpdir } from "node:os";
import path from "node:path";
import { DaemonClient } from "../../src/daemon/client/client";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";
import {
  runDaemonClientContract,
  type DaemonClientHarness,
  type DaemonClientHarnessOptions,
} from "./DaemonClientContract";

const PROBE_METHOD = "daemon/contract-probe";

async function tick(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

/** The real client against a scripted daemon listening on a unix socket in a private temp dir. */
async function realHarness(options: DaemonClientHarnessOptions): Promise<DaemonClientHarness> {
  const dir = mkdtempSync(path.join(tmpdir(), "dc-"));
  const socketPath = path.join(dir, "d.sock");
  const sockets = new Set<Socket>();
  let requests = 0;
  let server: Server | undefined;

  if (!options.unreachable) {
    server = createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => {});
      let buffered = "";
      socket.on("data", (chunk) => {
        buffered += chunk.toString("utf8");
        const lines = buffered.split("\n");
        buffered = lines.pop() ?? "";
        for (const line of lines) {
          const request = JSON.parse(line) as { id: string; type: string };
          if (request.type !== "mcp_request" && request.type !== "daemon_request") {
            continue; // a cancel frame, not a request
          }
          requests += 1;
          if (!options.hold) {
            socket.write(
              JSON.stringify({
                id: request.id,
                type: "mcp_response",
                success: true,
                result: options.result,
              }) + "\n",
            );
          }
        }
      });
    });
    await new Promise<void>((resolve) => server!.listen(socketPath, resolve));
  }

  const timer = new FakeTimer();
  const client = new DaemonClient(
    socketPath,
    1000,
    timer,
    {},
    { clientIdentity: null, idGenerator: new FakeIdGenerator(), platformOverride: "linux" },
  );

  const connected = async (): Promise<void> => {
    for (let i = 0; i < 200 && sockets.size === 0; i++) {
      await tick();
    }
  };

  return {
    client,
    requestCount: () => requests,
    push: async (notification) => {
      await connected();
      for (const socket of sockets) {
        socket.write(JSON.stringify(notification) + "\n");
      }
    },
    hangUp: async () => {
      await connected();
      for (const socket of sockets) {
        socket.destroy();
      }
    },
    close: async () => {
      await client.close();
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** The fake with the same scripted answer and its fault injection switched on. */
async function fakeHarness(options: DaemonClientHarnessOptions): Promise<DaemonClientHarness> {
  const hold = options.hold ? () => new Promise<never>(() => {}) : undefined;
  const client = new FakeDaemonClient({
    toolResult: options.result,
    resourceResult: options.result,
    daemonMethodResults: new Map([[PROBE_METHOD, options.result]]),
    onCallTool: hold,
    onCallDaemonMethod: hold,
  });
  client.shouldFailConnect = options.unreachable === true;
  return {
    client,
    requestCount: () =>
      client.callToolCalls.length +
      client.readResourceCalls.length +
      client.callDaemonMethodCalls.length,
    push: async (notification) => {
      client.emitNotification(
        notification.method,
        undefined,
        undefined,
        undefined,
        notification.uri,
      );
    },
    hangUp: async () => {
      client.emitConnectionClosed();
    },
    close: async () => {
      await client.close();
    },
  };
}

// The real harness listens on a unix-domain socket path (client forced to "linux"), which the
// Windows runners cannot bind in a temp dir; the sibling handshake test skips there too.
if (platform() !== "win32") {
  runDaemonClientContract("DaemonClient (unix socket in a temp dir)", realHarness);
}
runDaemonClientContract("FakeDaemonClient", fakeHarness);
