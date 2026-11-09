import { tmpdir } from "node:os";
import path from "node:path";
import { AMBIENT_ENV, readEnvRaw } from "../../config/env";
import { ActionableError, toActionableError } from "../../models/ActionableError";
import { DefaultFileSystem, type FileSystem } from "../filesystem/DefaultFileSystem";
import type { SpawnFn } from "../HostCommandExecutor";
import { logger } from "../logger";
import { defaultRandom, type Random } from "../Random";
import type { Timer } from "../SystemTimer";
import { FileNetsimInstanceClaims, type NetsimInstanceClaims } from "./NetsimInstanceClaims";
import { parseDiscoveryIni } from "./emulatorGrpc/emulatorGrpcDiscovery";
import { netsimDiscoveryDir, type AdvertisementHost } from "./RunningAvdAdvertisementReader";

export interface NetsimInstance {
  instance: number;
  port: number;
  pid: number;
  stop(): void;
}

export interface NetsimInstanceLauncher {
  start(): Promise<NetsimInstance>;
}

/**
 * The child environment with `--no-shutdown` removed from `NETSIM_ARGS`, so a private netsimd
 * always exits on its own once its emulator disconnects, even after the daemon that started it
 * restarts and loses its stop callback. Undefined when the inherited environment is already safe.
 */
export function privateNetsimSpawnEnv(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> | undefined {
  const raw = readEnvRaw(AMBIENT_ENV.NETSIM_ARGS, env);
  if (raw === undefined) {
    return undefined;
  }
  const tokens = raw.split(/\s+/).filter((token) => token.length > 0);
  const kept = tokens.filter((token) => token !== "--no-shutdown");
  if (kept.length === tokens.length) {
    return undefined;
  }
  const next: Record<string, string | undefined> = { ...env };
  if (kept.length === 0) {
    delete next[AMBIENT_ENV.NETSIM_ARGS.name];
  } else {
    next[AMBIENT_ENV.NETSIM_ARGS.name] = kept.join(" ");
  }
  return next;
}

interface NetsimInstanceLauncherOptions {
  emulatorPath(): string;
  spawnFn: SpawnFn;
  timer: Timer;
  random?: Random;
  fs?: Pick<FileSystem, "existsSync" | "readFile" | "unlink">;
  host?: Pick<AdvertisementHost, "platform" | "tmpDir" | "env">;
  platform?: NodeJS.Platform;
  claims?: NetsimInstanceClaims;
}

interface ClaimedInstance {
  instance: number;
  iniPath: string;
  lockPath: string;
}

/** Numbers reserved before netsimd has written its ini, shared across concurrent launches. */
const startingInstances = new Set<string>();

export class DefaultNetsimInstanceLauncher implements NetsimInstanceLauncher {
  private readonly fs;
  private readonly random;
  private readonly discoveryDir;
  private readonly claims: NetsimInstanceClaims;
  private readonly env: Readonly<Record<string, string | undefined>>;
  private readonly platform: NodeJS.Platform;
  /** Path flavour of the target platform, never the test host's, so injected paths stay stable. */
  private readonly paths: typeof path.posix;

  constructor(private readonly options: NetsimInstanceLauncherOptions) {
    this.fs = options.fs ?? new DefaultFileSystem();
    this.random = options.random ?? defaultRandom;
    this.claims = options.claims ?? new FileNetsimInstanceClaims();
    this.env = options.host?.env ?? process.env;
    this.platform = options.host?.platform ?? options.platform ?? process.platform;
    this.paths = this.platform === "win32" ? path.win32 : path.posix;
    this.discoveryDir = netsimDiscoveryDir(
      options.host ?? {
        platform: options.platform ?? process.platform,
        tmpDir: tmpdir(),
        env: process.env,
      },
    );
  }

  private claimInstance(): ClaimedInstance {
    const first = Math.floor(this.random.next() * 900);
    for (let offset = 0; offset < 900; offset++) {
      const instance = 100 + ((first + offset) % 900);
      const iniPath = this.paths.join(this.discoveryDir, `netsim_${instance}.ini`);
      const lockPath = this.paths.join(this.discoveryDir, `automobile-netsim_${instance}.lock`);
      if (startingInstances.has(iniPath) || this.fs.existsSync(iniPath)) {
        continue;
      }
      if (!this.claims.tryClaim(lockPath)) {
        continue;
      }
      // Re-check after claiming: a netsimd another process started may have published meanwhile.
      if (this.fs.existsSync(iniPath)) {
        this.claims.release(lockPath);
        continue;
      }
      startingInstances.add(iniPath);
      return { instance, iniPath, lockPath };
    }
    throw new ActionableError(
      "No free private netsimd instance in 100-999. Remove stale netsim_N.ini files after stopping their owners.",
    );
  }

  async start(): Promise<NetsimInstance> {
    let claimed: ClaimedInstance | undefined;
    try {
      claimed = this.claimInstance();
      return await this.startClaimed(claimed);
    } catch (error) {
      throw toActionableError(
        error,
        "Failed to start private netsimd. Check the Android emulator installation and temporary directory permissions",
      );
    } finally {
      if (claimed) {
        startingInstances.delete(claimed.iniPath);
      }
    }
  }

  private async startClaimed(claimed: ClaimedInstance): Promise<NetsimInstance> {
    const { instance, iniPath, lockPath } = claimed;
    const { spawnFn } = this.options;
    const binary = this.paths.join(
      this.paths.dirname(this.options.emulatorPath()),
      this.platform === "win32" ? "netsimd.exe" : "netsimd",
    );
    const env = privateNetsimSpawnEnv(this.env);
    let child: ReturnType<SpawnFn>;
    try {
      child = spawnFn(binary, ["-i", String(instance), "--no-web-ui"], {
        stdio: "ignore",
        ...(env ? { env } : {}),
      });
    } catch (error) {
      this.claims.release(lockPath);
      throw error;
    }
    const pid = child.pid;
    let ended = child.exitCode !== null || child.signalCode !== null;
    let stopRequested = false;
    let signalled = false;
    let cleaned = false;
    let spawnError: Error | undefined;
    // Free the instance number only once netsimd is confirmed gone, so a live daemon never looks free.
    const cleanup = () => {
      if (cleaned) {
        return;
      }
      cleaned = true;
      void this.fs.unlink(iniPath).catch((error) => {
        // Only our claimed ini is removed; missing or unremovable stale files are safe to leave for collision checks.
        logger.debug("Failed to remove private netsimd ini", error);
      });
      this.claims.release(lockPath);
    };
    child.once("exit", () => {
      ended = true;
      if (stopRequested) {
        cleanup();
      }
    });
    child.on("error", (error: Error) => {
      spawnError = error;
      logger.warn("Private netsimd process failed", error);
    });
    const stop = () => {
      stopRequested = true;
      if (ended || pid === undefined) {
        cleanup();
        return;
      }
      if (signalled) {
        return;
      }
      try {
        signalled = child.kill();
      } catch (error) {
        logger.warn("Failed to stop private netsimd child", error);
      }
      if (!signalled) {
        // The ini and claim stay until exit is observed; the next stop() retries the signal.
        logger.warn(
          `Private netsimd ${pid} did not accept a stop signal; will retry on next stop.`,
        );
      }
    };
    const checkRunning = () => {
      if (spawnError) {
        throw spawnError;
      }
      if (ended || pid === undefined) {
        throw new ActionableError(
          "Private netsimd exited before publishing its gRPC port. Check the Android emulator installation.",
        );
      }
    };
    try {
      const port = await this.waitForPort(iniPath, checkRunning);
      checkRunning();
      if (pid === undefined) {
        throw new ActionableError("Private netsimd did not provide a child PID.");
      }
      return { instance, port, pid, stop };
    } catch (error) {
      stop();
      throw toActionableError(error, "Private netsimd startup failed");
    }
  }

  private async waitForPort(iniPath: string, checkRunning: () => void): Promise<number> {
    const { timer } = this.options;
    const deadline = timer.now() + 5_000;
    while (true) {
      checkRunning();
      if (this.fs.existsSync(iniPath)) {
        const ini = parseDiscoveryIni(await this.fs.readFile(iniPath));
        const port = Number(ini["grpc.port"]);
        if (Number.isInteger(port) && port > 0 && port <= 65535) {
          return port;
        }
      }
      if (timer.now() >= deadline) {
        throw new ActionableError(
          `Private netsimd did not publish a valid grpc.port in ${iniPath} within 5 seconds. Check temporary directory permissions and the Android emulator installation.`,
        );
      }
      await timer.sleep(Math.min(100, deadline - timer.now()));
    }
  }
}
