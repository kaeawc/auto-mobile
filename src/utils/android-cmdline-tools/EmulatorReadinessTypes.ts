import type { HostChildProcess as ChildProcess } from "../HostCommandExecutor";
import { ActionableError, type BootedDevice } from "../../models";
import type { Timer } from "../SystemTimer";
import type { createGlobalPerformanceTracker } from "../PerformanceTracker";
import type { AdbClientFactory } from "./AdbClientFactory";
import type {
  AndroidDeviceInventoryScanner,
  BootedDeviceScan,
  BootedDeviceScanOptions,
  ReadinessDiagnostic,
} from "./AndroidDeviceInventoryScanner";
import type { AndroidEmulatorReadinessOptions } from "./AndroidEmulatorClient";
import type { AdbDeviceState } from "./interfaces/AdbExecutor";
import type { EmulatorOfflineRecovery } from "./EmulatorOfflineRecovery";
import type { TargetReadinessState } from "./emulatorReadinessEvaluation";

export interface OfflineTracker {
  deviceId: string | null;
  since: number | null;
  state?: TargetReadinessState;
  /** A bounded `adb -s <serial> reconnect` recovery has been dispatched during this readiness invocation (monotonic once set). */
  recoveryAttempted?: boolean;
}

export interface EmulatorReadinessState {
  processExitError: ActionableError | null;
  foundDeviceId: string | null;
  foundEmulatorName: string;
  foundDeviceModel?: string;
  resolvedTargetDeviceId?: string;
  correlationFailure?: string;
  lastDiagnostic?: ReadinessDiagnostic;
}

export interface ReadinessPollingState {
  active: boolean;
  failure?: { reason: unknown };
  wakeWaiters: Set<() => void>;
}

export interface EmulatorReadinessContext {
  avdName: string;
  timeoutMs: number;
  childProcess?: ChildProcess | null;
  targetDeviceId?: string;
  signal?: AbortSignal;
  options?: AndroidEmulatorReadinessOptions;
  startTime: number;
  perf: ReturnType<typeof createGlobalPerformanceTracker>;
  polling: ReadinessPollingState;
  state: EmulatorReadinessState;
  pollingIntervalMs: number;
  probedNameSerials: Set<string>;
  unresolvedNameSerials: Set<string>;
  offlineTracker: OfflineTracker;
}

/** One poll pass's correlation, kept so the inter-poll sleep can see it even after a failed pass. */
export interface ReadinessPollCycle {
  correlatedTargetDeviceId: string | undefined;
}

export type ReadinessPollOutcome = "ready" | "stop" | "continue";

/**
 * Client-owned behaviour the poller needs. Every member resolves through the client at call
 * time, so patched client methods and reassigned fields still take effect.
 */
export interface EmulatorReadinessHost {
  timer(): Timer;
  adbFactory(): AdbClientFactory;
  getLaunchError(childProcess?: ChildProcess | null): ActionableError | undefined;
  getLaunchErrorFinalization(
    childProcess?: ChildProcess | null,
  ): Promise<ActionableError | undefined> | undefined;
  throwLaunchError(error?: ActionableError): void;
  getLaunchTargetDeviceId(childProcess?: ChildProcess | null): string | undefined;
  captureLaunchTargetDeviceId(childProcess: ChildProcess, output: string): void;
  maybeRecoverFreshOffline(
    ...args: Parameters<EmulatorOfflineRecovery["maybeRecoverFreshOffline"]>
  ): Promise<void>;
  nextPollingDelayMs(...args: Parameters<EmulatorOfflineRecovery["nextPollingDelayMs"]>): number;
  getBootedDevicesWithDiagnostics(
    onlyEmulators?: boolean,
    options?: BootedDeviceScanOptions,
    signal?: AbortSignal,
  ): Promise<BootedDeviceScan>;
  findNamedEmulator(
    avdName: string,
    childProcess: ChildProcess | null | undefined,
    runningEmulators: BootedDevice[],
  ): { emulator?: BootedDevice; failure?: string };
  resolvedReadyAvdName(
    ...args: Parameters<AndroidDeviceInventoryScanner["resolvedReadyAvdName"]>
  ): Promise<string>;
  resolveFoundDeviceModel(
    ...args: Parameters<AndroidDeviceInventoryScanner["resolveFoundDeviceModel"]>
  ): Promise<string | undefined>;
  foundBootedDevice(
    ...args: Parameters<AndroidDeviceInventoryScanner["foundBootedDevice"]>
  ): BootedDevice;
  /** Maps captured emulator output to a known fatal startup failure, or null when none matches. */
  classifyEmulatorExitOutput(output: string): ActionableError | null;
}

/** Cancellation and post-readiness behaviour for one readiness wait. */
export interface EmulatorReadyWait {
  signal?: AbortSignal;
  options?: AndroidEmulatorReadinessOptions;
}

export interface EmulatorReadinessPoller {
  waitForEmulatorReady(
    avdName: string,
    timeoutMs?: number,
    childProcess?: ChildProcess | null,
    targetDeviceId?: string,
    wait?: EmulatorReadyWait,
  ): Promise<BootedDevice>;
  wakeAndUnlock(device: BootedDevice, signal?: AbortSignal): Promise<void>;
  detectOfflineFailure(
    deviceId: string | undefined,
    tracker: OfflineTracker,
    timeoutMs?: number,
    signal?: AbortSignal,
    observedStates?: AdbDeviceState[],
  ): Promise<ActionableError | null>;
}
