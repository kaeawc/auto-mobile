import type {
  HostChildProcess as ChildProcess,
  HostProcessExecutor,
} from "../../utils/HostCommandExecutor";
import type { Timer } from "../../utils/SystemTimer";
import { DefaultProcessSupervisor } from "../../utils/ProcessSupervisor";
import { exponentialBackoff } from "../../utils/Backoff";
import { runDetachedFromPerf, trackAmbient } from "../../utils/PerfContext";
import { logger } from "../../utils/logger";
import { errorMessage } from "../../utils/describeUnknownError";
import { ActionableError, toActionableError } from "../../models/ActionableError";

const IPROXY_GRACEFUL_STOP_TIMEOUT_MS = 1000;
export interface IosTunnelStart {
  localPort: number;
  devicePort?: number;
  udid: string;
  supervise?: boolean;
  allowServicePortReallocation?: boolean;
}
export interface IosTunnelClient {
  readonly localPort: number | null;
  readonly devicePort: number | null;
  start(options: IosTunnelStart): Promise<void>;
  isAlive(): Promise<boolean>;
  stop(options?: {
    clearDevicePort?: boolean;
    stopSupervisor?: boolean;
    force?: boolean;
  }): Promise<void>;
  supervise(): Promise<void>;
}
export interface RemoteIosTunnelRunner {
  startIproxy(params: {
    deviceId: string;
    localPort: number;
    devicePort?: number;
  }): Promise<{ success: boolean; error?: string; data?: { pid: number } }>;
  stopIproxy(params: { pid?: number }): Promise<{ success: boolean; error?: string }>;
  getIproxyStatus(params: {
    pid?: number;
  }): Promise<{ success: boolean; error?: string; data?: { running: boolean } }>;
}
interface TunnelOptions {
  processExecutor: HostProcessExecutor;
  timer: Timer;
  remoteRunner: RemoteIosTunnelRunner;
  useRemoteRunner(): boolean;
  isRunning(pid: number): Promise<boolean>;
  isConnected(): Promise<boolean>;
  prepareRemoteStart(options: IosTunnelStart): Promise<number>;
  restart(): Promise<void>;
}

/** Sole owner of the physical iOS USB tunnel. Runner/port allocation policy stays with the manager. */
export class DefaultIosTunnelClient implements IosTunnelClient {
  private iproxyProcessId: number | null = null;
  private iproxyProcess: ChildProcess | null = null;
  private iproxyDevicePort: number | null = null;
  private iproxyLocalPort: number | null = null;
  private stopping = false;
  private generation = 0;
  private lastStart: IosTunnelStart | null = null;
  private readonly iproxySupervisor: DefaultProcessSupervisor;
  private readonly timer: Timer;
  private readonly processExecutor: HostProcessExecutor;
  constructor(private readonly options: TunnelOptions) {
    this.timer = options.timer;
    this.processExecutor = options.processExecutor;
    this.iproxySupervisor = new DefaultProcessSupervisor({
      name: "iOS iproxy tunnel",
      timer: this.timer,
      monitorIntervalMs: 5000,
      restartBackoff: exponentialBackoff({ initialDelayMs: 1000, maxDelayMs: 15000 }),
      restart: () => {
        this.diagnostic("restart");
        return options.restart();
      },
      isAlive: () => this.isSupervisedIproxyTunnelAlive(),
      onExit: () => {
        this.diagnostic("exit");
        this.iproxyProcessId = null;
        this.iproxyProcess = null;
        this.iproxyLocalPort = null;
      },
      onRestartFailure: (error) =>
        logger.warn(`[IOSCtrlProxy] Failed to restart iproxy: ${errorMessage(error)}`),
    });
  }
  get localPort(): number | null {
    return this.iproxyLocalPort;
  }
  get devicePort(): number | null {
    return this.iproxyDevicePort;
  }
  supervise(): Promise<void> {
    return this.iproxySupervisor.start();
  }
  private diagnostic(event: string): void {
    logger.info(
      `[IosTunnel] ${JSON.stringify({ event, binary: "iproxy", version: "unverified", udid: this.lastStart?.udid, localPort: this.iproxyLocalPort, devicePort: this.iproxyDevicePort })}`,
    );
  }
  public async start(options: IosTunnelStart): Promise<void> {
    this.stopping = false;
    this.lastStart = options;
    if (this.options.useRemoteRunner()) {
      return this.startRemoteIproxyTunnel(options);
    }
    try {
      await this.startLocal(options);
    } catch (error) {
      await this.stop({ stopSupervisor: options.supervise !== false });
      throw toActionableError(
        error,
        `Failed to start iproxy for ${options.udid} on localhost:${options.localPort}; verify libusbmuxd and USB connectivity`,
      );
    }
  }
  private async startLocal(options: IosTunnelStart): Promise<void> {
    if (this.iproxyProcessId && (await this.options.isRunning(this.iproxyProcessId))) {
      if (this.iproxyLocalPort === options.localPort) {
        if (options.supervise !== false) {
          await this.iproxySupervisor.start();
        }
        return;
      }
      // The live tunnel forwards a different host port than the runner will use
      // (#10232). Reusing it would leave health polling and the WebSocket client
      // dialling a port nothing forwards, so replace it, stopping it by its
      // recorded handle before the new one is spawned.
      logger.warn(
        `[IOSCtrlProxy] Live iproxy tunnel forwards localhost:${this.iproxyLocalPort ?? "unknown"} ` +
          `but the runner port is ${options.localPort}; restarting the tunnel`,
      );
    }

    await this.stop({ stopSupervisor: options.supervise !== false });
    const generation = this.generation;

    logger.info(
      `[IOSCtrlProxy] Starting iproxy tunnel (localhost:${options.localPort} -> device:${options.localPort})`,
    );
    // Spawn the resident iproxy tunnel detached from any request perf tracker,
    // so its `exit`/`error` callbacks (which drive supervisor restarts) do not
    // capture a completed readiness request's tracker via AsyncLocalStorage
    // (see PerfContext). The startup wait below stays timed under the scope.
    const child = runDetachedFromPerf(() =>
      this.processExecutor.spawn(
        "iproxy",
        [String(options.localPort), String(options.devicePort ?? options.localPort), options.udid],
        { stdio: ["ignore", "pipe", "pipe"] },
      ),
    );
    if (!child.pid) {
      throw new ActionableError(
        "Failed to start iproxy tunnel (no PID); verify libusbmuxd is installed and the USB device is connected",
      );
    }

    this.iproxyProcess = child;
    this.iproxyProcessId = child.pid;
    this.iproxyLocalPort = options.localPort;
    this.stopping = false;
    this.iproxyDevicePort = options.devicePort ?? options.localPort;
    this.diagnostic("start");
    this.captureOutput(child);
    this.watchChild(child);
    await trackAmbient("iproxy startup", () => this.waitForStartup(generation));
    this.diagnostic("ready");
    if (options.supervise !== false) {
      await this.iproxySupervisor.start();
    }
  }

  private watchChild(child: ChildProcess): void {
    child.on("exit", () => {
      if (this.iproxyProcess !== child) {
        return;
      }
      if (!this.stopping) {
        logger.warn("[IOSCtrlProxy] iproxy exited unexpectedly");
        this.iproxySupervisor.processExited();
      }
    });

    child.on("error", (error) => {
      if (this.iproxyProcess !== child) {
        return;
      }
      if (!this.stopping) {
        logger.warn(`[IOSCtrlProxy] iproxy error: ${error.message}`);
        this.iproxySupervisor.processExited();
      }
    });
  }
  private async startRemoteIproxyTunnel(options: IosTunnelStart): Promise<void> {
    if (this.iproxyProcessId) {
      const status = await this.options.remoteRunner.getIproxyStatus({ pid: this.iproxyProcessId });
      if (status.success && status.data?.running) {
        if (options.supervise !== false) {
          await this.iproxySupervisor.start();
        }
        return;
      }
    }

    await this.launchRemoteIproxyTunnel(options);
  }

  private async launchRemoteIproxyTunnel(options: IosTunnelStart): Promise<void> {
    const fixedDevicePort = options.devicePort ?? this.iproxyDevicePort;
    await this.stop({ stopSupervisor: options.supervise !== false });
    const generation = this.generation;
    const localPort = await this.options.prepareRemoteStart(options);
    this.assertGeneration(generation);
    const devicePort = fixedDevicePort ?? localPort;

    const result = await this.launchRemote(options, localPort, devicePort);
    this.iproxyProcessId = result;
    this.iproxyProcess = null;
    this.iproxyLocalPort = localPort;
    this.iproxyDevicePort = devicePort;
    this.stopping = false;
    this.diagnostic("start");
    try {
      this.assertGeneration(generation);
      await this.waitForStartup(generation);
    } catch (error) {
      await this.stop({ stopSupervisor: options.supervise !== false });
      throw toActionableError(
        error,
        `Failed to start host iproxy for ${options.udid}; verify host USB connectivity`,
      );
    }
    this.diagnostic("ready");
    if (options.supervise !== false) {
      await this.iproxySupervisor.start();
    }
  }

  private async launchRemote(
    options: IosTunnelStart,
    localPort: number,
    devicePort: number,
  ): Promise<number> {
    try {
      const result = await this.options.remoteRunner.startIproxy({
        deviceId: options.udid,
        localPort: localPort,
        devicePort,
      });
      if (!result.success || !result.data) {
        throw new ActionableError(
          result.error ||
            "Failed to start iproxy tunnel via remote runner; verify host libusbmuxd and USB connection",
        );
      }

      return result.data.pid;
    } catch (error) {
      throw toActionableError(
        error,
        `Failed to start iproxy tunnel via remote runner for ${options.udid}; verify host libusbmuxd and USB connectivity`,
      );
    }
  }

  public async stop(
    options: { clearDevicePort?: boolean; stopSupervisor?: boolean; force?: boolean } = {},
  ): Promise<void> {
    this.generation++;
    this.stopping = true;
    if (options.stopSupervisor !== false) {
      this.iproxySupervisor.stop();
    }

    if (this.iproxyProcessId || this.iproxyProcess) {
      await this.stopOwnedProcess(options.force);
    }

    this.iproxyProcessId = null;
    this.iproxyProcess = null;
    this.iproxyLocalPort = null;
    if (options.clearDevicePort) {
      this.iproxyDevicePort = null;
    }
  }

  private async stopRemote(): Promise<void> {
    if (!this.iproxyProcessId) {
      return;
    }
    const result = await this.options.remoteRunner.stopIproxy({ pid: this.iproxyProcessId });
    if (!result.success) {
      logger.warn(`[IOSCtrlProxy] Failed to stop host iproxy: ${result.error || "Unknown error"}`);
    }
  }

  private async stopOwnedProcess(force = false): Promise<void> {
    if (this.options.useRemoteRunner()) {
      await this.stopRemote();
    } else if (this.iproxyProcess && typeof this.iproxyProcess.kill === "function") {
      if (force) {
        try {
          this.iproxyProcess.kill("SIGKILL");
        } catch (error) {
          // The tracked child can exit during forced shutdown.
          logger.debug(`[IosTunnel] Forced termination already complete: ${errorMessage(error)}`);
        }
      } else {
        await this.stopLocalIproxyProcess(this.iproxyProcess);
      }
    } else if (this.iproxyProcessId) {
      try {
        process.kill(this.iproxyProcessId, force ? "SIGKILL" : undefined);
      } catch (error) {
        // iproxy may have exited before cleanup; forgetting its retired PID remains safe.
        logger.debug(`[IOSCtrlProxy] iproxy cleanup found no live process: ${errorMessage(error)}`);
      }
    }
  }

  /**
   * Do not discard a local iproxy handle until its child has exited. A SIGTERM
   * request only means Node delivered the signal; it does not mean an iproxy
   * child stopped. Escalate before the owning shutdown path accepts the stop.
   */
  private async stopLocalIproxyProcess(iproxyProcess: ChildProcess): Promise<void> {
    if (iproxyProcess.exitCode !== null) {
      return;
    }
    try {
      iproxyProcess.kill();
    } catch (error) {
      logger.debug(`[IOSCtrlProxy] Local iproxy exited before graceful shutdown: ${error}`);
      return;
    }

    if (await this.waitForLocalIproxyExit(iproxyProcess)) {
      return;
    }

    try {
      iproxyProcess.kill("SIGKILL");
    } catch (error) {
      // Ignore errors if the process exited while escalating.
      logger.debug(`[IOSCtrlProxy] Local iproxy exited before forced shutdown: ${error}`);
    }
    await this.waitForLocalIproxyExit(iproxyProcess);
  }

  private async waitForLocalIproxyExit(iproxyProcess: ChildProcess): Promise<boolean> {
    if (iproxyProcess.exitCode !== null) {
      return true;
    }
    let timeout: NodeJS.Timeout | undefined;
    let complete: () => void = () => {};
    const exited = new Promise<boolean>((resolve) => {
      complete = () => resolve(true);
      iproxyProcess.once("exit", complete);
      iproxyProcess.once("error", complete);
      timeout = this.timer.setTimeout(() => resolve(false), IPROXY_GRACEFUL_STOP_TIMEOUT_MS);
    });
    try {
      return await exited;
    } finally {
      iproxyProcess.removeListener("exit", complete);
      iproxyProcess.removeListener("error", complete);
      if (timeout) {
        this.timer.clearTimeout(timeout);
      }
    }
  }

  private assertGeneration(generation: number): void {
    if (generation !== this.generation) {
      throw new ActionableError("iproxy startup cancelled by tunnel stop; retry the call");
    }
  }

  public async waitForStartup(generation = this.generation): Promise<void> {
    const timeoutMs = this.getStartTimeoutMs();
    const deadline = this.timer.now() + timeoutMs;

    while (this.timer.now() < deadline) {
      this.assertGeneration(generation);
      if (!this.iproxyProcessId) {
        await this.timer.sleep(100);
        continue;
      }
      if (this.options.useRemoteRunner()) {
        const status = await this.options.remoteRunner.getIproxyStatus({
          pid: this.iproxyProcessId,
        });
        if (status.success && status.data?.running) {
          this.assertGeneration(generation);
          return;
        }
      } else if (await this.options.isRunning(this.iproxyProcessId)) {
        this.assertGeneration(generation);
        return;
      }
      await this.timer.sleep(100);
    }

    throw new ActionableError(
      `iproxy failed to stay running within ${timeoutMs}ms; verify USB connectivity and that the host port is free`,
    );
  }

  public getStartTimeoutMs(): number {
    const envValue =
      process.env.AUTOMOBILE_IPROXY_START_TIMEOUT_MS ??
      process.env.AUTO_MOBILE_IPROXY_START_TIMEOUT_MS;
    if (!envValue) {
      return 5000;
    }
    const parsed = Number.parseInt(envValue, 10);
    if (Number.isNaN(parsed) || parsed <= 0) {
      logger.warn(`[IOSCtrlProxy] Invalid iproxy timeout '${envValue}', using default ${5000}ms`);
      return 5000;
    }
    return parsed;
  }

  public async isAlive(): Promise<boolean> {
    if (!this.iproxyProcessId) {
      return false;
    }
    if (this.options.useRemoteRunner()) {
      try {
        const status = await this.options.remoteRunner.getIproxyStatus({
          pid: this.iproxyProcessId,
        });
        return status.success && (status.data?.running ?? false);
      } catch (error) {
        // Remote status call failed; the supervisor should treat iproxy as down
        // and attempt a restart rather than assume the tunnel is still healthy.
        logger.debug(`src/ctrlProxy/IOSCtrlProxyManager.ts fallback failed: ${error}`, error);
        return false;
      }
    }
    return this.options.isRunning(this.iproxyProcessId);
  }

  private async isSupervisedIproxyTunnelAlive(): Promise<boolean> {
    const isConnected = await this.options.isConnected();
    if (!isConnected) {
      logger.warn(
        `[IOSCtrlProxy] Device ${this.lastStart?.udid} not detected, stopping iproxy monitoring`,
      );
      await this.stop({ clearDevicePort: true });
      return true;
    }

    // Check iproxy process liveness — not CtrlProxy health. A temporarily slow
    // CtrlProxy would fail a health check even though the tunnel is fine; restarting
    // the tunnel in that case is harmful. CtrlProxy's own health is covered by the
    // separate process supervisor.
    const iproxyAlive = await this.isAlive();
    if (!iproxyAlive) {
      logger.warn("[IOSCtrlProxy] iproxy process is no longer running, scheduling restart");
      await this.stop({ stopSupervisor: false });
    }
    return iproxyAlive;
  }

  private captureOutput(child: ChildProcess): void {
    if (child.stdout) {
      child.stdout.on("data", (data: Buffer | string) => {
        const output = data.toString().trim();
        if (output) {
          logger.info(`[iproxy stdout] ${output.slice(0, 500)}`);
        }
      });
    }

    if (child.stderr) {
      child.stderr.on("data", (data: Buffer | string) => {
        const output = data.toString().trim();
        if (output) {
          logger.warn(`[iproxy stderr] ${output.slice(0, 500)}`);
        }
      });
    }
  }
}
