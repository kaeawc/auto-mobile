import { describe, expect, test, afterEach } from "bun:test";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { DaemonClient } from "../../src/daemon/client";

describe("DaemonClient.isAvailable", () => {
  let server: Server | null = null;
  const tempDirs: string[] = [];

  function createTempSocketPath(): string {
    const dir = mkdtempSync(join(tmpdir(), "daemon-avail-test-"));
    tempDirs.push(dir);
    return join(dir, "test.sock");
  }

  afterEach(async () => {
    if (server) {
      await new Promise<void>(resolve => server!.close(() => resolve()));
      server = null;
    }
    for (const dir of tempDirs) {
      try {
        const { rmSync } = require("node:fs");
        rmSync(dir, { recursive: true, force: true });
      } catch { /* ignore */ }
    }
    tempDirs.length = 0;
  });

  test("returns true when server is listening", async () => {
    const socketPath = createTempSocketPath();
    server = createServer();
    await new Promise<void>(resolve => server!.listen(socketPath, resolve));

    const result = await DaemonClient.isAvailable(socketPath);
    expect(result).toBe(true);
  });

  test("returns false when socket file does not exist", async () => {
    const socketPath = createTempSocketPath();
    const result = await DaemonClient.isAvailable(socketPath);
    expect(result).toBe(false);
  });

  test("returns false when socket file exists but no server", async () => {
    const socketPath = createTempSocketPath();
    // Create a regular file at the socket path (not a real socket)
    const { writeFileSync } = require("node:fs");
    writeFileSync(socketPath, "not a socket");

    const result = await DaemonClient.isAvailable(socketPath);
    expect(result).toBe(false);
  });
});
