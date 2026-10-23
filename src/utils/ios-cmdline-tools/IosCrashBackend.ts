import type { ExecResult } from "../../models";
import { resolveIosDeviceKind } from "./IosDeviceKind";
import { PhysicalIosCrashBackend } from "./PhysicalIosCrashBackend";
export { PhysicalIosCrashBackend } from "./PhysicalIosCrashBackend";

export interface SimulatorCrashCommandRunner {
  executeCommandArgs(args: string[], timeoutMs?: number, signal?: AbortSignal): Promise<ExecResult>;
}

export interface IosCrashCommandOptions {
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface IosCrashKillOptions extends IosCrashCommandOptions {
  serviceLabel: string;
  uid: number;
  /** Defaults to SIGABRT (crashApp); appLifecycle sends SIGKILL (#14098). */
  signalName?: "SIGABRT" | "SIGKILL";
}

export interface IosCrashBackend {
  readonly kind: "simulator" | "physical";
  listProcesses(options: IosCrashCommandOptions): Promise<ExecResult>;
  killProcess(options: IosCrashKillOptions): Promise<ExecResult>;
  readCrashLog(options: IosCrashCommandOptions): Promise<ExecResult>;
}

export interface IosCrashBackendDeps {
  simctl: SimulatorCrashCommandRunner;
}

export class SimulatorIosCrashBackend implements IosCrashBackend {
  readonly kind = "simulator";

  constructor(
    private readonly deviceId: string,
    private readonly simctl: SimulatorCrashCommandRunner,
  ) {}

  listProcesses(options: IosCrashCommandOptions): Promise<ExecResult> {
    return this.simctl.executeCommandArgs(
      ["spawn", this.deviceId, "launchctl", "list"],
      options.timeoutMs,
      options.signal,
    );
  }

  killProcess(options: IosCrashKillOptions): Promise<ExecResult> {
    return this.simctl.executeCommandArgs(
      [
        "spawn",
        this.deviceId,
        "launchctl",
        "kill",
        options.signalName ?? "SIGABRT",
        `user/${options.uid}/${options.serviceLabel}`,
      ],
      options.timeoutMs,
      options.signal,
    );
  }

  readCrashLog(options: IosCrashCommandOptions): Promise<ExecResult> {
    return this.simctl.executeCommandArgs(
      [
        "spawn",
        this.deviceId,
        "log",
        "show",
        "--last",
        "1m",
        "--style",
        "compact",
        "--timezone",
        "UTC",
        "--predicate",
        'eventMessage CONTAINS[c] "SIGABRT"',
      ],
      options.timeoutMs,
      options.signal,
    );
  }
}

export function resolveIosCrashBackend(
  deviceId: string,
  deps: IosCrashBackendDeps,
): IosCrashBackend {
  return resolveIosDeviceKind({ deviceId }) === "simulator"
    ? new SimulatorIosCrashBackend(deviceId, deps.simctl)
    : new PhysicalIosCrashBackend();
}
