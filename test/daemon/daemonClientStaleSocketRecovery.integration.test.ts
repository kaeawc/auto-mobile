import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:net";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, platform } from "node:os";
import { DaemonClient } from "../../src/daemon/client";
import type { PidFileData } from "../../src/daemon/types";

const isWindows = platform() === "win32";

describe("DaemonClient stale socket recovery", () => {
  const tempDirs: string[] = [];
  let server: Server | null = null;

  function createTempPaths(): { dir: string; socketPath: string; pidFilePath: string } {
    const dir = mkdtempSync(join(tmpdir(), "daemon-stale-socket-test-"));
    tempDirs.push(dir);
    return {
      dir,
      socketPath: join(dir, "daemon.sock"),
      pidFilePath: join(dir, "daemon.pid"),
    };
  }

  async function createClosedSocketFile(socketPath: string): Promise<void> {
    server = createServer();
    await new Promise<void>((resolve) => server!.listen(socketPath, resolve));
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }

  function writePidFile(pidFilePath: string, socketPath: string): void {
    const pidData: PidFileData = {
      pid: 12345,
      socketPath,
      port: 3000,
      startedAt: 0,
      version: "test",
    };
    writeFileSync(pidFilePath, JSON.stringify(pidData));
  }

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  (isWindows ? test.skip : test)(
    "isAvailable removes socket and PID files when the recorded daemon PID is dead",
    async () => {
      const { socketPath, pidFilePath } = createTempPaths();
      writeFileSync(socketPath, "stale socket placeholder");
      writePidFile(pidFilePath, socketPath);

      const available = await DaemonClient.isAvailable(socketPath, {
        pidFilePath,
        socketPaths: [socketPath],
        isProcessRunning: () => false,
      });

      expect(available).toBe(false);
      expect(existsSync(socketPath)).toBe(false);
      expect(existsSync(pidFilePath)).toBe(false);
    },
  );

  (isWindows ? test.skip : test)(
    "isAvailable leaves files intact when the recorded daemon PID is alive",
    async () => {
      const { socketPath, pidFilePath } = createTempPaths();
      writeFileSync(socketPath, "stale socket placeholder");
      writePidFile(pidFilePath, socketPath);

      const available = await DaemonClient.isAvailable(socketPath, {
        pidFilePath,
        socketPaths: [socketPath],
        isProcessRunning: () => true,
      });

      expect(available).toBe(false);
      expect(existsSync(socketPath)).toBe(true);
      expect(existsSync(pidFilePath)).toBe(true);
    },
  );

  (isWindows ? test.skip : test)(
    "connect cleans stale files and retries after a failed socket connection",
    async () => {
      const { socketPath, pidFilePath } = createTempPaths();
      await createClosedSocketFile(socketPath);
      writePidFile(pidFilePath, socketPath);

      const client = new DaemonClient(socketPath, 50, undefined, {
        pidFilePath,
        socketPaths: [socketPath],
        isProcessRunning: () => false,
      });

      await expect(client.connect()).rejects.toThrow("Daemon socket not found");
      expect(existsSync(socketPath)).toBe(false);
      expect(existsSync(pidFilePath)).toBe(false);
    },
  );
});
