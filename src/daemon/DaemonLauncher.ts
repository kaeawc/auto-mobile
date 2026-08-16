import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { existsSync } from "node:fs";
import { posix, win32 } from "node:path";
import { ActionableError } from "../models";
import { trackProcess, waitForExit, type TrackedChildProcess } from "../utils/ChildProcessTracker";
import { releaseVersion } from "../utils/mcpVersion";
import { defaultTimer, type Timer } from "../utils/SystemTimer";
import { DAEMON_SHUTDOWN_TIMEOUT_MS, DAEMON_VERSION } from "./constants";

export interface DaemonLaunchCommand {
  command: string;
  args: string[];
}

export interface DaemonProcessSpawner {
  spawn(command: string, args: string[], options: SpawnOptions): ChildProcess;
}

export interface DaemonLauncherDependencies {
  entryScript?: string | null;
  version?: string;
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  processExecPath?: string;
  executableExists?: (path: string) => boolean;
  spawn?: DaemonProcessSpawner["spawn"];
  timer?: Timer;
}

export interface DaemonLaunchRequest {
  command: string;
  args: string[];
  spawnOptions: SpawnOptions;
  timeoutMs: number;
  waitForReady: (timeoutMs: number, signal: AbortSignal) => Promise<boolean>;
  /**
   * Rechecks that the exact spawned PID is now the reachable daemon before the
   * launcher terminates it for a readiness timeout.
   */
  isReadyForLaunchedProcess?: (pid: number | undefined) => Promise<boolean>;
  formatFailure: (summary: string) => Promise<Error>;
  formatExitFailure?: (code: number | null, signal: NodeJS.Signals | null) => Promise<Error>;
}

function resolvePackageSpecifier(version: string): string {
  const trimmedVersion = releaseVersion(version.trim());
  if (trimmedVersion.length === 0 || trimmedVersion === "unknown") {
    throw new ActionableError(
      "Cannot spawn AutoMobile daemon via bunx because the current package version is unknown. Run from an installed auto-mobile binary or set MCP_SERVER_VERSION."
    );
  }
  return `@kaeawc/auto-mobile@${trimmedVersion}`;
}

function pathEntries(environment: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  const path = platform === "win32"
    ? environment.Path ?? environment.PATH
    : environment.PATH;
  return path?.split(platform === "win32" ? ";" : posix.delimiter).filter(Boolean) ?? [];
}

function resolveBunxPath(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  executableExists: (path: string) => boolean,
): string | undefined {
  const extensions = platform === "win32"
    ? (environment.PATHEXT?.split(";").filter(extension => /\.(?:com|exe)/i.test(extension)) ?? [".COM", ".EXE"])
    : [""];
  const pathJoin = platform === "win32" ? win32.join : posix.join;
  for (const directory of pathEntries(environment, platform)) {
    for (const extension of extensions) {
      const candidate = pathJoin(directory, `bunx${extension}`);
      if (executableExists(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

function formatRawSpawnError(error: Error): string {
  const details = error as NodeJS.ErrnoException;
  const additions = [
    details.code && !error.message.includes(details.code) ? `code ${details.code}` : undefined,
    details.syscall && !error.message.includes(details.syscall) ? `syscall ${details.syscall}` : undefined,
    details.path && !error.message.includes(details.path) ? `path ${details.path}` : undefined,
  ].filter((value): value is string => value !== undefined);
  return additions.length > 0 ? `${error.message} (${additions.join(", ")})` : error.message;
}

export class DaemonLauncher {
  private readonly entryScript: string | undefined;
  private readonly version: string;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly platform: NodeJS.Platform;
  private readonly processExecPath: string;
  private readonly executableExists: (path: string) => boolean;
  private readonly spawn: DaemonProcessSpawner["spawn"];
  private readonly timer: Timer;

  constructor(dependencies: DaemonLauncherDependencies = {}) {
    this.entryScript = dependencies.entryScript === undefined
      ? process.argv[1]
      : dependencies.entryScript ?? undefined;
    this.version = dependencies.version ?? DAEMON_VERSION;
    this.environment = dependencies.environment ?? process.env;
    this.platform = dependencies.platform ?? process.platform;
    this.processExecPath = dependencies.processExecPath ?? process.execPath;
    this.executableExists = dependencies.executableExists ?? existsSync;
    this.spawn = dependencies.spawn ?? nodeSpawn;
    this.timer = dependencies.timer ?? defaultTimer;
  }

  resolveCommand(): DaemonLaunchCommand {
    if (this.entryScript) {
      return { command: this.processExecPath, args: [this.entryScript, "--daemon-mode"] };
    }

    const bunx = resolveBunxPath(this.environment, this.platform, this.executableExists);
    if (bunx) {
      return { command: bunx, args: ["-y", resolvePackageSpecifier(this.version), "--daemon-mode"] };
    }
    return {
      command: this.processExecPath,
      args: ["x", "-y", resolvePackageSpecifier(this.version), "--daemon-mode"],
    };
  }

  async launchAndWait(request: DaemonLaunchRequest): Promise<void> {
    const daemonProcess = this.spawn(request.command, request.args, {
      ...request.spawnOptions,
      shell: false,
    });
    daemonProcess.unref();

    const readinessAbort = new AbortController();
    let cleanupProcessListeners = () => {};
    const processFailure = new Promise<never>((_, reject) => {
      const rejectWithContext = (summary: string) => {
        void request.formatFailure(summary).then(
          error => {
            reject(error);
            readinessAbort.abort();
          },
          () => {
            reject(new ActionableError(summary));
            readinessAbort.abort();
          },
        );
      };
      const onError = (error: Error) => {
        rejectWithContext(`Daemon subprocess failed to spawn: ${formatRawSpawnError(error)}`);
      };
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        if (request.formatExitFailure) {
          void request.formatExitFailure(code, signal).then(
            error => {
              reject(error);
              readinessAbort.abort();
            },
            () => {
              reject(new ActionableError("Daemon subprocess exited before becoming ready"));
              readinessAbort.abort();
            },
          );
          return;
        }
        const exitCode = code === null ? "unknown" : code.toString();
        const signalDetail = signal ? `, signal ${signal}` : "";
        rejectWithContext(`Daemon subprocess exited before becoming ready (exit code ${exitCode}${signalDetail})`);
      };
      daemonProcess.once("error", onError);
      daemonProcess.once("exit", onExit);
      cleanupProcessListeners = () => {
        daemonProcess.off("error", onError);
        daemonProcess.off("exit", onExit);
      };
    });

    try {
      const ready = await Promise.race([
        request.waitForReady(request.timeoutMs, readinessAbort.signal),
        processFailure,
      ]);
      if (!ready) {
        // A readiness timeout can race the child binding its socket. Recheck the
        // PID-recorded daemon and its connection before signalling the exact
        // spawned handle, so a daemon that became healthy at the deadline lives.
        readinessAbort.abort();
        cleanupProcessListeners();
        if (await request.isReadyForLaunchedProcess?.(daemonProcess.pid) ?? false) {
          return;
        }

        // Keep startup ownership until the child has actually exited. The shared
        // tracker sends SIGTERM, escalates to SIGKILL after the bounded daemon
        // shutdown grace, and waits for the corresponding exit observation.
        const tracker = trackProcess(daemonProcess as TrackedChildProcess);
        await waitForExit(tracker.process, tracker.exitPromise, {
          signal: "SIGTERM",
          timeoutMs: DAEMON_SHUTDOWN_TIMEOUT_MS,
          timer: this.timer,
        });
        throw await request.formatFailure(`Daemon failed to start within ${request.timeoutMs}ms`);
      }
    } finally {
      readinessAbort.abort();
      cleanupProcessListeners();
    }
  }
}
