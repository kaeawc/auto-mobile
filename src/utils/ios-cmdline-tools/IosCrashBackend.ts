import type { ExecResult } from "../../models";
import { ActionableError } from "../../models/ActionableError";
import { resolveIosDeviceKind } from "./IosDeviceKind";

export const PHYSICAL_IOS_CRASH_UNSUPPORTED_MESSAGE =
  "crashApp is not supported on physical iOS devices; " +
  "AutoMobile will not fall back to normal termination";

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
        "SIGABRT",
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

export class PhysicalIosCrashBackend implements IosCrashBackend {
  readonly kind = "physical";

  listProcesses(_options: IosCrashCommandOptions): Promise<ExecResult> {
    return Promise.reject(new ActionableError(PHYSICAL_IOS_CRASH_UNSUPPORTED_MESSAGE));
  }

  killProcess(_options: IosCrashKillOptions): Promise<ExecResult> {
    return Promise.reject(new ActionableError(PHYSICAL_IOS_CRASH_UNSUPPORTED_MESSAGE));
  }

  readCrashLog(_options: IosCrashCommandOptions): Promise<ExecResult> {
    return Promise.reject(new ActionableError(PHYSICAL_IOS_CRASH_UNSUPPORTED_MESSAGE));
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
