import type { HostCommandExecutor } from "../HostCommandExecutor";
import { DefaultHostCommandExecutor } from "../HostCommandExecutor";
import type { Timer } from "../SystemTimer";
import { defaultTimer } from "../SystemTimer";
import { logger } from "../logger";
import { errorMessage } from "../describeUnknownError";

/** Matches a `kill -0` failure caused by the target being owned by another
 * user/process (EPERM), not by it being gone (ESRCH). The process exists in
 * this case, so callers must not treat the failure as "not running". */
const PERMISSION_DENIED_PATTERN = /operation not permitted|permission denied/i;

export interface CtrlProxyProcessInfo {
  readonly ppid?: number;
  readonly command: string;
  readonly environment?: string;
}

export interface CtrlProxyExternalProcess {
  readonly pid: number;
  readonly port: number;
}

interface ProcessClientOptions {
  readonly releaseAttempts?: number;
  readonly releaseGraceMs?: number;
}

/**
 * The sole host-process boundary for the CtrlProxy XCTest runner.
 *
 * Keeping PID discovery, ownership checks and signaling here prevents device IDs,
 * ports and PIDs from being interpolated into shell commands by lifecycle callers.
 */
export class IOSCtrlProxyProcessClient {
  private static readonly DEFAULT_PORT = 8765;
  private readonly releaseAttempts: number;
  private readonly releaseGraceMs: number;

  constructor(
    private readonly host: HostCommandExecutor = new DefaultHostCommandExecutor(),
    private readonly timer: Timer = defaultTimer,
    options: ProcessClientOptions = {},
  ) {
    this.releaseAttempts = options.releaseAttempts ?? 4;
    this.releaseGraceMs = options.releaseGraceMs ?? 250;
  }

  async findExternalXcodebuildCtrlProxyProcess(
    deviceId: string,
    excludedPid?: number,
  ): Promise<CtrlProxyExternalProcess | null> {
    const pids = await this.findPids("xcodebuild", true);
    for (const pid of pids) {
      if (pid === excludedPid) {
        continue;
      }
      const process = await this.getProcessInfo(pid);
      if (!process || !process.command.includes("CtrlProxy")) {
        continue;
      }
      if (this.isDaemonManagedSimulatorXcodebuildProcess(process)) {
        continue;
      }
      if (!this.hasDeviceIdentity(`${process.command} ${process.environment ?? ""}`, deviceId)) {
        continue;
      }
      return {
        pid,
        port:
          this.parseCtrlProxyPort(process.command) ??
          this.parseCtrlProxyPort(process.environment ?? "") ??
          IOSCtrlProxyProcessClient.DEFAULT_PORT,
      };
    }
    return null;
  }

  async findStartupCandidatePids(deadline?: number): Promise<number[]> {
    // The startup sweep caps inspection, so discover only CtrlProxy-shaped
    // commands before the cap rather than letting unrelated xcodebuild work
    // consume it.
    return this.findPids("CtrlProxy", false, deadline);
  }

  async findXcodebuildPids(): Promise<number[]> {
    return this.findPids("xcodebuild", true);
  }

  async findListeningPids(port: number): Promise<number[]> {
    try {
      const { stdout } = await this.host.executeCommand("lsof", [
        "-nP",
        `-iTCP:${port}`,
        "-sTCP:LISTEN",
        "-Fp",
      ]);
      return [
        ...new Set(
          stdout.split("\n").flatMap((line) => {
            const match = line.match(/^p(\d+)$/);
            return match ? [Number.parseInt(match[1], 10)] : [];
          }),
        ),
      ];
    } catch (error) {
      logger.debug(`[IOSCtrlProxy] Failed to find listener PIDs for port ${port}: ${error}`);
      return [];
    }
  }

  async getProcessInfo(pid: number, deadline?: number): Promise<CtrlProxyProcessInfo | null> {
    try {
      const { stdout } = await this.executeCommand(
        "ps",
        ["-p", String(pid), "-o", "ppid=", "-o", "args="],
        deadline,
      );
      const output = stdout.trim();
      if (!output) {
        return null;
      }
      const environment = await this.getProcessEnvironment(pid, deadline);
      const match = output.match(/^(\d+)\s+([\s\S]+)$/);
      return match
        ? { ppid: Number.parseInt(match[1], 10), command: match[2], environment }
        : { command: output, environment };
    } catch (error) {
      logger.debug(`[IOSCtrlProxy] Failed to inspect PID ${pid}: ${error}`);
      return null;
    }
  }

  async isRunning(pid: number, deadline?: number): Promise<boolean> {
    try {
      const result = await this.executeCommand("kill", ["-0", String(pid)], deadline);
      return !PERMISSION_DENIED_PATTERN.test(result.stderr);
    } catch (error) {
      // A command error means the process is unavailable only while the
      // caller's cleanup budget remains. Do not turn deadline expiry into a
      // successful exit observation.
      this.remainingTimeoutMs(deadline);
      logger.debug(`[IOSCtrlProxy] Failed to check PID ${pid}: ${error}`);
      // `kill -0` exits non-zero for both EPERM (process exists, owned by
      // another user) and ESRCH (no such process), so the exec seam's throw
      // path can't be told apart by exit code alone. Classify from the
      // wrapped error text: EPERM means the process is alive (#6137).
      return PERMISSION_DENIED_PATTERN.test(errorMessage(error));
    }
  }

  async isOwnedRunnerAlive(pid: number, deviceId: string): Promise<boolean> {
    if (!(await this.isRunning(pid))) {
      return false;
    }
    const process = await this.getProcessInfo(pid);
    return (
      !!process &&
      this.isCtrlProxyRunnerCommand(process.command) &&
      this.hasDeviceIdentity(`${process.command} ${process.environment ?? ""}`, deviceId)
    );
  }

  async findDescendantProcessIds(rootPid: number, deadline?: number): Promise<number[]> {
    try {
      const { stdout } = await this.executeCommand("ps", ["-axo", "pid=,ppid="], deadline);
      const children = new Map<number, number[]>();
      for (const line of stdout.trim().split("\n")) {
        const match = line.trim().match(/^(\d+)\s+(\d+)$/);
        if (!match) {
          continue;
        }
        const pid = Number(match[1]);
        const parent = Number(match[2]);
        children.set(parent, [...(children.get(parent) ?? []), pid]);
      }
      const descendants: number[] = [];
      const queue = [...(children.get(rootPid) ?? [])];
      const visited = new Set<number>();
      while (queue.length > 0) {
        const pid = queue.shift()!;
        if (visited.has(pid)) {
          continue;
        }
        visited.add(pid);
        descendants.push(pid);
        queue.push(...(children.get(pid) ?? []));
      }
      return descendants;
    } catch (error) {
      logger.debug(`[IOSCtrlProxy] Failed to enumerate descendants of PID ${rootPid}: ${error}`);
      return [];
    }
  }

  async terminateProcessTree(pid: number, deadline?: number): Promise<void> {
    const descendants = await this.findDescendantProcessIds(pid, deadline);
    const targets = [...descendants].reverse().concat(pid);
    await this.signalGroup(pid, "TERM", deadline);
    await this.signalPids(targets, "TERM", deadline);
    if (await this.waitForExit([pid, ...descendants], deadline)) {
      return;
    }
    await this.signalGroup(pid, "KILL", deadline);
    await this.signalPids(targets, "KILL", deadline);
    if (!(await this.waitForExit([pid, ...descendants], deadline))) {
      throw new Error(`CtrlProxy process tree rooted at PID ${pid} remained alive after SIGKILL`);
    }
  }

  async terminateProcess(pid: number): Promise<void> {
    await this.signalPids([pid], "TERM");
    if (await this.waitForExit([pid])) {
      return;
    }
    await this.signalPids([pid], "KILL");
    await this.waitForExit([pid]);
  }

  hasDeviceIdentity(text: string, deviceId: string): boolean {
    return (
      text.includes(`id=${deviceId}`) ||
      text.includes(`AUTOMOBILE_DEVICE_ID=${deviceId}`) ||
      text.includes(`SIMCTL_CHILD_AUTOMOBILE_DEVICE_ID=${deviceId}`)
    );
  }

  isCtrlProxyRunnerCommand(command: string): boolean {
    return (
      command.includes("CtrlProxy") &&
      (command.includes("xcodebuild") ||
        command.includes("CtrlProxyUITests") ||
        command.includes("CtrlProxyUITests-Runner") ||
        command.includes(".xctestrun"))
    );
  }

  isDirectCtrlProxyRunnerCommand(command: string): boolean {
    return command.includes("CtrlProxyUITests-Runner");
  }

  isDaemonManagedSimulatorXcodebuildProcess(process: CtrlProxyProcessInfo): boolean {
    const command = process.command;
    const shape =
      command.includes("xcodebuild") &&
      command.includes("test-without-building") &&
      command.includes("-xctestrun") &&
      command.includes("platform=iOS Simulator") &&
      command.includes("-only-testing:CtrlProxyUITests/CtrlProxyUITests/testRunService") &&
      !command.includes("CTRL_PROXY_IOS_PORT=") &&
      !command.includes("AUTOMOBILE_DEVICE_ID=");
    return (
      shape &&
      (process.ppid === 1 || !this.hasExternalXcodebuildIdentity(process.environment ?? ""))
    );
  }

  private async findPids(pattern: string, exact: boolean, deadline?: number): Promise<number[]> {
    try {
      const { stdout } = await this.executeCommand(
        "pgrep",
        [exact ? "-x" : "-f", pattern],
        deadline,
      );
      return stdout
        .trim()
        .split("\n")
        .flatMap((line) => {
          const pid = Number.parseInt(line, 10);
          return Number.isNaN(pid) ? [] : [pid];
        });
    } catch (error) {
      logger.debug(`[IOSCtrlProxy] Failed to enumerate ${pattern} PIDs: ${error}`);
      return [];
    }
  }

  private async getProcessEnvironment(pid: number, deadline?: number): Promise<string | undefined> {
    try {
      const { stdout } = await this.executeCommand(
        "ps",
        ["eww", "-p", String(pid), "-o", "command="],
        deadline,
      );
      return stdout.trim() || undefined;
    } catch (error) {
      logger.debug(`[IOSCtrlProxy] Failed to inspect environment for PID ${pid}: ${error}`);
      return undefined;
    }
  }

  private parseCtrlProxyPort(text: string): number | null {
    const match = text.match(/(?:^|\s)(?:SIMCTL_CHILD_)?CTRL_PROXY_IOS_PORT=(\d+)(?:\s|$)/);
    return match ? Number.parseInt(match[1], 10) : null;
  }

  private hasExternalXcodebuildIdentity(environment: string): boolean {
    return (
      environment.includes("CTRL_PROXY_IOS_PORT=") ||
      environment.includes("AUTOMOBILE_DEVICE_ID=") ||
      environment.includes("SIMCTL_CHILD_AUTOMOBILE_DEVICE_ID=")
    );
  }

  private async signalGroup(
    pid: number,
    signal: "TERM" | "KILL",
    deadline?: number,
  ): Promise<void> {
    try {
      await this.executeCommand("kill", [`-${signal}`, "--", `-${pid}`], deadline);
    } catch (error) {
      logger.debug(`[IOSCtrlProxy] PID ${pid} is not a signalable process group: ${error}`);
    }
  }

  private async signalPids(
    pids: number[],
    signal: "TERM" | "KILL",
    deadline?: number,
  ): Promise<void> {
    for (const pid of pids) {
      try {
        await this.executeCommand("kill", [`-${signal}`, String(pid)], deadline);
      } catch (error) {
        logger.debug(`[IOSCtrlProxy] PID ${pid} exited before ${signal}: ${error}`);
      }
    }
  }

  private async waitForExit(pids: number[], deadline?: number): Promise<boolean> {
    for (let attempt = 0; attempt < this.releaseAttempts; attempt++) {
      if (await this.haveExited(pids, deadline)) {
        return true;
      }
      const delayMs = this.remainingTimeoutMs(deadline);
      await this.timer.sleep(
        delayMs === undefined ? this.releaseGraceMs : Math.min(this.releaseGraceMs, delayMs),
      );
    }
    return this.haveExited(pids, deadline);
  }

  private async haveExited(pids: number[], deadline?: number): Promise<boolean> {
    for (const pid of pids) {
      if (await this.isRunning(pid, deadline)) {
        return false;
      }
    }
    return true;
  }

  private async executeCommand(
    file: string,
    args: string[],
    deadline?: number,
  ): Promise<Awaited<ReturnType<HostCommandExecutor["executeCommand"]>>> {
    const timeoutMs = this.remainingTimeoutMs(deadline);
    return this.host.executeCommand(
      file,
      args,
      timeoutMs === undefined ? undefined : { timeoutMs },
    );
  }

  private remainingTimeoutMs(deadline: number | undefined): number | undefined {
    if (deadline === undefined) {
      return undefined;
    }
    const remainingMs = deadline - this.timer.now();
    if (remainingMs <= 0) {
      throw new Error("Startup CtrlProxy runner sweep deadline elapsed");
    }
    return remainingMs;
  }
}
