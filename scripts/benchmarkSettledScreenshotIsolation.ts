import { createServer, type AddressInfo } from "node:net";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import nodePath from "node:path";
import {
  DEFAULT_DAEMON_PORT,
  DAEMON_PORT_RANGE_START,
  DAEMON_PORT_RANGE_END,
  DEFAULT_SOCKET_PATH,
  DEFAULT_PID_FILE_PATH,
  LOCK_FILE_PATH,
  SOCKET_PATH,
  PID_FILE_PATH,
} from "../src/daemon/constants";
import { resolvePathFromDaemonLaunchWorkingDirectory } from "../src/utils/workingDirectory";
import { toActionableError } from "../src/models/ActionableError";
import { defaultTimer, type Timer } from "../src/utils/SystemTimer";
import {
  assertPrivateDaemonNamespace,
  type BenchmarkChildEnv,
} from "./benchmarkSettledScreenshotEnv";

export interface BenchmarkLaunchOptions {
  serverPath: string;
  env: BenchmarkChildEnv;
  runDir: string;
  port: number;
}

export interface BenchmarkLaunchSafety {
  homeDir: string;
  builtInResidentPaths: readonly string[];
  effectiveDaemonPaths: readonly string[];
}

/** Resolve only the supplied env; built-in paths can be fixed by callers/tests. */
export function buildLaunchSafety(
  env: BenchmarkChildEnv,
  homeDir: string,
  builtInResidentPaths: readonly [string, string, string],
): BenchmarkLaunchSafety {
  const keys = ["SOCKET_PATH", "PID_FILE_PATH", "LOCK_FILE_PATH"] as const;
  return {
    homeDir,
    builtInResidentPaths,
    effectiveDaemonPaths: keys.map((key, index) => {
      const override = env[`AUTOMOBILE_DAEMON_${key}`] ?? env[`AUTO_MOBILE_DAEMON_${key}`];
      return override
        ? resolvePathFromDaemonLaunchWorkingDirectory(override, env)
        : builtInResidentPaths[index];
    }),
  };
}

// constants.ts exposes no built-in lock constant; derive its sibling from the PID default.
const defaultSafety = buildLaunchSafety(
  {
    AUTOMOBILE_DAEMON_SOCKET_PATH: SOCKET_PATH,
    AUTOMOBILE_DAEMON_PID_FILE_PATH: PID_FILE_PATH,
    AUTOMOBILE_DAEMON_LOCK_FILE_PATH: LOCK_FILE_PATH,
  },
  homedir(),
  [
    DEFAULT_SOCKET_PATH,
    DEFAULT_PID_FILE_PATH,
    nodePath.join(
      nodePath.dirname(DEFAULT_PID_FILE_PATH),
      `${nodePath.parse(DEFAULT_PID_FILE_PATH).name}.lock`,
    ),
  ],
);

function residentPath(path: string, safety: BenchmarkLaunchSafety): boolean {
  const resolved = nodePath.resolve(path);
  const residentDir = nodePath.join(safety.homeDir, ".auto-mobile");
  const displacement = nodePath.relative(residentDir, resolved);
  return (
    displacement === "" ||
    (!displacement.startsWith(`..${nodePath.sep}`) &&
      displacement !== ".." &&
      !nodePath.isAbsolute(displacement)) ||
    resolved.startsWith(nodePath.resolve("/tmp/auto-mobile-daemon-")) ||
    // macOS resolves /tmp through /private/tmp; refuse both spellings.
    resolved.startsWith(nodePath.resolve("/private/tmp/auto-mobile-daemon-")) ||
    safety.builtInResidentPaths.some((value) => nodePath.resolve(value) === resolved)
  );
}

// Run dirs exclude only <homeDir>/.auto-mobile, /tmp/auto-mobile-daemon-*,
// /private/tmp/auto-mobile-daemon-*, and equality with built-in socket/PID/lock paths.
// Namespace paths exclude those locations plus equality with effective daemon paths;
// effective env-derived paths alone never make a run directory resident.
/** Refuse unsafe cleanup targets as well as unsafe child namespaces. */
export function assertPrivateBenchmarkRunDir(
  runDir: string,
  safety: BenchmarkLaunchSafety = defaultSafety,
): void {
  if (!nodePath.isAbsolute(runDir) || nodePath.resolve(runDir) === nodePath.resolve(runDir, "..")) {
    throw new Error("Benchmark run directory must be an absolute, non-root path.");
  }
  if (residentPath(runDir, safety)) {
    throw new Error("Refusing benchmark child launch: resident namespace path.");
  }
}

export function assertBenchmarkPort(port: number): void {
  if (
    !Number.isInteger(port) ||
    port < 1024 ||
    port > 65535 ||
    port === DEFAULT_DAEMON_PORT ||
    (port >= DAEMON_PORT_RANGE_START && port <= DAEMON_PORT_RANGE_END)
  ) {
    throw new Error(
      "Refusing benchmark child launch: port must be 1024..65535 outside the resident daemon port range.",
    );
  }
}

/** Single pre-spawn guard for MCP and stop, including their exact argument contract. */
export function assertPrivateBenchmarkLaunch(
  options: BenchmarkLaunchOptions,
  argv: readonly string[],
  kind: "client" | "stop",
  safety: BenchmarkLaunchSafety = defaultSafety,
): void {
  assertPrivateBenchmarkRunDir(options.runDir, safety);
  const paths = assertPrivateDaemonNamespace(options.env, options.runDir);
  for (const value of Object.values(paths)) {
    if (
      residentPath(value, safety) ||
      safety.effectiveDaemonPaths.some((path) => nodePath.resolve(path) === nodePath.resolve(value))
    ) {
      throw new Error("Refusing benchmark child launch: resident namespace path.");
    }
  }
  for (const key of Object.keys(options.env)) {
    if (
      (key.startsWith("AUTOMOBILE_DAEMON_") || key.startsWith("AUTO_MOBILE_DAEMON_")) &&
      !Object.hasOwn(paths, key)
    ) {
      throw new Error(`Refusing benchmark child launch: leaked parent daemon setting ${key}.`);
    }
  }
  assertBenchmarkPort(options.port);
  const expected = privateBenchmarkArgv(options, kind);
  if (argv.length !== expected.length || argv.some((value, index) => value !== expected[index])) {
    throw new Error(`Refusing benchmark child launch: expected ${expected.join(" ")}.`);
  }
}

function privateBenchmarkArgv(options: BenchmarkLaunchOptions, kind: "client" | "stop"): string[] {
  return [
    options.serverPath,
    ...(kind === "stop" ? ["--daemon", "stop"] : []),
    "--port",
    String(options.port),
    "--strict-port",
  ];
}

/** Both real spawn sites and injected launch seams use this guarded builder. */
export function buildPrivateBenchmarkLaunch(
  options: BenchmarkLaunchOptions,
  kind: "client" | "stop",
  safety?: BenchmarkLaunchSafety,
): { args: string[]; env: Record<string, string> } {
  const args = privateBenchmarkArgv(options, kind);
  assertPrivateBenchmarkLaunch(options, args, kind, safety);
  const env = Object.fromEntries(
    Object.entries(options.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  return { args, env };
}

export interface BenchmarkPortServer {
  once(event: "error", handler: (error: Error) => void): unknown;
  listen(options: { host: string; port: number }, handler: () => void): unknown;
  address(): AddressInfo | string | null | undefined;
  close(handler: (error?: Error) => void): unknown;
}

/** The daemon's default bind host is 127.0.0.1 (daemon.ts and manager.ts). */
export async function pickBenchmarkPort(
  serverFactory: () => BenchmarkPortServer = createServer,
): Promise<number> {
  try {
    const server = serverFactory();
    return await new Promise<number>((resolvePort, reject) => {
      server.once("error", (error) => {
        server.close(() => reject(error));
      });
      server.listen({ host: "127.0.0.1", port: 0 }, () => {
        const address = server.address();
        const port = typeof address === "object" && address !== null ? address.port : 0;
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          try {
            assertBenchmarkPort(port);
            resolvePort(port);
          } catch (validationError) {
            reject(
              toActionableError(
                validationError,
                "OS did not assign a usable private benchmark port",
              ),
            );
          }
        });
      });
    });
  } catch (error) {
    throw toActionableError(
      error,
      "Unable to select an ephemeral benchmark port on 127.0.0.1; check loopback binding permissions and retry",
    );
  }
}

export interface BenchmarkStopChild {
  once(event: "error", handler: (error: Error) => void): unknown;
  once(
    event: "close",
    handler: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  unref(): void;
}
export type BenchmarkStopSpawner = (
  command: string,
  args: string[],
  options: { env: Record<string, string>; stdio: ["ignore", "ignore", "inherit"] },
) => BenchmarkStopChild;

export async function stopPrivateDaemon(
  options: BenchmarkLaunchOptions,
  deps: { spawn: BenchmarkStopSpawner; timer: Timer; safety?: BenchmarkLaunchSafety } = {
    spawn,
    timer: defaultTimer,
  },
): Promise<void> {
  const launch = buildPrivateBenchmarkLaunch(options, "stop", deps.safety);
  const child = deps.spawn(process.execPath, launch.args, {
    env: launch.env,
    stdio: ["ignore", "ignore", "inherit"],
  });
  // Timeout never signals a process; retain the namespace for operator recovery.
  await new Promise<void>((resolveStop, reject) => {
    const timeout = deps.timer.setTimeout(() => {
      child.unref();
      reject(new Error("Private daemon stop timed out after 30000ms."));
    }, 30_000);
    child.once("error", (error) => {
      deps.timer.clearTimeout(timeout);
      reject(
        toActionableError(
          error,
          "Private daemon stop could not launch; retain the private namespace for recovery",
        ),
      );
    });
    child.once("close", (code, signal) => {
      deps.timer.clearTimeout(timeout);
      if (code === 0) {
        resolveStop();
      } else {
        reject(new Error(`Private daemon stop exited with ${signal ?? code}.`));
      }
    });
  });
}
