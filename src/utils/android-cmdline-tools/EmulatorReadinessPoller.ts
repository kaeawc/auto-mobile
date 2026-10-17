import type { HostChildProcess as ChildProcess } from "../HostCommandExecutor";
import { StringDecoder } from "node:string_decoder";
import { logger } from "../logger";
import { ActionableError, type BootedDevice } from "../../models";
import type { Timer } from "../SystemTimer";
import { createGlobalPerformanceTracker } from "../PerformanceTracker";
import { DeviceLockStore } from "../../devices/DeviceLockStore";
import { AdbClient } from "./AdbClient";
import type { AdbClientFactory } from "./AdbClientFactory";
import { AndroidWakeAndUnlock } from "./AndroidWakeAndUnlock";
import {
  READINESS_NAME_TIMEOUT_MS,
  type AndroidDeviceInventoryScanner,
  type BootedDeviceScan,
  type BootedDeviceScanOptions,
  type ReadinessDiagnostic,
} from "./AndroidDeviceInventoryScanner";
import { EmulatorExitedDuringReadinessError } from "./EmulatorLauncher";
import type { AdbDeviceState } from "./interfaces/AdbExecutor";
import type { AndroidEmulatorReadinessOptions } from "./AndroidEmulatorClient";
import {
  matchesRequestedAvdOrUnknown,
  nextReadinessNameCandidates,
  readinessDiagnostic,
  readinessTarget,
  readinessTimeoutError,
  rejectedReadinessDiagnostic,
  relevantScanDiagnostic,
  retryUnresolvedReadinessNames,
  throwIfReadinessAborted,
  unmetReadinessPredicate,
  type TargetReadinessState,
} from "./emulatorReadinessEvaluation";

const DEFAULT_EMULATOR_POLLING_INTERVAL_MS = 500;
export const MIN_EMULATOR_POLLING_INTERVAL_MS = 100;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const MAX_POLLING_SLEEP_CHUNK_MS = 500;
const READINESS_PROBE_TIMEOUT_MS = 10_000;
const PRIMARY_USER_UNLOCK_WAIT_MS = 5_000;
const PRIMARY_USER_UNLOCK_POLL_INTERVAL_MS = 250;

export interface OfflineTracker {
  deviceId: string | null;
  since: number | null;
  state?: TargetReadinessState;
  /** A bounded `adb -s <serial> reconnect` recovery has been dispatched during this readiness invocation (monotonic once set). */
  recoveryAttempted?: boolean;
}

interface EmulatorReadinessState {
  processExitError: ActionableError | null;
  foundDeviceId: string | null;
  foundEmulatorName: string;
  foundDeviceModel?: string;
  resolvedTargetDeviceId?: string;
  correlationFailure?: string;
  lastDiagnostic?: ReadinessDiagnostic;
}

interface ReadinessPollingState {
  active: boolean;
  failure?: unknown;
}

interface EmulatorReadinessContext {
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

export function resolveEmulatorPollingInterval(value: string | undefined): number {
  const configuredInterval = Number(value);
  if (
    !Number.isFinite(configuredInterval) ||
    configuredInterval <= 0 ||
    configuredInterval > MAX_TIMER_DELAY_MS
  ) {
    return DEFAULT_EMULATOR_POLLING_INTERVAL_MS;
  }
  return Math.max(configuredInterval, MIN_EMULATOR_POLLING_INTERVAL_MS);
}

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
  clearOfflineTracker(tracker: OfflineTracker): void;
  detectOfflineFailure(
    deviceId: string | undefined,
    tracker: OfflineTracker,
    timeoutMs?: number,
    signal?: AbortSignal,
    observedStates?: AdbDeviceState[],
  ): Promise<ActionableError | null>;
  maybeRecoverFreshOffline(
    tracker: OfflineTracker,
    options: AndroidEmulatorReadinessOptions | undefined,
    deviceId: string | undefined,
    startTime: number,
    timeoutMs: number,
    context: { avdName: string; signal: AbortSignal | undefined },
  ): Promise<void>;
  nextPollingDelayMs(
    tracker: OfflineTracker,
    options: AndroidEmulatorReadinessOptions | undefined,
    deviceId: string | undefined,
    now: number,
    pollingIntervalMs: number,
    remainingPollingTimeMs: number,
  ): number;
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

export interface EmulatorReadinessPoller {
  waitForEmulatorReady(
    avdName: string,
    timeoutMs?: number,
    childProcess?: ChildProcess | null,
    targetDeviceId?: string,
    signal?: AbortSignal,
    options?: AndroidEmulatorReadinessOptions,
  ): Promise<BootedDevice>;
  wakeAndUnlock(device: BootedDevice, signal?: AbortSignal): Promise<void>;
}

export class DefaultEmulatorReadinessPoller implements EmulatorReadinessPoller {
  constructor(private readonly host: EmulatorReadinessHost) {}

  private get timer(): Timer {
    return this.host.timer();
  }

  private get adbFactory(): AdbClientFactory {
    return this.host.adbFactory();
  }

  private async settleReadinessExit(
    childProcess: ChildProcess | null | undefined,
    fallback: ActionableError,
    onFatal: (error: ActionableError) => Promise<never>,
  ): Promise<void> {
    const finalization = this.host.getLaunchErrorFinalization(childProcess);
    const finalizedError = finalization
      ? await finalization
      : (this.host.getLaunchError(childProcess) ?? fallback);
    if (finalizedError) {
      await onFatal(finalizedError);
    }
  }

  private recordLaunchError(
    childProcess: ChildProcess | null | undefined,
    onError: (error: ActionableError) => void,
  ): void {
    const error = this.host.getLaunchError(childProcess);
    if (error) {
      onError(error);
    }
  }

  private handleReadinessPollingError(
    error: unknown,
    signal: AbortSignal | undefined,
    polling: ReadinessPollingState,
    deadlineReached: boolean,
  ): ReadinessDiagnostic | undefined {
    if (signal?.aborted) {
      polling.active = false;
      if (!deadlineReached) {
        polling.failure = signal.reason;
      }
      return undefined;
    }
    return readinessDiagnostic("device-discovery", error);
  }

  private markTargetNotReady(tracker: OfflineTracker, targetDeviceId: string | undefined): void {
    if (targetDeviceId) {
      tracker.state = "not-ready";
    }
  }

  private readinessWaitActive(
    polling: ReadinessPollingState,
    startTime: number,
    timeoutMs: number,
  ): boolean {
    return polling.active && this.timer.now() - startTime < timeoutMs;
  }

  private readinessDeadlineReached(startTime: number, timeoutMs: number): boolean {
    return this.timer.now() - startTime >= timeoutMs;
  }

  private waitForReadinessDelay(
    delayMs: number,
    signal: AbortSignal | undefined,
    polling: ReadinessPollingState,
    startTime: number,
    timeoutMs: number,
  ): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false;
      const waitState: { timeoutHandle?: NodeJS.Timeout } = {};
      const settle = (aborted: boolean) => {
        if (settled) {
          return;
        }
        settled = true;
        if (aborted) {
          polling.active = false;
          if (!this.readinessDeadlineReached(startTime, timeoutMs)) {
            polling.failure = signal?.reason;
          }
        }
        if (waitState.timeoutHandle) {
          this.timer.clearTimeout(waitState.timeoutHandle);
        }
        signal?.removeEventListener("abort", abort);
        resolve();
      };
      const abort = () => settle(true);
      signal?.addEventListener("abort", abort, { once: true });
      waitState.timeoutHandle = this.timer.setTimeout(() => settle(false), delayMs);
      if (signal?.aborted) {
        abort();
      }
    });
  }

  private throwPollingFailure(polling: ReadinessPollingState): void {
    if (polling.failure !== undefined) {
      throw polling.failure;
    }
  }

  private readinessTargetDeviceId(
    targetDeviceId: string | undefined,
    childProcess: ChildProcess | null | undefined,
    resolvedTargetDeviceId?: string,
  ): string | undefined {
    return (
      targetDeviceId ?? this.host.getLaunchTargetDeviceId(childProcess) ?? resolvedTargetDeviceId
    );
  }

  /**
   * Wait for the emulator to be ready for use
   * @param avdName - The AVD name to wait for
   * @param timeoutMs - Maximum time to wait in milliseconds (default: 120000 = 2 minutes)
   * @returns Promise that resolves with device ID when emulator is ready
   */
  async waitForEmulatorReady(
    avdName: string,
    timeoutMs: number = 120000,
    childProcess?: ChildProcess | null,
    targetDeviceId?: string,
    signal?: AbortSignal,
    options?: AndroidEmulatorReadinessOptions,
  ): Promise<BootedDevice> {
    const startTime = this.timer.now();
    const perf = createGlobalPerformanceTracker();

    // Read polling interval from environment variable (default: 500ms, minimum: 100ms)
    const pollingIntervalMs = resolveEmulatorPollingInterval(
      process.env.EMULATOR_POLLING_INTERVAL_MS,
    );
    logger.info(
      `Waiting for emulator '${avdName}' to be ready... (polling interval: ${pollingIntervalMs}ms)`,
    );

    const launchErrorFinalization = this.host.getLaunchErrorFinalization(childProcess);
    const finalizedLaunchError = launchErrorFinalization
      ? await launchErrorFinalization
      : undefined;
    const recordedLaunchError = finalizedLaunchError ?? this.host.getLaunchError(childProcess);
    this.host.throwLaunchError(recordedLaunchError);

    // Monitor child process for early exit if provided
    const polling: ReadinessPollingState = { active: true };
    const state: EmulatorReadinessState = {
      processExitError: null,
      foundDeviceId: null,
      foundEmulatorName: avdName,
    };
    const cleanupProcessListeners = this.monitorReadinessProcess(avdName, childProcess, state);

    // Start background polling immediately with configurable intervals
    const probedNameSerials = new Set<string>();
    const unresolvedNameSerials = new Set<string>();
    const offlineTracker: OfflineTracker = { deviceId: null, since: null };

    perf.startOperation("devicePolling");
    const context: EmulatorReadinessContext = {
      avdName,
      timeoutMs,
      childProcess,
      targetDeviceId,
      signal,
      options,
      startTime,
      perf,
      polling,
      state,
      pollingIntervalMs,
      probedNameSerials,
      unresolvedNameSerials,
      offlineTracker,
    };
    // Start background polling immediately
    const pollingPromise = this.pollEmulatorReadiness(context);

    // Main timeout loop
    while (this.readinessWaitActive(polling, startTime, timeoutMs)) {
      const readinessFailure = state.processExitError;
      if (readinessFailure) {
        await this.settleReadinessExit(
          childProcess,
          readinessFailure,
          async (finalizedReadinessFailure) => {
            polling.active = false;
            await pollingPromise;
            perf.endOperation("devicePolling");
            cleanupProcessListeners();
            throw finalizedReadinessFailure;
          },
        );
        state.processExitError = null;
        continue;
      }

      if (state.foundDeviceId) {
        polling.active = false;
        perf.endOperation("devicePolling");
        cleanupProcessListeners();
        const resolvedName = await this.host.resolvedReadyAvdName(
          avdName,
          state.foundDeviceId,
          state.foundEmulatorName,
          Math.max(
            0,
            Math.min(READINESS_NAME_TIMEOUT_MS, timeoutMs - (this.timer.now() - startTime)),
          ),
          signal,
        );
        logger.info(`Emulator '${resolvedName}' is ready! Device ID: ${state.foundDeviceId}`);
        const model = await this.host.resolveFoundDeviceModel(
          state.foundDeviceModel,
          state.foundDeviceId,
          resolvedName,
          Math.max(
            0,
            Math.min(READINESS_NAME_TIMEOUT_MS, timeoutMs - (this.timer.now() - startTime)),
          ),
          signal,
        );
        const bootedDevice = this.host.foundBootedDevice(resolvedName, state.foundDeviceId, model);
        await this.wakeAndUnlockAfterReadiness(bootedDevice, signal, options, perf);
        return bootedDevice;
      }

      // Check less frequently in main loop since background polling is doing the work
      await this.waitForReadinessDelay(500, signal, polling, startTime, timeoutMs);
    }

    // Stop background polling
    polling.active = false;
    await pollingPromise;
    perf.endOperation("devicePolling");
    cleanupProcessListeners();

    this.throwPollingFailure(polling);

    if (state.foundDeviceId) {
      const resolvedName = await this.host.resolvedReadyAvdName(
        avdName,
        state.foundDeviceId,
        state.foundEmulatorName,
        Math.max(
          0,
          Math.min(READINESS_NAME_TIMEOUT_MS, timeoutMs - (this.timer.now() - startTime)),
        ),
        signal,
      );
      logger.info(`Emulator '${resolvedName}' is ready! Device ID: ${state.foundDeviceId}`);
      const model = await this.host.resolveFoundDeviceModel(
        state.foundDeviceModel,
        state.foundDeviceId,
        resolvedName,
        Math.max(
          0,
          Math.min(READINESS_NAME_TIMEOUT_MS, timeoutMs - (this.timer.now() - startTime)),
        ),
        signal,
      );
      const bootedDevice = this.host.foundBootedDevice(resolvedName, state.foundDeviceId, model);
      await this.wakeAndUnlockAfterReadiness(bootedDevice, signal, options, perf);
      return bootedDevice;
    }

    const correlatedTargetDeviceId = this.readinessTargetDeviceId(
      targetDeviceId,
      childProcess,
      state.resolvedTargetDeviceId,
    );
    const target = readinessTarget(correlatedTargetDeviceId, offlineTracker);
    throw readinessTimeoutError(
      avdName,
      timeoutMs,
      state.processExitError,
      state.correlationFailure,
      state.lastDiagnostic,
      target,
    );
  }

  private validateReadinessCandidate(
    context: EmulatorReadinessContext,
    emulator: BootedDevice | undefined,
    correlatedTargetDeviceId: string | undefined,
  ): BootedDevice | undefined {
    const { avdName, timeoutMs, state } = context;
    if (correlatedTargetDeviceId) {
      logger.debug(
        `Exact deviceId match for '${correlatedTargetDeviceId}': ${emulator ? `Found ${emulator.deviceId}` : "Not found"}`,
      );
      if (emulator && !matchesRequestedAvdOrUnknown(emulator, avdName, correlatedTargetDeviceId)) {
        state.correlationFailure =
          `Emulator '${avdName}' failed to become ready within ${timeoutMs}ms: ` +
          `requested AVD '${avdName}' but ${emulator.deviceId} reports '${emulator.name}'. ` +
          "Select the correct AVD or serial and retry.";
        logger.warn(state.correlationFailure);
        emulator = undefined;
      }
    }

    return emulator;
  }

  private selectReadinessEmulator(
    context: EmulatorReadinessContext,
    runningEmulators: BootedDevice[],
    correlatedTargetDeviceId: string | undefined,
  ): BootedDevice | undefined {
    const { avdName, childProcess, state } = context;
    state.correlationFailure = undefined;
    if (runningEmulators.length > 0) {
      logger.debug(
        `Found ${runningEmulators.length} running emulators: ${runningEmulators.map((e) => `${e.name}(${e.deviceId})`).join(", ")}`,
      );

      // Prefer an exact deviceId when startDevice already selected or correlated a device.
      let emulator = correlatedTargetDeviceId
        ? runningEmulators.find((emu) => emu.deviceId === correlatedTargetDeviceId)
        : undefined;
      emulator = this.validateReadinessCandidate(context, emulator, correlatedTargetDeviceId);

      // Look for emulator by name next.
      if (!emulator && !correlatedTargetDeviceId) {
        const correlation = this.host.findNamedEmulator(avdName, childProcess, runningEmulators);
        emulator = correlation.emulator;
        state.correlationFailure = correlation.failure;
        state.resolvedTargetDeviceId = emulator?.deviceId;
      }

      return emulator;
    }
    logger.debug(`No running emulators detected - will continue polling`);
    return undefined;
  }

  private applyReadinessProbeResults(
    context: EmulatorReadinessContext,
    emulator: BootedDevice,
    scanDiagnostic: ReadinessDiagnostic | undefined,
    results: [
      PromiseSettledResult<Awaited<ReturnType<AdbClient["executeCommand"]>>>,
      PromiseSettledResult<Awaited<ReturnType<AdbClient["executeCommand"]>>>,
      PromiseSettledResult<Awaited<ReturnType<AdbClient["executeCommand"]>>>,
      PromiseSettledResult<Awaited<ReturnType<AdbClient["executeCommand"]>>>,
    ],
  ): boolean {
    const { state, signal } = context;
    const [deviceStateResult, packageManagerResult, sysBootCompletedResult, bootAnimationResult] =
      results;
    throwIfReadinessAborted(signal);

    // Check device state result
    if (
      deviceStateResult.status !== "fulfilled" ||
      packageManagerResult.status !== "fulfilled" ||
      sysBootCompletedResult.status !== "fulfilled" ||
      bootAnimationResult.status !== "fulfilled"
    ) {
      logger.debug(
        `[PARALLEL] Checks not yet complete: deviceStatus: ${deviceStateResult.status}, ` +
          `packageManager: ${packageManagerResult.status}, ` +
          `sysBootCompleted: ${sysBootCompletedResult.status}, bootAnimation: ${bootAnimationResult.status}`,
      );
      state.lastDiagnostic =
        rejectedReadinessDiagnostic([
          ["device-state", deviceStateResult],
          ["package-manager", packageManagerResult],
          ["system-boot-complete", sysBootCompletedResult],
          ["boot-animation", bootAnimationResult],
        ]) ?? state.lastDiagnostic;
    } else {
      const stateOutput = deviceStateResult.value.stdout.trim();
      const sysBootCompleted = sysBootCompletedResult.value.stdout.trim();
      const bootAnimationState = bootAnimationResult.value.stdout.trim();
      logger.debug(
        `[PARALLEL] Package manager command completed for ${emulator.deviceId} - output: ${packageManagerResult.value.stdout.length} bytes`,
      );
      const unmetPredicate = unmetReadinessPredicate(
        emulator.deviceId,
        stateOutput,
        packageManagerResult.value,
        sysBootCompleted,
        bootAnimationState,
      );
      if (unmetPredicate) {
        // An upstream scan failure (discovery, AVD-name resolution) is the
        // root cause when it is present, so it outranks the probe verdict.
        state.lastDiagnostic = scanDiagnostic ?? unmetPredicate;
      } else {
        logger.debug(`[PARALLEL] ✅ Device state check passed for ${emulator.deviceId}`);
        logger.debug(
          `[PARALLEL] ✅ Package manager is responsive for ${emulator.deviceId} - emulator is ready!`,
        );
        logger.debug(
          `[PARALLEL] ✅ Android boot-complete signals are ready for ${emulator.deviceId}`,
        );
        logger.debug(
          `[PARALLEL] ✅ No package manager errors detected - marking emulator as ready`,
        );
        state.foundDeviceId = emulator.deviceId;
        state.foundEmulatorName = emulator.name;
        state.foundDeviceModel = emulator.model;
        return true;
      }
    }

    return false;
  }

  private scanReadinessDevices(
    context: EmulatorReadinessContext,
    snapshot:
      | Awaited<
          ReturnType<
            NonNullable<ReturnType<AdbClientFactory["create"]>["getReadinessDeviceSnapshot"]>
          >
        >
      | undefined,
    correlatedTargetDeviceId: string | undefined,
  ) {
    const { signal, timeoutMs, startTime, probedNameSerials, unresolvedNameSerials } = context;
    const candidateDevices =
      snapshot?.devices && !correlatedTargetDeviceId
        ? nextReadinessNameCandidates(snapshot.devices, probedNameSerials, unresolvedNameSerials)
        : snapshot?.devices;
    return this.host.getBootedDevicesWithDiagnostics(
      false,
      {
        bypassDeviceListCache: true,
        devices: candidateDevices,
        timeoutMs: Math.min(READINESS_NAME_TIMEOUT_MS, timeoutMs - (this.timer.now() - startTime)),
        deviceListTimeoutMs: Math.min(
          AdbClient.DEVICE_LIST_TIMEOUT_MS,
          timeoutMs - (this.timer.now() - startTime),
        ),
        deadlineMs: startTime + timeoutMs,
        targetDeviceId: correlatedTargetDeviceId,
        readinessOnly: true,
      },
      signal,
    );
  }

  private dispatchReadinessProbes(
    adb: ReturnType<AdbClientFactory["create"]>,
    readinessTimeoutMs: number,
    signal: AbortSignal | undefined,
  ) {
    return Promise.allSettled([
      adb.executeCommand("get-state", { timeoutMs: readinessTimeoutMs, signal }),
      adb.executeCommand("shell pm list packages", { timeoutMs: readinessTimeoutMs, signal }),
      adb.executeCommand("shell getprop sys.boot_completed", {
        timeoutMs: readinessTimeoutMs,
        signal,
      }),
      adb.executeCommand("shell getprop init.svc.bootanim", {
        timeoutMs: readinessTimeoutMs,
        signal,
      }),
    ]);
  }

  private async pollEmulatorReadiness(context: EmulatorReadinessContext): Promise<void> {
    const {
      avdName,
      timeoutMs,
      childProcess,
      targetDeviceId,
      signal,
      options,
      startTime,
      perf,
      polling,
      state,
      pollingIntervalMs,
      unresolvedNameSerials,
      offlineTracker,
    } = context;

    // Let the main loop register its wake-up first. When both sleeps share a
    // deadline, this lets a process-exit failure stop the poller before it
    // schedules another cycle.
    await Promise.resolve();
    while (polling.active && !state.foundDeviceId) {
      let correlatedTargetDeviceId: string | undefined;
      try {
        this.recordLaunchError(childProcess, (error) => {
          state.processExitError = error;
        });
        logger.debug(`Background polling iteration - checking for emulator '${avdName}'...`);

        correlatedTargetDeviceId = this.readinessTargetDeviceId(
          targetDeviceId,
          childProcess,
          state.resolvedTargetDeviceId,
        );
        const remainingTimeoutMs = timeoutMs - (this.timer.now() - startTime);
        if (remainingTimeoutMs <= 0) {
          polling.active = false;
          break;
        }
        const discoveryAdb = this.adbFactory.create(null);
        let snapshot:
          | Awaited<ReturnType<NonNullable<typeof discoveryAdb.getReadinessDeviceSnapshot>>>
          | undefined;
        try {
          snapshot = discoveryAdb.getReadinessDeviceSnapshot
            ? await discoveryAdb.getReadinessDeviceSnapshot({
                timeoutMs: Math.min(AdbClient.DEVICE_LIST_TIMEOUT_MS, remainingTimeoutMs),
                signal,
              })
            : undefined;
        } catch (error) {
          // A failed snapshot is a gap in offline observations, not continued offline time.
          this.host.clearOfflineTracker(offlineTracker);
          throw error;
        }
        await this.host.detectOfflineFailure(
          correlatedTargetDeviceId,
          offlineTracker,
          Math.min(AdbClient.DEVICE_LIST_TIMEOUT_MS, remainingTimeoutMs),
          signal,
          snapshot?.states,
        );
        await this.host.maybeRecoverFreshOffline(
          offlineTracker,
          options,
          correlatedTargetDeviceId,
          startTime,
          timeoutMs,
          { avdName, signal },
        );
        if (!polling.active || this.timer.now() - startTime >= timeoutMs) {
          break;
        }

        // For local emulators, check for running devices
        logger.debug(`Checking for running local emulators...`);
        const scan = await this.scanReadinessDevices(context, snapshot, correlatedTargetDeviceId);
        const scanDiagnostic = relevantScanDiagnostic(scan, correlatedTargetDeviceId);
        retryUnresolvedReadinessNames(scan.devices, unresolvedNameSerials);
        state.lastDiagnostic = scanDiagnostic;
        const runningEmulators = scan.devices;
        logger.debug(`Device scan complete - found ${runningEmulators.length} running emulators`);
        const readinessTimeoutMs = Math.max(
          0,
          Math.min(READINESS_PROBE_TIMEOUT_MS, timeoutMs - (this.timer.now() - startTime)),
        );
        if (readinessTimeoutMs <= 0) {
          break;
        }

        const emulator = this.selectReadinessEmulator(
          context,
          runningEmulators,
          correlatedTargetDeviceId,
        );
        if (emulator && emulator.deviceId) {
          this.markTargetNotReady(offlineTracker, correlatedTargetDeviceId);
          state.correlationFailure = undefined;
          logger.debug(
            `Target emulator found: ${emulator.name} (${emulator.deviceId}) - starting readiness checks`,
          );
          // Check if the device is online and ready.
          // Run ADB state, package manager, and boot-complete checks in parallel for faster detection.
          logger.debug(
            `[PARALLEL] Running device state, package manager, and boot-complete checks for ${emulator.deviceId}...`,
          );
          const adb = this.adbFactory.create(emulator);
          try {
            perf.startOperation("adbParallelChecks");
            const results = await this.dispatchReadinessProbes(adb, readinessTimeoutMs, signal);
            perf.endOperation("adbParallelChecks");

            if (this.applyReadinessProbeResults(context, emulator, scanDiagnostic, results)) {
              return;
            }
          } catch (parallelError) {
            // Transient readiness probe failures are retried until the deadline.
            throwIfReadinessAborted(signal);
            logger.debug(
              `[PARALLEL] ❌ Parallel checks failed for ${emulator.deviceId}: ${parallelError}`,
            );
          }
        } else if (runningEmulators.length > 0) {
          logger.debug(`No suitable emulator found for '${avdName}' - will continue polling`);
        }
      } catch (error) {
        // Transient discovery failures remain diagnostic evidence while polling continues.
        state.lastDiagnostic =
          this.handleReadinessPollingError(
            error,
            signal,
            polling,
            this.readinessDeadlineReached(startTime, timeoutMs),
          ) ?? state.lastDiagnostic;
        logger.debug(`Background polling error (will continue): ${error}`);
      }

      const now = this.timer.now();
      const remainingPollingTimeMs = timeoutMs - (now - startTime);
      if (remainingPollingTimeMs <= 0) {
        polling.active = false;
        break;
      }
      let remainingPollingDelayMs = this.host.nextPollingDelayMs(
        offlineTracker,
        options,
        correlatedTargetDeviceId,
        now,
        pollingIntervalMs,
        remainingPollingTimeMs,
      );

      // Never let the background poller sleep past the readiness deadline.
      logger.debug(
        `Background polling cycle complete - sleeping ${remainingPollingDelayMs}ms before next check`,
      );
      while (polling.active && !state.foundDeviceId && remainingPollingDelayMs > 0) {
        const sleepChunkMs = Math.min(remainingPollingDelayMs, MAX_POLLING_SLEEP_CHUNK_MS);
        await this.waitForReadinessDelay(sleepChunkMs, signal, polling, startTime, timeoutMs);
        remainingPollingDelayMs -= sleepChunkMs;
      }
    }
    logger.debug(
      `Background polling stopped - pollingActive: ${polling.active}, foundDeviceId: ${state.foundDeviceId}`,
    );
  }

  private monitorReadinessProcess(
    avdName: string,
    childProcess: ChildProcess | null | undefined,
    state: EmulatorReadinessState,
  ): () => void {
    if (childProcess && childProcess.pid) {
      const processOutput: string[] = [];
      const stdoutDecoder = new StringDecoder("utf8");
      const stderrDecoder = new StringDecoder("utf8");
      const captureOutput = (decoder: StringDecoder, data: Buffer | string) => {
        const output = typeof data === "string" ? data : decoder.write(data);
        processOutput.push(output);
        this.host.captureLaunchTargetDeviceId(childProcess, output);
        // Keep buffer bounded
        if (processOutput.length > 50) {
          processOutput.splice(0, processOutput.length - 50);
        }
      };
      const handleProcessExit = (code: number | null) => {
        const stdoutTail = stdoutDecoder.end();
        const stderrTail = stderrDecoder.end();
        if (stdoutTail) {
          captureOutput(stdoutDecoder, stdoutTail);
        }
        if (stderrTail) {
          captureOutput(stderrDecoder, stderrTail);
        }
        // Any exit before readiness is fatal unless another process owns the AVD.
        const combinedOutput = processOutput.join("");
        if (combinedOutput.includes("Running multiple emulators with the same AVD")) {
          logger.warn(
            `AVD '${avdName}' is owned by another emulator process; continuing readiness polling`,
          );
          return;
        }

        state.processExitError =
          this.host.classifyEmulatorExitOutput(combinedOutput) ??
          new EmulatorExitedDuringReadinessError(code);
        logger.error(
          `Emulator process exited during readiness wait: ${state.processExitError.message}`,
        );
      };
      const stdoutCapture = (data: Buffer | string) => captureOutput(stdoutDecoder, data);
      const stderrCapture = (data: Buffer | string) => captureOutput(stderrDecoder, data);
      childProcess.stdout?.on("data", stdoutCapture);
      childProcess.stderr?.on("data", stderrCapture);
      childProcess.on("exit", handleProcessExit);
      return () => {
        childProcess.stdout?.off("data", stdoutCapture);
        childProcess.stderr?.off("data", stderrCapture);
        childProcess.off("exit", handleProcessExit);
      };
    }

    return () => {};
  }

  private async wakeAndUnlockAfterReadiness(
    device: BootedDevice,
    signal: AbortSignal | undefined,
    options: AndroidEmulatorReadinessOptions | undefined,
    perf: ReturnType<typeof createGlobalPerformanceTracker>,
  ): Promise<void> {
    if (options?.skipWakeAndUnlock) {
      return;
    }
    perf.startOperation("wakeAndUnlock");
    await this.wakeAndUnlock(device, signal);
    perf.endOperation("wakeAndUnlock");
  }

  /**
   * Wake up the emulator and dismiss the lock screen after boot.
   * This ensures the device is immediately usable for automation.
   *
   * Delegates to the shared {@link AndroidWakeAndUnlock} implementation so boot uses the same
   * path as the `wakeAndUnlock` tool: a swipe lock is dismissed, and a secure
   * lock is unlocked with the PIN remembered for the device this session (if
   * any). A secure device with no remembered PIN is left locked — non-fatal, the
   * device is still ready and the user can unlock it with the tool (#4360).
   * @param device - The booted device to wake and unlock
   */
  async wakeAndUnlock(device: BootedDevice, signal?: AbortSignal): Promise<void> {
    try {
      const wakeAndUnlock = new AndroidWakeAndUnlock(device, this.adbFactory, {
        timer: this.timer,
        credentialStore: new DeviceLockStore(),
      });
      const result = await wakeAndUnlock.execute(undefined, signal);
      await this.waitForPrimaryUserUnlock(device, signal);
      if (!result.unlocked && result.secure) {
        logger.info(
          `[WakeAndUnlock] Device ${device.deviceId} is secure-locked and no PIN is remembered; ` +
            "leaving it locked. Unlock it once with the wakeAndUnlock tool (passing a pin) to remember it.",
        );
      } else {
        logger.info(
          `[WakeAndUnlock] Device ${device.deviceId} wake/unlock: ${JSON.stringify(result)}`,
        );
      }
    } catch (error) {
      throwIfReadinessAborted(signal);
      // Log but don't fail - the device is still ready, just might need manual interaction.
      // A secure lock with no remembered PIN throws ActionableError here; that is expected.
      logger.warn(`[WakeAndUnlock] Failed to wake/unlock device ${device.deviceId}: ${error}`);
    }
  }

  private async waitForPrimaryUserUnlock(
    device: BootedDevice,
    signal?: AbortSignal,
  ): Promise<void> {
    const adb = this.adbFactory.create(device);
    let elapsedMs = 0;
    try {
      while (elapsedMs < PRIMARY_USER_UNLOCK_WAIT_MS) {
        throwIfReadinessAborted(signal);
        const users = await adb.listUsers(signal);
        const primaryUser = users.find(
          (user) => user.profileType === "primary" || user.userId === 0,
        );
        if (primaryUser?.startState !== "RUNNING_LOCKED") {
          return;
        }
        await this.timer.sleep(PRIMARY_USER_UNLOCK_POLL_INTERVAL_MS);
        elapsedMs += PRIMARY_USER_UNLOCK_POLL_INTERVAL_MS;
      }
      logger.warn(
        `[WakeAndUnlock] Primary user on ${device.deviceId} is still RUNNING_LOCKED after ` +
          `${PRIMARY_USER_UNLOCK_WAIT_MS}ms; CtrlProxy cannot bind until the device unlocks.`,
      );
    } catch (error) {
      // User-state inspection is supplementary; preserve the completed unlock result if unavailable.
      throwIfReadinessAborted(signal);
      logger.debug(
        `[WakeAndUnlock] Could not confirm primary-user unlock state for ${device.deviceId}: ${error}`,
      );
    }
  }
}
