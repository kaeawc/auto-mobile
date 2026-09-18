import {
  execFileSync as nodeExecFileSync,
  spawn as nodeSpawn,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { posix, win32 } from "node:path";
import { ActionableError } from "../models";
import { trackProcess, waitForExit, type TrackedChildProcess } from "../utils/ChildProcessTracker";
import { releaseVersion } from "../utils/mcpVersion";
import { logger } from "../utils/logger";
import { defaultTimer, type Timer } from "../utils/SystemTimer";
import { DAEMON_SHUTDOWN_TIMEOUT_MS, DAEMON_VERSION } from "./constants";

export interface DaemonLaunchCommand {
  command: string;
  args: string[];
}

function normalizeEntryScriptPath(entryScript: string): string {
  return entryScript
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/");
}

type CheckoutProvenanceProbe = (checkoutRoot: string) => boolean;

// A stalled remote mount remains an accepted residual risk because this scan is synchronous by
// design and bounded by `ps`; only siblings of the active checkout are probed, limiting the blast radius.
const defaultCheckoutProbe: CheckoutProvenanceProbe = (checkoutRoot) => {
  try {
    const packageJsonPath = checkoutRoot.includes("\\")
      ? win32.join(checkoutRoot, "package.json")
      : posix.join(checkoutRoot, "package.json");
    // Open first and inspect the descriptor so the check and the read see the same file
    // (no check-then-use race); O_NONBLOCK keeps a FIFO from blocking the open.
    const fd = openSync(packageJsonPath, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
    try {
      const packageJsonStat = fstatSync(fd);
      if (!packageJsonStat.isFile() || packageJsonStat.size > 1_048_576) {
        return false;
      }
      const packageJson = JSON.parse(readFileSync(fd, "utf8")) as {
        name?: unknown;
      };
      return packageJson.name === "@kaeawc/auto-mobile";
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    // A failed probe only rules out an untrusted sibling process, so it is safe to swallow.
    logger.debug(`Unable to verify AutoMobile checkout provenance at ${checkoutRoot}: ${error}`);
    return false;
  }
};

function isSiblingJjWorkspaceEntryScript(
  normalizedEntryScript: string,
  normalizedActiveEntryScript: string | undefined,
  entryScript: string,
  activeEntryScript: string | undefined,
  probe: CheckoutProvenanceProbe,
): boolean {
  const distributionSuffix = "/dist/src/index.js";
  if (
    !normalizedEntryScript.endsWith(distributionSuffix) ||
    !normalizedActiveEntryScript?.endsWith("/auto-mobile" + distributionSuffix)
  ) {
    return false;
  }

  const activeCheckoutRoot = normalizedActiveEntryScript.slice(0, -distributionSuffix.length);
  const candidateCheckoutRoot = normalizedEntryScript.slice(0, -distributionSuffix.length);
  const nativeDistributionSuffix = entryScript.includes("\\")
    ? "\\dist\\src\\index.js"
    : distributionSuffix;
  const nativeCandidateCheckoutRoot = entryScript.slice(0, -nativeDistributionSuffix.length);
  const nativeActiveCheckoutRoot = activeEntryScript?.endsWith(nativeDistributionSuffix)
    ? activeEntryScript.slice(0, -nativeDistributionSuffix.length)
    : undefined;
  return (
    posix.dirname(candidateCheckoutRoot) === posix.dirname(activeCheckoutRoot) &&
    nativeActiveCheckoutRoot !== undefined &&
    (entryScript.includes("\\")
      ? win32.dirname(nativeCandidateCheckoutRoot) === win32.dirname(nativeActiveCheckoutRoot)
      : true) &&
    probe(nativeCandidateCheckoutRoot)
  );
}

function isMatchingSourceEntryScript(
  normalizedEntryScript: string,
  activeEntryScript: string | undefined,
): boolean {
  if (!activeEntryScript || !/^(?:\/|[A-Za-z]:\/)/.test(normalizedEntryScript)) {
    return false;
  }
  return normalizedEntryScript === normalizeEntryScriptPath(activeEntryScript);
}

/**
 * Matches the entry-script identities emitted by {@link DaemonLauncher.resolveCommand}.
 *
 * Source checkouts execute `src/index.ts`; packaged npm and Homebrew installs
 * execute `dist/src/index.js`. Keeping these identities beside the launcher
 * prevents process discovery from growing install-layout-specific path regexes.
 *
 * A source entry point has no package identity in its path. It is safe to match
 * only when it is the exact absolute source entry point running this process;
 * accepting every path ending in `src/index.ts` could terminate an unrelated Bun
 * service during explicit daemon restart cleanup.
 */
export function isDaemonEntryScriptPath(
  entryScript: string,
  activeEntryScript: string | undefined = process.argv[1],
  probe: CheckoutProvenanceProbe = defaultCheckoutProbe,
): boolean {
  const normalized = normalizeEntryScriptPath(entryScript);
  if (normalized.endsWith("/src/index.ts")) {
    return isMatchingSourceEntryScript(normalized, activeEntryScript);
  }

  const normalizedActiveEntryScript = activeEntryScript
    ? normalizeEntryScriptPath(activeEntryScript)
    : undefined;
  const isDistributionEntryScript = normalized.endsWith("/dist/src/index.js");

  // Worktrees and renamed checkouts of this repo share the `/auto-mobile/` ancestor
  // segment; with --daemon-mode checked by the caller, this is safe for #7242.
  return (
    (isDistributionEntryScript && normalized === normalizedActiveEntryScript) ||
    isSiblingJjWorkspaceEntryScript(
      normalized,
      normalizedActiveEntryScript,
      entryScript,
      activeEntryScript,
      probe,
    ) ||
    (isDistributionEntryScript && /\/auto-mobile\/.*\/dist\/src\/index\.js$/.test(normalized)) ||
    /\/(?:@kaeawc\/)?auto-mobile\/dist\/src\/index\.js$/.test(normalized) ||
    /\/auto-mobile\/(?:[^/]+\/)?libexec\/dist\/src\/index\.js$/.test(normalized)
  );
}

export interface DaemonProcessSpawner {
  spawn(command: string, args: string[], options: SpawnOptions): ChildProcess;
}

/** Injectable synchronous argv-first boundary for bounded daemon process probes. */
export type DaemonProcessCommandRunner = (
  command: string,
  args: readonly string[],
  options: { timeout: number; env: NodeJS.ProcessEnv },
) => string;

/**
 * Runs a bounded daemon process probe without a shell.
 *
 * Daemon execution belongs here so callers retain narrow test seams without
 * introducing direct child-process invocations elsewhere in `src/daemon`.
 */
export const runDaemonProcessCommand: DaemonProcessCommandRunner = (command, args, options) =>
  nodeExecFileSync(command, args, {
    encoding: "utf-8",
    timeout: options.timeout,
    env: options.env,
  });

/** Signals or probes the dedicated process group created by a detached POSIX spawn. */
export type DaemonProcessGroupKiller = (pid: number, signal: NodeJS.Signals | 0) => void;

export interface DaemonLauncherDependencies {
  entryScript?: string | null;
  version?: string;
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  processExecPath?: string;
  executableExists?: (path: string) => boolean;
  spawn?: DaemonProcessSpawner["spawn"];
  timer?: Timer;
  processGroupKiller?: DaemonProcessGroupKiller;
}

export interface DaemonLaunchRequest {
  command: string;
  args: string[];
  spawnOptions: SpawnOptions;
  /** Attaches any stream relays before readiness probes can complete. */
  onSpawn?: (daemonProcess: ChildProcess) => void;
  timeoutMs: number;
  waitForReady: (timeoutMs: number, signal: AbortSignal) => Promise<boolean>;
  /**
   * Rechecks that the exact spawned PID is now the reachable daemon before the
   * launcher terminates it for a readiness timeout.
   */
  isReadyForLaunchedProcess?: (
    pid: number | undefined,
    timeoutMs: number,
    signal: AbortSignal,
  ) => Promise<boolean>;
  formatFailure: (summary: string) => Promise<Error>;
  formatExitFailure?: (code: number | null, signal: NodeJS.Signals | null) => Promise<Error>;
}

function resolvePackageSpecifier(version: string): string {
  const trimmedVersion = releaseVersion(version.trim());
  if (trimmedVersion.length === 0 || trimmedVersion === "unknown") {
    throw new ActionableError(
      "Cannot spawn AutoMobile daemon via bunx because the current package version is unknown. Run from an installed auto-mobile binary or set MCP_SERVER_VERSION.",
    );
  }
  return `@kaeawc/auto-mobile@${trimmedVersion}`;
}

function pathEntries(environment: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  const path = platform === "win32" ? (environment.Path ?? environment.PATH) : environment.PATH;
  return path?.split(platform === "win32" ? ";" : posix.delimiter).filter(Boolean) ?? [];
}

function resolveBunxPath(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  executableExists: (path: string) => boolean,
): string | undefined {
  const extensions =
    platform === "win32"
      ? (environment.PATHEXT?.split(";").filter((extension) =>
          /\.(?:com|exe)/i.test(extension),
        ) ?? [".COM", ".EXE"])
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
    details.syscall && !error.message.includes(details.syscall)
      ? `syscall ${details.syscall}`
      : undefined,
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
  private readonly processGroupKiller: DaemonProcessGroupKiller;

  constructor(dependencies: DaemonLauncherDependencies = {}) {
    this.entryScript =
      dependencies.entryScript === undefined
        ? process.argv[1]
        : (dependencies.entryScript ?? undefined);
    this.version = dependencies.version ?? DAEMON_VERSION;
    this.environment = dependencies.environment ?? process.env;
    this.platform = dependencies.platform ?? process.platform;
    this.processExecPath = dependencies.processExecPath ?? process.execPath;
    this.executableExists = dependencies.executableExists ?? existsSync;
    this.spawn = dependencies.spawn ?? nodeSpawn;
    this.timer = dependencies.timer ?? defaultTimer;
    this.processGroupKiller = dependencies.processGroupKiller ?? defaultProcessGroupKiller;
  }

  resolveCommand(): DaemonLaunchCommand {
    if (this.entryScript) {
      return { command: this.processExecPath, args: [this.entryScript, "--daemon-mode"] };
    }

    const bunx = resolveBunxPath(this.environment, this.platform, this.executableExists);
    if (bunx) {
      return {
        command: bunx,
        args: ["-y", resolvePackageSpecifier(this.version), "--daemon-mode"],
      };
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
    request.onSpawn?.(daemonProcess);

    const readinessAbort = new AbortController();
    let cleanupProcessListeners = () => {};
    let processFailureObserved = false;
    const processFailure = new Promise<never>((_, reject) => {
      const rejectWithContext = (summary: string) => {
        processFailureObserved = true;
        void request.formatFailure(summary).then(
          (error) => {
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
        processFailureObserved = true;
        if (request.formatExitFailure) {
          void request.formatExitFailure(code, signal).then(
            (error) => {
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
        rejectWithContext(
          `Daemon subprocess exited before becoming ready (exit code ${exitCode}${signalDetail})`,
        );
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
        // Keep the startup listeners installed while the final check awaits so
        // a late child error or exit cannot become unobserved in that window.
        const finalReadinessAbort = new AbortController();
        const isReadyAtDeadline = await this.waitForFinalReadinessCheck(
          request.isReadyForLaunchedProcess?.(
            daemonProcess.pid,
            DAEMON_SHUTDOWN_TIMEOUT_MS,
            finalReadinessAbort.signal,
          ) ?? Promise.resolve(false),
          processFailure,
          finalReadinessAbort,
        );
        if (processFailureObserved) {
          await processFailure;
        }
        if (isReadyAtDeadline) {
          return;
        }
        cleanupProcessListeners();

        // Keep startup ownership until the child has actually exited. Detached
        // POSIX launchers also keep process-group escalation armed after their
        // package-runner wrapper exits, so the daemon descendant is reaped.
        const tracker = trackProcess(daemonProcess as TrackedChildProcess);
        await this.stopTimedOutProcess(
          tracker.process,
          tracker.exitPromise,
          daemonProcess.pid,
          request.spawnOptions.detached === true,
        );
        throw await request.formatFailure(`Daemon failed to start within ${request.timeoutMs}ms`);
      }
    } finally {
      readinessAbort.abort();
      cleanupProcessListeners();
    }
  }

  /**
   * The final check is a grace-period race, not a second unbounded startup
   * phase. The normal connection probe may wait for a long client timeout, so
   * it must not delay cleanup of a child that already missed startup readiness.
   */
  private async waitForFinalReadinessCheck(
    readinessCheck: Promise<boolean>,
    processFailure: Promise<never>,
    readinessAbort: AbortController,
  ): Promise<boolean> {
    let timeout: NodeJS.Timeout | undefined;
    const deadline = new Promise<boolean>((resolve) => {
      timeout = this.timer.setTimeout(() => resolve(false), DAEMON_SHUTDOWN_TIMEOUT_MS);
    });
    try {
      return await Promise.race([readinessCheck, processFailure, deadline]);
    } finally {
      readinessAbort.abort();
      if (timeout) {
        this.timer.clearTimeout(timeout);
      }
    }
  }

  private async stopTimedOutProcess(
    process: TrackedChildProcess,
    exitPromise: Promise<void>,
    pid: number | undefined,
    detached: boolean,
  ): Promise<void> {
    if (!detached || this.platform === "win32" || pid === undefined) {
      await waitForExit(process, exitPromise, {
        signal: "SIGTERM",
        timeoutMs: DAEMON_SHUTDOWN_TIMEOUT_MS,
        timer: this.timer,
      });
      return;
    }

    const signalledProcessGroup = this.signalProcessGroup(process, pid, "SIGTERM");
    let timeout: NodeJS.Timeout | undefined;
    const deadline = new Promise<void>((resolve) => {
      timeout = this.timer.setTimeout(resolve, DAEMON_SHUTDOWN_TIMEOUT_MS);
    });

    try {
      const wrapperExited = await Promise.race([
        exitPromise.then(() => true),
        deadline.then(() => false),
      ]);

      // A `bunx`/`bun x` wrapper can exit while its daemon remains in the same
      // detached group. Keep the grace timer alive when that group still exists.
      if (wrapperExited && !this.isProcessGroupAlive(pid)) {
        return;
      }

      await deadline;
      if (this.isProcessGroupAlive(pid)) {
        this.signalProcessGroup(process, pid, "SIGKILL");
      } else if (!signalledProcessGroup && process.exitCode === null) {
        process.kill("SIGKILL");
      }
      await exitPromise;
    } finally {
      if (timeout) {
        this.timer.clearTimeout(timeout);
      }
    }
  }

  private isProcessGroupAlive(pid: number): boolean {
    try {
      this.processGroupKiller(pid, 0);
      return true;
    } catch (error) {
      logger.debug(`Daemon process group is no longer alive for pid=${pid}: ${error}`);
      return false;
    }
  }

  private signalProcessGroup(
    process: TrackedChildProcess,
    pid: number,
    signal: NodeJS.Signals,
  ): boolean {
    try {
      this.processGroupKiller(pid, signal);
      return true;
    } catch (error) {
      // A vanished group has no descendants left to reap. Fall back to the
      // direct handle for unusual spawn implementations that do not create a
      // group despite receiving `detached: true`.
      logger.debug(
        `Daemon process-group signal failed for pid=${pid}; falling back to the direct child: ${error}`,
      );
      process.kill(signal);
      return false;
    }
  }
}

const defaultProcessGroupKiller: DaemonProcessGroupKiller = (pid, signal) => {
  process.kill(-pid, signal);
};
