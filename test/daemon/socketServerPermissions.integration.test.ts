import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { mkdtemp, rm, unlink } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { UnixSocketServer } from "../../src/daemon/socketServer";
import { FakeTimer } from "../fakes/FakeTimer";

const isWindows = platform() === "win32";

function createFakeDaemonState() {
  return {
    isInitialized: () => true,
    getSessionManager: () => ({ getSession: () => null, releaseSession: async () => null }),
    getDevicePool: () => ({
      refreshDevices: async () => 0,
      getStats: () => ({ total: 0, idle: 0, assigned: 0, error: 0 }),
      releaseDevice: async () => {},
    }),
  };
}

// Real POSIX mode bits are not enforced on Windows, so these assertions are
// POSIX-only. The hardening still runs on Windows (chmod is skipped there).
describe("UnixSocketServer filesystem permissions (issue #4750)", () => {
  let socketDir: string;
  let socketPath: string;
  let server: UnixSocketServer;

  beforeEach(async () => {
    // Keep the total path short: macOS caps Unix socket paths at ~104 chars.
    socketDir = await mkdtemp(join(tmpdir(), "sp-"));
    socketPath = join(socketDir, "n", "s.sock");
    server = new UnixSocketServer(
      socketPath,
      "http://localhost:0/mcp",
      createFakeDaemonState(),
      new FakeTimer(),
    );
    await server.start();
  });

  afterEach(async () => {
    await server.close();
    if (existsSync(socketPath)) {
      await unlink(socketPath);
    }
    await rm(socketDir, { recursive: true, force: true });
  });

  (isWindows ? test.skip : test)("creates the socket directory with 0o700", () => {
    const dir = join(socketDir, "n");
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  (isWindows ? test.skip : test)("restricts the bound socket file to 0o600", () => {
    expect(statSync(socketPath).mode & 0o777).toBe(0o600);
  });
});
