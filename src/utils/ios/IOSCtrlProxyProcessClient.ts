import type { HostCommandExecutor } from "../HostCommandExecutor";
import { DefaultHostCommandExecutor } from "../HostCommandExecutor";
import type { Timer } from "../SystemTimer";
import { defaultTimer } from "../SystemTimer";

export interface IOSCtrlProxyProcessInfo {
  readonly ppid?: number;
  readonly command: string;
  readonly environment?: string;
}

export interface IOSCtrlProxyExternalProcess {
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
    options: ProcessClientOptions = {}
  ) {
    this.releaseAttempts = options.releaseAttempts ?? 4;
    this.releaseGraceMs = options.releaseGraceMs ?? 250;
  }

  async findExternalXcodebuildCtrlProxyProcess(
    deviceId: string,
    excludedPid?: number
  ): Promise<IOSCtrlProxyExternalProcess | null> {
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
      return { pid, port: this.parseCtrlProxyPort(process.command) ?? this.parseCtrlProxyPort(process.environment ?? "") ?? IOSCtrlProxyProcessClient.DEFAULT_PORT };
    }
    return null;
  }

  async findStartupCandidatePids(): Promise<number[]> {
    const pids = new Set<number>();
    for (const [pattern, exact] of [["xcodebuild", true], ["CtrlProxyUITests-Runner", false]] as const) {
      for (const pid of await this.findPids(pattern, exact)) {
        pids.add(pid);
      }
    }
    return [...pids];
  }

  async findXcodebuildPids(): Promise<number[]> {
    return this.findPids("xcodebuild", true);
  }

  async findListeningPids(port: number): Promise<number[]> {
    try {
      const { stdout } = await this.host.executeCommand("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp"]);
      return [...new Set(stdout.split("\n").flatMap(line => {
        const match = line.match(/^p(\d+)$/);
        return match ? [Number.parseInt(match[1], 10)] : [];
      }))];
    } catch {
      return [];
    }
  }

  async getProcessInfo(pid: number): Promise<IOSCtrlProxyProcessInfo | null> {
    try {
      const { stdout } = await this.host.executeCommand("ps", ["-p", String(pid), "-o", "ppid=", "-o", "args="]);
      const output = stdout.trim();
      if (!output) {
        return null;
      }
      const environment = await this.getProcessEnvironment(pid);
      const match = output.match(/^(\d+)\s+([\s\S]+)$/);
      return match ? { ppid: Number.parseInt(match[1], 10), command: match[2], environment } : { command: output, environment };
    } catch {
      return null;
    }
  }

  async isRunning(pid: number): Promise<boolean> {
    try {
      const result = await this.host.executeCommand("kill", ["-0", String(pid)]);
      return !/operation not permitted|permission denied/i.test(result.stderr);
    } catch {
      return false;
    }
  }

  async isOwnedRunnerAlive(pid: number, deviceId: string): Promise<boolean> {
    if (!await this.isRunning(pid)) {
      return false;
    }
    const process = await this.getProcessInfo(pid);
    return !!process && this.isCtrlProxyRunnerCommand(process.command) &&
      this.hasDeviceIdentity(`${process.command} ${process.environment ?? ""}`, deviceId);
  }

  async findDescendantProcessIds(rootPid: number): Promise<number[]> {
    try {
      const { stdout } = await this.host.executeCommand("ps", ["-axo", "pid=,ppid="]);
      const children = new Map<number, number[]>();
      for (const line of stdout.trim().split("\n")) {
        const match = line.trim().match(/^(\d+)\s+(\d+)$/);
        if (!match) {continue;}
        const pid = Number(match[1]);
        const parent = Number(match[2]);
        children.set(parent, [...(children.get(parent) ?? []), pid]);
      }
      const descendants: number[] = [];
      const queue = [...(children.get(rootPid) ?? [])];
      const visited = new Set<number>();
      while (queue.length > 0) {
        const pid = queue.shift()!;
        if (visited.has(pid)) {continue;}
        visited.add(pid);
        descendants.push(pid);
        queue.push(...(children.get(pid) ?? []));
      }
      return descendants;
    } catch {
      return [];
    }
  }

  async terminateProcessTree(pid: number): Promise<void> {
    const descendants = await this.findDescendantProcessIds(pid);
    const targets = [...descendants].reverse().concat(pid);
    await this.signalGroup(pid, "TERM");
    await this.signalPids(targets, "TERM");
    if (await this.waitForExit([pid, ...descendants])) {return;}
    await this.signalGroup(pid, "KILL");
    await this.signalPids(targets, "KILL");
    await this.waitForExit([pid, ...descendants]);
  }

  async terminateProcess(pid: number): Promise<void> {
    await this.signalPids([pid], "TERM");
    if (await this.waitForExit([pid])) {return;}
    await this.signalPids([pid], "KILL");
    await this.waitForExit([pid]);
  }

  hasDeviceIdentity(text: string, deviceId: string): boolean {
    return text.includes(`id=${deviceId}`) || text.includes(`AUTOMOBILE_DEVICE_ID=${deviceId}`) || text.includes(`SIMCTL_CHILD_AUTOMOBILE_DEVICE_ID=${deviceId}`);
  }

  isCtrlProxyRunnerCommand(command: string): boolean {
    return command.includes("CtrlProxy") && (command.includes("xcodebuild") || command.includes("CtrlProxyUITests") || command.includes("CtrlProxyUITests-Runner") || command.includes(".xctestrun"));
  }

  isDirectCtrlProxyRunnerCommand(command: string): boolean {
    return command.includes("CtrlProxyUITests-Runner");
  }

  isDaemonManagedSimulatorXcodebuildProcess(process: IOSCtrlProxyProcessInfo): boolean {
    const command = process.command;
    const shape = command.includes("xcodebuild") && command.includes("test-without-building") && command.includes("-xctestrun") && command.includes("platform=iOS Simulator") && command.includes("-only-testing:CtrlProxyUITests/CtrlProxyUITests/testRunService") && !command.includes("CTRL_PROXY_IOS_PORT=") && !command.includes("AUTOMOBILE_DEVICE_ID=");
    return shape && (process.ppid === 1 || !this.hasExternalXcodebuildIdentity(process.environment ?? ""));
  }

  private async findPids(pattern: string, exact: boolean): Promise<number[]> {
    try {
      const { stdout } = await this.host.executeCommand("pgrep", [exact ? "-x" : "-f", pattern]);
      return stdout.trim().split("\n").flatMap(line => {
        const pid = Number.parseInt(line, 10);
        return Number.isNaN(pid) ? [] : [pid];
      });
    } catch {
      return [];
    }
  }

  private async getProcessEnvironment(pid: number): Promise<string | undefined> {
    try {
      const { stdout } = await this.host.executeCommand("ps", ["eww", "-p", String(pid), "-o", "command="]);
      return stdout.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  private parseCtrlProxyPort(text: string): number | null {
    const match = text.match(/(?:^|\s)(?:SIMCTL_CHILD_)?CTRL_PROXY_IOS_PORT=(\d+)(?:\s|$)/);
    return match ? Number.parseInt(match[1], 10) : null;
  }

  private hasExternalXcodebuildIdentity(environment: string): boolean {
    return environment.includes("CTRL_PROXY_IOS_PORT=") || environment.includes("AUTOMOBILE_DEVICE_ID=") || environment.includes("SIMCTL_CHILD_AUTOMOBILE_DEVICE_ID=");
  }

  private async signalGroup(pid: number, signal: "TERM" | "KILL"): Promise<void> {
    try { await this.host.executeCommand("kill", [`-${signal}`, "--", `-${pid}`]); } catch { /* not a group leader */ }
  }

  private async signalPids(pids: number[], signal: "TERM" | "KILL"): Promise<void> {
    for (const pid of pids) {
      try { await this.host.executeCommand("kill", [`-${signal}`, String(pid)]); } catch { /* exited race */ }
    }
  }

  private async waitForExit(pids: number[]): Promise<boolean> {
    for (let attempt = 0; attempt < this.releaseAttempts; attempt++) {
      if (await this.haveExited(pids)) {return true;}
      await this.timer.sleep(this.releaseGraceMs);
    }
    return this.haveExited(pids);
  }

  private async haveExited(pids: number[]): Promise<boolean> {
    for (const pid of pids) {
      if (await this.isRunning(pid)) {return false;}
    }
    return true;
  }
}
