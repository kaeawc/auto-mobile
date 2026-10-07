import { expect, test } from "bun:test";
import { createServer } from "node:net";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { createFileBackedDbHarness } from "../db/withFileBackedDb";
import { DaemonClient } from "../../src/daemon/client";
import { DaemonManager } from "../../src/daemon/manager";
import { isCompleteRecoveryRecord } from "../../src/daemon/identityRecovery";
import type { PidFileData } from "../../src/daemon/types";

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("No TCP address");
  }
  await new Promise<void>((done, reject) =>
    server.close((error) => (error ? reject(error) : done())),
  );
  return address.port;
}

test.skipIf(process.platform === "win32")(
  "isolated live daemon restores its deleted PID record atomically without replacing its generation",
  async () => {
    const harness = createFileBackedDbHarness();
    // Short /tmp paths also fit Darwin's Unix-domain socket pathname limit.
    const dir = await harness.makeTempDbDir("am-id-");
    const pid = join(dir, "daemon.pid");
    const socket = join(dir, "daemon.sock");
    const lock = join(dir, "daemon.lock");
    const dbPath = join(dir, "auto-mobile.db");
    const root = resolve(import.meta.dir, "../..");
    const child = Bun.spawn(
      [
        process.execPath,
        "--config=",
        join(root, "src/index.ts"),
        "--daemon-mode",
        "--port",
        String(await unusedPort()),
        "--strict-port",
      ],
      {
        cwd: dir,
        env: {
          ...process.env,
          AUTOMOBILE_DATA_DIR: join(dir, "data"),
          AUTOMOBILE_LOG_DIR: join(dir, "logs"),
          AUTOMOBILE_DB_PATH: dbPath,
          AUTOMOBILE_DAEMON_PID_FILE_PATH: pid,
          AUTOMOBILE_DAEMON_SOCKET_PATH: socket,
          AUTOMOBILE_DAEMON_LOCK_FILE_PATH: lock,
          AUTOMOBILE_AUX_SOCKET_DIR: dir,
          AUTOMOBILE_WEBRTC_STREAM_SOCKET_PATH: join(dir, "webrtc-stream.sock"),
          AUTO_MOBILE_WEBRTC_STREAM_SOCKET_PATH: join(dir, "webrtc-stream.sock"),
          AUTOMOBILE_DAEMON_LAUNCH_CWD: dir,
          AUTOMOBILE_SKIP_CTRL_PROXY_DOWNLOAD: "1",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const stdout = new Response(child.stdout).text();
    const stderr = new Response(child.stderr).text();
    try {
      const deadline = Date.now() + 25000;
      let before: PidFileData | undefined;
      while (Date.now() < deadline && child.exitCode === null) {
        if (existsSync(pid) && existsSync(socket)) {
          const record = JSON.parse(readFileSync(pid, "utf8"));
          if (
            record.daemonSessionId &&
            isCompleteRecoveryRecord(
              record,
              (await new DaemonClient(socket).getDaemonStatus()).reportedSockets ?? {},
            )
          ) {
            before = record;
            break;
          }
        }
        await Bun.sleep(25);
      }
      if (!before) {
        throw new Error(`Daemon did not publish complete metadata; exit=${child.exitCode}`);
      }
      expect(before.pid).toBe(child.pid);
      expect(before.dbPath).toBe(dbPath);
      expect(Object.values(before.sockets!).every((path) => path.startsWith(dir + "/"))).toBe(true);
      const client = new DaemonClient(socket);
      const live = await client.getDaemonStatus();
      expect(live).toMatchObject({
        pid: before.pid,
        reportedPidFilePath: pid,
        reportedSocketPath: socket,
        reportedSockets: before.sockets,
        startedAt: before.startedAt,
        ...(before.processGenerationToken
          ? { processGenerationToken: before.processGenerationToken }
          : {}),
        ...(before.processGenerationTokenUtc
          ? { processGenerationTokenUtc: before.processGenerationTokenUtc }
          : {}),
        buildId: before.buildId,
      });
      unlinkSync(pid); // The reproduction removes ONLY the isolated PID file.
      expect(existsSync(socket)).toBe(true);
      const manager = new DaemonManager(undefined, undefined, undefined, lock, pid, socket);
      const recovered = await manager.status();
      expect(recovered.recovery).toEqual({ state: "repaired" });
      expect(JSON.parse(readFileSync(pid, "utf8"))).toEqual(before);
      expect(await manager.status()).toMatchObject({ running: true, pid: before.pid, dbPath });
      expect(await client.getDaemonStatus()).toMatchObject({
        pid: before.pid,
        startedAt: before.startedAt,
        ...(before.processGenerationToken
          ? { processGenerationToken: before.processGenerationToken }
          : {}),
        ...(before.processGenerationTokenUtc
          ? { processGenerationTokenUtc: before.processGenerationTokenUtc }
          : {}),
      });
      expect(child.exitCode).toBeNull();
    } finally {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
      }
      const exited = await Promise.race([
        child.exited.then(() => true),
        Bun.sleep(2000).then(() => false),
      ]);
      if (!exited) {
        child.kill("SIGKILL");
        await child.exited;
      }
      const output = (await stdout) + (await stderr);
      if (child.exitCode !== 0) {
        console.error(output.slice(-8000));
      }
      await harness.cleanup();
    }
  },
  35000,
);
