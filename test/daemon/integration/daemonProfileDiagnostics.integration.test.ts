import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Subprocess } from "bun";

const REPOSITORY_ROOT = join(import.meta.dir, "../../..");
const ENTRYPOINT = join(REPOSITORY_ROOT, "src/index.ts");
const STARTUP_TIMEOUT_MS = 10_000;
const CLEANUP_TIMEOUT_MS = 2_000;
const TEST_TIMEOUT_MS = 20_000;

interface IsolatedDaemonEnvironment {
  directory: string;
  environment: NodeJS.ProcessEnv;
  socketPath: string;
}

function createIsolatedDaemonEnvironment(): IsolatedDaemonEnvironment {
  const directory = mkdtempSync(join(tmpdir(), "auto-mobile-profile-diagnostics-"));
  const dataDirectory = join(directory, "data");
  const logDirectory = join(directory, "logs");
  return {
    directory,
    socketPath: join(directory, "daemon.sock"),
    environment: {
      ...process.env,
      HOME: directory,
      AUTOMOBILE_DATA_DIR: dataDirectory,
      AUTOMOBILE_LOG_DIR: logDirectory,
      AUTOMOBILE_DB_PATH: join(directory, "auto-mobile.db"),
      AUTOMOBILE_DAEMON_SOCKET_PATH: join(directory, "daemon.sock"),
      AUTOMOBILE_DAEMON_PID_FILE_PATH: join(directory, "daemon.pid"),
      AUTOMOBILE_DAEMON_LOCK_FILE_PATH: join(directory, "daemon.lock"),
      AUTOMOBILE_SKIP_CTRL_PROXY_DOWNLOAD: "1",
    },
  };
}

async function waitForSocket(
  child: Subprocess,
  socketPath: string,
  timeoutMs = STARTUP_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(socketPath)) {
      return;
    }
    if (child.exitCode !== null) {
      throw new Error(`Daemon exited before publishing its socket (exit ${child.exitCode})`);
    }
    await Bun.sleep(20);
  }
  throw new Error(`Daemon did not publish ${socketPath} within ${timeoutMs}ms`);
}

async function runEntrypoint(
  args: string[],
  environment: NodeJS.ProcessEnv,
  processes: Subprocess[],
): Promise<{ exitCode: number; stderr: string; stdout: string }> {
  const child = Bun.spawn([process.execPath, "--config=", ENTRYPOINT, ...args], {
    cwd: REPOSITORY_ROOT,
    env: environment,
    stdout: "pipe",
    stderr: "pipe",
  });
  processes.push(child);
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

async function stopSubprocess(child: Subprocess): Promise<void> {
  if (child.exitCode !== null) {
    await child.exited;
    return;
  }
  child.kill("SIGTERM");
  const exited = await Promise.race([
    child.exited.then(() => true),
    Bun.sleep(CLEANUP_TIMEOUT_MS).then(() => false),
  ]);
  if (!exited) {
    child.kill("SIGKILL");
    await child.exited;
  }
}

function definedEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

describe("daemon tool-profile diagnostics", () => {
  const tempDirectories: string[] = [];
  const processes: Subprocess[] = [];
  const stdioSessions: Array<{ client: Client; transport: StdioClientTransport }> = [];

  afterEach(async () => {
    for (const { client, transport } of stdioSessions.reverse()) {
      const closed = await Promise.race([
        client
          .close()
          .then(() => true)
          .catch(() => true),
        Bun.sleep(CLEANUP_TIMEOUT_MS).then(() => false),
      ]);
      if (!closed && transport.pid !== null) {
        process.kill(transport.pid, "SIGKILL");
      }
      await transport.close().catch(() => {});
    }
    stdioSessions.length = 0;
    for (const child of processes.reverse()) {
      await stopSubprocess(child);
    }
    processes.length = 0;
    for (const directory of tempDirectories) {
      rmSync(directory, { recursive: true, force: true });
    }
    tempDirectories.length = 0;
  });

  test.skipIf(process.platform === "win32")(
    "status remains readable when the caller tool profile differs or is stale",
    async () => {
      const isolated = createIsolatedDaemonEnvironment();
      tempDirectories.push(isolated.directory);
      const daemon = Bun.spawn([process.execPath, "--config=", ENTRYPOINT, "--daemon-mode"], {
        cwd: REPOSITORY_ROOT,
        env: {
          ...isolated.environment,
          AUTOMOBILE_ENABLED_TOOLS: "listDevices,provisionDevice,deleteDevice",
        },
        stdout: "ignore",
        stderr: "ignore",
      });
      processes.push(daemon);
      await waitForSocket(daemon, isolated.socketPath);

      const differentProfile = await runEntrypoint(
        ["--daemon", "status"],
        {
          ...isolated.environment,
          AUTOMOBILE_ENABLED_TOOLS: "observe,listDevices",
        },
        processes,
      );
      expect(differentProfile.exitCode).toBe(0);
      expect(differentProfile.stdout).toContain("Daemon is running");
      expect(differentProfile.stdout).toContain(`Socket: ${isolated.socketPath}`);
      expect(differentProfile.stderr).toBe("");

      const staleProfile = await runEntrypoint(
        ["--daemon", "status"],
        {
          ...isolated.environment,
          AUTOMOBILE_ENABLED_TOOLS: "getAndroid",
        },
        processes,
      );
      expect(staleProfile.exitCode).toBe(0);
      expect(staleProfile.stdout).toContain("Daemon is running");
      expect(staleProfile.stderr).toBe("");
    },
    TEST_TIMEOUT_MS,
  );

  test.skipIf(process.platform === "win32")(
    "stop remains reachable when the caller tool profile is stale",
    async () => {
      const isolated = createIsolatedDaemonEnvironment();
      tempDirectories.push(isolated.directory);
      // Deliberately omits the `--config=` flag the other cases in this file use
      // to disable bunfig.toml loading (harmless here since bunfig's [test]
      // section only affects `bun test`). `--daemon stop` verifies the daemon's
      // process-table entry via a regex that expects the entry script to
      // immediately follow the bun/node executable in `ps` output; `--config=`
      // interposed between them makes that regex capture "--config=" as the
      // entry script and silently fail to match the real daemon, so stop would
      // never actually find/reap it (tracked separately; not fixed here).
      const daemon = Bun.spawn([process.execPath, ENTRYPOINT, "--daemon-mode"], {
        cwd: REPOSITORY_ROOT,
        env: {
          ...isolated.environment,
          AUTOMOBILE_ENABLED_TOOLS: "listDevices,provisionDevice,deleteDevice",
        },
        stdout: "ignore",
        stderr: "ignore",
      });
      processes.push(daemon);
      await waitForSocket(daemon, isolated.socketPath);

      const result = await runEntrypoint(
        ["--daemon", "stop"],
        {
          ...isolated.environment,
          AUTOMOBILE_ENABLED_TOOLS: "getAndroid",
        },
        processes,
      );

      expect(result.exitCode).toBe(0);
      expect(result.stderr).not.toContain("Unknown tool name \'getAndroid\'");
      await expect(daemon.exited).resolves.toBe(0);
      expect(existsSync(isolated.socketPath)).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  test.skipIf(process.platform === "win32")(
    "stdio returns a structured profile mismatch without closing stdout",
    async () => {
      const isolated = createIsolatedDaemonEnvironment();
      tempDirectories.push(isolated.directory);
      const daemon = Bun.spawn([process.execPath, "--config=", ENTRYPOINT, "--daemon-mode"], {
        cwd: REPOSITORY_ROOT,
        env: {
          ...isolated.environment,
          AUTOMOBILE_ENABLED_TOOLS: "listDevices,provisionDevice,deleteDevice",
        },
        stdout: "ignore",
        stderr: "ignore",
      });
      processes.push(daemon);
      await waitForSocket(daemon, isolated.socketPath);

      const transport = new StdioClientTransport({
        command: process.execPath,
        args: ["--config=", ENTRYPOINT, "--no-daemon"],
        cwd: REPOSITORY_ROOT,
        env: definedEnvironment({
          ...isolated.environment,
          AUTOMOBILE_ENABLED_TOOLS: "observe,listDevices",
        }),
        stderr: "pipe",
      });
      const client = new Client({ name: "profile-mismatch-test", version: "1.0.0" });
      stdioSessions.push({ client, transport });

      await client.connect(transport);
      expect(transport.pid).not.toBeNull();
      const result = await client.callTool({ name: "listDevices", arguments: {} }, undefined, {
        timeout: 5_000,
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toMatch(
        /enabledTools \(tool=observe, requested=enabled, running=unset\).*auto-start is disabled/,
      );
      expect(daemon.exitCode).toBeNull();
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "stdio startup failures emit an actionable stderr diagnostic",
    async () => {
      const isolated = createIsolatedDaemonEnvironment();
      tempDirectories.push(isolated.directory);

      const result = await runEntrypoint(
        [],
        {
          ...isolated.environment,
          AUTOMOBILE_ENABLED_TOOLS: "getAndroid",
        },
        processes,
      );

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("is not a session-configurable tool name");
    },
    TEST_TIMEOUT_MS,
  );
});
