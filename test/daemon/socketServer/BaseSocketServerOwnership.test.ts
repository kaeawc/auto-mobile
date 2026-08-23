import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createServer, type Server as NetServer } from "node:net";
import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { RequestResponseSocketServer } from "../../../src/daemon/socketServer/RequestResponseSocketServer";
import type {
  SocketRequest,
  SocketResponse,
} from "../../../src/daemon/socketServer/SocketServerTypes";
import { FakeTimer } from "../../fakes/FakeTimer";

const isWindows = platform() === "win32";

interface NoopRequest extends SocketRequest {
  action: string;
}
interface NoopResponse extends SocketResponse {
  type: "noop_response";
}

class TestServer extends RequestResponseSocketServer<NoopRequest, NoopResponse> {
  constructor(socketPath: string, timer: FakeTimer) {
    super(socketPath, timer, "OwnershipTest");
  }
  protected async handleRequest(): Promise<NoopResponse> {
    return { type: "noop_response", id: "0", success: true };
  }
}

function listenOnSocket(socketPath: string): Promise<NetServer> {
  const replacement = createServer();
  return new Promise((resolve, reject) => {
    replacement.once("error", reject);
    replacement.listen(socketPath, () => resolve(replacement));
  });
}

function closeServer(server: NetServer): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe("BaseSocketServer close ownership", () => {
  let socketPath: string;
  let server: TestServer;

  afterEach(async () => {
    try {
      await server?.close();
    } catch {
      /* ignore */
    }
    if (existsSync(socketPath)) {
      await unlink(socketPath).catch(() => {});
    }
  });

  (isWindows ? test.skip : test)("removes its own socket file on close", async () => {
    socketPath = join(tmpdir(), `base-sock-${randomUUID()}.sock`);
    server = new TestServer(socketPath, new FakeTimer());
    await server.start();
    expect(existsSync(socketPath)).toBe(true);
    expect(server.hasActiveSocketPath()).toBe(true);

    await server.close();

    expect(existsSync(socketPath)).toBe(false);
    expect(server.hasActiveSocketPath()).toBe(false);
  });

  (isWindows ? test.skip : test)(
    "does NOT remove a replacement socket rebound at the same path",
    async () => {
      socketPath = join(tmpdir(), `base-sock-${randomUUID()}.sock`);
      server = new TestServer(socketPath, new FakeTimer());
      await server.start();

      // Simulate a fast restart: our socket is replaced by a successor process
      // binding the same path before our close() runs.
      await unlink(socketPath);
      expect(server.hasActiveSocketPath()).toBe(false);
      const replacement = await listenOnSocket(socketPath);
      expect(server.hasActiveSocketPath()).toBe(false);

      try {
        await server.close();
        // The successor's socket must survive — otherwise live subscribers drop.
        expect(existsSync(socketPath)).toBe(true);
      } finally {
        await closeServer(replacement);
      }
    },
  );
});
