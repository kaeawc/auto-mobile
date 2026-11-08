import { tmpdir } from "node:os";
import path from "node:path";
import { ActionableError, toActionableError } from "../../models/ActionableError";
import { DefaultFileSystem, type FileSystem } from "../filesystem/DefaultFileSystem";
import type { SpawnFn } from "../HostCommandExecutor";
import { logger } from "../logger";
import { defaultRandom, type Random } from "../Random";
import type { Timer } from "../SystemTimer";
import { parseDiscoveryIni } from "./emulatorGrpc/emulatorGrpcDiscovery";

export interface NetsimInstance {
  instance: number;
  port: number;
  pid: number;
  stop(): void;
}

export interface NetsimInstanceLauncher {
  start(): Promise<NetsimInstance>;
}

interface NetsimInstanceLauncherOptions {
  emulatorPath(): string;
  spawnFn: SpawnFn;
  timer: Timer;
  random?: Random;
  fs?: Pick<FileSystem, "existsSync" | "readFile">;
  tmpDir?: string;
  platform?: NodeJS.Platform;
}

/** Numbers reserved before netsimd has written its ini, shared across concurrent launches. */
const startingInstances = new Set<string>();

export class DefaultNetsimInstanceLauncher implements NetsimInstanceLauncher {
  private readonly fs;
  private readonly random;
  private readonly tmpDir;

  constructor(private readonly options: NetsimInstanceLauncherOptions) {
    this.fs = options.fs ?? new DefaultFileSystem();
    this.random = options.random ?? defaultRandom;
    this.tmpDir = options.tmpDir ?? tmpdir();
  }

  private claimInstance(): { instance: number; iniPath: string } {
    const first = Math.floor(this.random.next() * 900);
    for (let offset = 0; offset < 900; offset++) {
      const instance = 100 + ((first + offset) % 900);
      const iniPath = path.join(this.tmpDir, `netsim_${instance}.ini`);
      if (!startingInstances.has(iniPath) && !this.fs.existsSync(iniPath)) {
        startingInstances.add(iniPath);
        return { instance, iniPath };
      }
    }
    throw new ActionableError(
      "No free private netsimd instance in 100-999. Remove stale netsim_N.ini files after stopping their owners.",
    );
  }

  async start(): Promise<NetsimInstance> {
    const { instance, iniPath } = this.claimInstance();
    try {
      return await this.startClaimed(instance, iniPath);
    } catch (error) {
      throw toActionableError(
        error,
        "Failed to start private netsimd. Check the Android emulator installation and temporary directory permissions",
      );
    } finally {
      startingInstances.delete(iniPath);
    }
  }

  private async startClaimed(instance: number, iniPath: string): Promise<NetsimInstance> {
    const { spawnFn } = this.options;
    const platform = this.options.platform ?? process.platform;
    const paths = platform === "win32" ? path.win32 : path;
    const binary = paths.join(
      paths.dirname(this.options.emulatorPath()),
      platform === "win32" ? "netsimd.exe" : "netsimd",
    );
    const child = spawnFn(binary, ["-i", String(instance), "--no-web-ui"], { stdio: "ignore" });
    const pid = child.pid;
    let ended = child.exitCode !== null || child.signalCode !== null;
    let stopped = false;
    let spawnError: Error | undefined;
    child.once("exit", () => {
      ended = true;
    });
    child.on("error", (error: Error) => {
      spawnError = error;
      logger.warn("Private netsimd process failed", error);
    });
    const stop = () => {
      if (stopped || ended || pid === undefined) {
        return;
      }
      stopped = true;
      try {
        child.kill();
      } catch (error) {
        logger.warn("Failed to stop private netsimd child", error);
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
