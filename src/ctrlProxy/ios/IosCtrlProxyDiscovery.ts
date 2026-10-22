import type { IosCtrlProxyRuntime } from "./IosCtrlProxyRuntime";
import { IosCtrlProxyOrphanReaper } from "./IosCtrlProxyOrphanReaper";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { isValidCtrlProxyPort } from "./IosCtrlProxyHealthClient";
import { IosCtrlProxyProcessClient } from "./IosCtrlProxyProcessClient";
import {
  MAX_STARTUP_ORPHAN_RUNNER_CANDIDATES,
  DIRECT_RUNNER_DISCOVERY_DEADLINE_MS,
  ExternalCtrlProxyProcess,
  ListeningProcess,
  IOS_CTRL_PROXY_DEFAULT_PORT,
  type CtrlProxyProcessLiveness,
} from "./IosCtrlProxyContracts";

interface IosCtrlProxyDiscoveryHost {
  useRemoteRunner(): boolean;
  isProcessRunning(pid: number): Promise<boolean>;
  checkHealthEndpoint(): Promise<boolean>;
  checkHealthEndpointOnPortForDevice(
    port: number,
    deviceId: string,
    timeoutMs?: number,
    options?: { requireDeviceId?: boolean },
  ): Promise<boolean>;
}

/** Identifies owned and external runner processes before adoption or termination. */
export class IosCtrlProxyDiscovery {
  constructor(
    private readonly state: Pick<
      IosCtrlProxyRuntime,
      | "processClient"
      | "xcTestProcessId"
      | "remoteRunner"
      | "device"
      | "servicePort"
      | "timer"
      | "unhealthyRetiredPorts"
    >,
    private readonly host: IosCtrlProxyDiscoveryHost,
  ) {}

  /**
   * Check if a process is still running
   */
  async isProcessRunning(pid: number): Promise<boolean> {
    return this.state.processClient.isRunning(pid);
  }

  /**
   * Whether the runner process WE spawned is alive at the OS level, regardless of
   * whether its health endpoint is up yet. Unlike {@link checkCtrlProxyProcessLiveness}
   * this does NOT require a health response, so a runner still initializing counts
   * as alive — used to avoid killing+respawning our own still-starting runner (#2834).
   */
  async isOwnRunnerProcessAlive(pid: number | null = this.state.xcTestProcessId): Promise<boolean> {
    if (!pid) {
      return false;
    }
    if (this.host.useRemoteRunner()) {
      try {
        const status = await this.state.remoteRunner.status({
          deviceId: this.state.device.deviceId,
          pid: pid,
        });
        // PID-strict: the remote daemon resolves status by deviceId BEFORE pid,
        // so running=true alone is not proof the TRACKED pid is alive — a newer runner
        // for the same device aliases it, and treating it as "ours" would make us wait
        // on (and eventually stop) that newer runner (#2834 review).
        return status.success && (status.data?.running ?? false) && status.data?.pid === pid;
      } catch (error) {
        // A failed remote status call (network/daemon error) is treated the same as
        // "not our tracked runner": returning false here is safe because the caller
        // falls back to local isProcessRunning/re-adoption rather than crashing.
        logger.debug(`src/ctrlProxy/IOSCtrlProxyManager.ts fallback failed: ${error}`, error);
        return false;
      }
    }
    if (!(await this.host.isProcessRunning(pid))) {
      return false;
    }
    // Guard against PID reuse (#2834 review): a bare `kill -0` only proves *some*
    // process holds this PID. Confirm it is genuinely our xcodebuild-launched runner
    // for THIS device before treating it as "still starting" — otherwise a recycled
    // PID (our runner exited, its PID reassigned to an unrelated process) would make
    // us defer to a health endpoint that never comes.
    const info = await this.state.processClient.getProcessInfo(pid);
    if (!info) {
      return false;
    }
    // Require CtrlProxy-specific identity, not merely any xcodebuild for this device
    // (#2834 review): a user's own `xcodebuild … -destination id=<deviceId>` on the same
    // simulator must NOT be mistaken for our runner, or we would wait on it and later
    // terminate it as "hung", killing an unrelated process. Our launch carries CtrlProxy
    // markers ("-only-testing:CtrlProxyUITests…", the automobile-runner xctestrun), so the
    // canonical isOwnedCtrlProxyRunnerProcess predicate (also used by the port-reclaim
    // path) distinguishes it.
    return this.isOwnedCtrlProxyRunnerProcess({
      pid: pid,
      port: this.state.servicePort,
      command: info.command,
      environment: info.environment,
    });
  }

  /**
   * Check if the tracked CtrlProxy process is alive AND still the real CtrlProxy.
   * Used by startInternal() to skip spawning when the process is merely slow.
   *
   * Locally we require both a PID liveness check AND a health endpoint response so
   * that a stale xcTestProcessId that has been PID-reused by a different process
   * does not produce a false "alive" result and cause setup() to silently skip
   * restart; that verdict is `healthy`. A remote runner is judged by its PID-strict
   * status alone, so it is only `alive`: its health was not confirmed (#14493).
   */
  async checkCtrlProxyProcessLiveness(): Promise<CtrlProxyProcessLiveness> {
    if (!this.state.xcTestProcessId) {
      return "dead";
    }
    if (this.host.useRemoteRunner()) {
      try {
        const status = await this.state.remoteRunner.status({
          deviceId: this.state.device.deviceId,
          pid: this.state.xcTestProcessId,
        });
        // PID-strict for the same reason as isOwnRunnerProcessAlive: deviceId-first
        // resolution in the remote daemon means running=true may describe a
        // NEWER runner, not the tracked one. On mismatch we return false and the
        // remote start path re-adopts the device's current runner via
        // status({deviceId}) — the correct adoption point (#2834 review).
        const running =
          status.success &&
          (status.data?.running ?? false) &&
          status.data?.pid === this.state.xcTestProcessId;
        return running ? "alive" : "dead";
      } catch (error) {
        // Remote status call failed; report not-alive so the caller respawns rather
        // than trusting a stale in-memory pid across a daemon error.
        logger.debug(`src/ctrlProxy/IOSCtrlProxyManager.ts fallback failed: ${error}`, error);
        return "dead";
      }
    }
    // First check PID liveness (fast, no network). If the PID is already gone
    // we can skip the health check entirely.
    if (!(await this.host.isProcessRunning(this.state.xcTestProcessId))) {
      return "dead";
    }
    // Also verify CtrlProxy identity via the health endpoint.  A different
    // process could have reused the same PID after CtrlProxy exited without
    // its exit being recorded (e.g. clean exit not caught by the exec callback).
    return (await this.host.checkHealthEndpoint()) ? "healthy" : "dead";
  }

  /**
   * Check if an externally-managed CtrlProxy process (e.g. from hot-reload)
   * is already running CtrlProxy tests. xcodebuild runners expose the simulator
   * id in args; direct simctl-spawned runners are matched by listener port and
   * launchd_sim ancestry.
   */
  async findExternalCtrlProxyProcess(): Promise<ExternalCtrlProxyProcess | null> {
    if (this.host.useRemoteRunner()) {
      return null; // Host-control environments don't have external local runners.
    }
    const externalXcodebuildProcess = await this.findExternalXcodebuildCtrlProxyProcess();
    if (externalXcodebuildProcess) {
      return externalXcodebuildProcess;
    }
    const healthyDirectProcess = await this.findHealthyExternalDirectCtrlProxyProcess();
    if (healthyDirectProcess) {
      return healthyDirectProcess;
    }
    return this.findExternalDirectCtrlProxyProcess();
  }

  private async findExternalXcodebuildCtrlProxyProcess(): Promise<ExternalCtrlProxyProcess | null> {
    for (const pid of await this.state.processClient.findXcodebuildPids()) {
      if (pid === this.state.xcTestProcessId) {
        continue;
      }
      const processInfo = await this.state.processClient.getProcessInfo(pid);
      const argsOut = processInfo?.command ?? "";
      if (
        !argsOut.includes("CtrlProxy") ||
        (await this.state.processClient.isDaemonManagedSimulatorXcodebuildProcess({
          command: argsOut,
          ppid: processInfo?.ppid,
          environment: processInfo?.environment,
        }))
      ) {
        continue;
      }
      if (!this.hasExternalXcodebuildDeviceIdentity(argsOut, processInfo)) {
        continue;
      }
      const port = this.externalXcodebuildCandidatePort(argsOut, processInfo);
      logger.info(`[IOSCtrlProxy] Found external xcodebuild CtrlProxy process: ${pid}`);
      return { pid, port };
    }
    return null;
  }

  /**
   * Finds a healthy direct runner even when `lsof` cannot expose its listener PID.
   *
   * Direct simulator runners inherit their CtrlProxy port, so their process
   * environment identifies a probe candidate. Health is the authority for
   * adoption: it must confirm the exact device before we reserve that port.
   * Daemon-managed trees are deliberately excluded so the regular port-cleanup
   * path still reaps a stale runner whose health endpoint is down.
   */
  private async findHealthyExternalDirectCtrlProxyProcess(): Promise<ExternalCtrlProxyProcess | null> {
    const deadline = this.state.timer.now() + DIRECT_RUNNER_DISCOVERY_DEADLINE_MS;
    const candidatePids = await this.state.processClient.findStartupCandidatePids(deadline);
    const eligibleCandidates: Array<{ pid: number; process: ListeningProcess }> = [];
    for (const pid of candidatePids) {
      if (this.state.timer.now() >= deadline) {
        break;
      }
      if (pid === this.state.xcTestProcessId) {
        continue;
      }
      const processInfo = await this.state.processClient.getProcessInfo(pid, deadline);
      if (
        !processInfo ||
        !this.state.processClient.isDirectCtrlProxyRunnerCommand(processInfo.command)
      ) {
        continue;
      }
      const port = this.directRunnerCandidatePort(processInfo);
      if (port === null) {
        continue;
      }
      const process: ListeningProcess = { pid, port, ...processInfo };
      const daemonManagedRoot = await IosCtrlProxyOrphanReaper.findDaemonManagedRunnerTreeRoot(
        this.state.processClient,
        process,
      );
      if (daemonManagedRoot.kind === "root") {
        continue;
      }
      eligibleCandidates.push({ pid, process });
      if (eligibleCandidates.length >= MAX_STARTUP_ORPHAN_RUNNER_CANDIDATES) {
        break;
      }
    }
    for (const { pid, process } of eligibleCandidates) {
      const remainingTimeoutMs = deadline - this.state.timer.now();
      if (remainingTimeoutMs <= 0) {
        break;
      }
      if (
        !(await this.host.checkHealthEndpointOnPortForDevice(
          process.port,
          this.state.device.deviceId,
          remainingTimeoutMs,
        ))
      ) {
        continue;
      }
      logger.info(`[IOSCtrlProxy] Found healthy external direct CtrlProxy runner: ${pid}`);
      return { pid, port: process.port };
    }
    return null;
  }

  private async findExternalDirectCtrlProxyProcess(): Promise<ExternalCtrlProxyProcess | null> {
    const candidatePorts = new Set([this.state.servicePort, IOS_CTRL_PROXY_DEFAULT_PORT]);

    for (const port of candidatePorts) {
      const listeningProcesses = await this.findListeningProcessesOnPort(port);
      for (const process of listeningProcesses) {
        if (!this.state.processClient.isDirectCtrlProxyRunnerCommand(process.command)) {
          continue;
        }
        // A direct in-simulator runner with a daemon-managed xcodebuild/shell ancestor is
        // stale daemon state, not an external hot-reload runner. Let port cleanup reap
        // the owning tree instead of adopting a runner whose health endpoint is down.
        const daemonManagedRoot = await IosCtrlProxyOrphanReaper.findDaemonManagedRunnerTreeRoot(
          this.state.processClient,
          process,
        );
        if (daemonManagedRoot.kind === "root" && daemonManagedRoot.pid !== process.pid) {
          continue;
        }
        if (!(await this.processAncestryContainsDeviceId(process))) {
          continue;
        }
        if (!(await this.mayAdoptDirectRunnerOnPort(process, port))) {
          continue;
        }
        logger.info(`[IOSCtrlProxy] Found external direct CtrlProxy runner: ${process.pid}`);
        return { pid: process.pid, port };
      }
    }

    return null;
  }

  /**
   * Health-gate a direct runner still listening on a port a forced restart retired
   * as unhealthy (#11205). Killing our xcodebuild leaves the in-simulator runner
   * alive under launchd_sim; a stalled one would otherwise be re-adopted as
   * "external" and waited on for the whole health budget. When it does not answer
   * for this device, terminate it so the caller spawns a fresh runner.
   */
  private async mayAdoptDirectRunnerOnPort(
    process: ListeningProcess,
    port: number,
  ): Promise<boolean> {
    if (!this.state.unhealthyRetiredPorts.has(port)) {
      return true;
    }
    if (
      await this.host.checkHealthEndpointOnPortForDevice(
        port,
        this.state.device.deviceId,
        undefined,
        {
          requireDeviceId: true,
        },
      )
    ) {
      this.state.unhealthyRetiredPorts.delete(port);
      return true;
    }
    logger.warn(
      `[IOSCtrlProxy] CtrlProxy runner ${process.pid} on port ${port} was retired as unhealthy ` +
        `by a forced restart and still fails its health probe; terminating it instead of reusing it`,
    );
    try {
      await this.state.processClient.terminateProcessTree(process.pid);
    } catch (error) {
      // The caller still skips adoption; the port-readiness check before spawn
      // reallocates away from a listener that survived termination.
      logger.warn(
        `[IOSCtrlProxy] Unhealthy retired runner ${process.pid} survived termination: ${errorMessage(error)}`,
      );
    }
    return false;
  }

  private parseCtrlProxyPortFromProcessArgs(args: string): number | null {
    const match = args.match(/(?:^|\s)(?:SIMCTL_CHILD_)?CTRL_PROXY_IOS_PORT=(\d+)(?:\s|$)/);
    if (!match) {
      return null;
    }

    const port = Number.parseInt(match[1], 10);
    return isValidCtrlProxyPort(port) ? port : null;
  }

  async findListeningProcessesOnPort(port: number): Promise<ListeningProcess[]> {
    const processes: ListeningProcess[] = [];
    for (const pid of await this.state.processClient.findListeningPids(port)) {
      const processInfo = await this.state.processClient.getProcessInfo(pid);
      if (processInfo) {
        processes.push({ pid, port, ...processInfo });
      }
    }
    return processes;
  }

  isOwnedCtrlProxyRunnerProcess(process: ListeningProcess): boolean {
    if (!this.state.processClient.isCtrlProxyRunnerCommand(process.command)) {
      return false;
    }
    return (
      this.state.processClient.hasDeviceIdentity(process.command, this.state.device.deviceId) ||
      this.state.processClient.hasDeviceIdentity(
        process.environment ?? "",
        this.state.device.deviceId,
      )
    );
  }

  private async processAncestryContainsDeviceId(process: ListeningProcess): Promise<boolean> {
    let parentPid = process.ppid;
    const visitedPids = new Set<number>();

    while (parentPid !== undefined && parentPid > 1 && !visitedPids.has(parentPid)) {
      visitedPids.add(parentPid);
      const processInfo = await this.state.processClient.getProcessInfo(parentPid);
      if (!processInfo) {
        return false;
      }
      if (
        this.state.processClient.hasDeviceIdentity(
          processInfo.command,
          this.state.device.deviceId,
        ) ||
        processInfo.command.includes(this.state.device.deviceId)
      ) {
        return true;
      }
      parentPid = processInfo.ppid;
    }

    return false;
  }

  async findDaemonManagedRunnerTreeRoot(process: ListeningProcess): Promise<number> {
    const result = await IosCtrlProxyOrphanReaper.findDaemonManagedRunnerTreeRoot(
      this.state.processClient,
      process,
    );
    return result.kind === "root" ? result.pid : process.pid;
  }

  formatListeningProcesses(processes: ListeningProcess[]): string {
    return processes.map((process) => `PID ${process.pid} (cmd: ${process.command})`).join(", ");
  }

  private externalXcodebuildCandidatePort(
    argsOut: string,
    processInfo: Awaited<ReturnType<IosCtrlProxyProcessClient["getProcessInfo"]>>,
  ): number {
    return (
      this.parseCtrlProxyPortFromProcessArgs(argsOut) ??
      this.parseCtrlProxyPortFromProcessArgs(processInfo?.environment ?? "") ??
      IOS_CTRL_PROXY_DEFAULT_PORT
    );
  }

  private hasExternalXcodebuildDeviceIdentity(
    argsOut: string,
    processInfo: Awaited<ReturnType<IosCtrlProxyProcessClient["getProcessInfo"]>>,
  ): boolean {
    const identityText = `${argsOut} ${processInfo?.environment ?? ""}`;
    return this.state.processClient.hasDeviceIdentity(identityText, this.state.device.deviceId);
  }

  private directRunnerCandidatePort(
    processInfo: NonNullable<Awaited<ReturnType<IosCtrlProxyProcessClient["getProcessInfo"]>>>,
  ): number | null {
    return (
      this.parseCtrlProxyPortFromProcessArgs(processInfo.command) ??
      this.parseCtrlProxyPortFromProcessArgs(processInfo.environment ?? "")
    );
  }
}
