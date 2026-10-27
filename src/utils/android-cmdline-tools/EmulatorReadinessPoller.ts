import type { HostChildProcess as ChildProcess } from "../HostCommandExecutor";
import { StringDecoder } from "node:string_decoder";
import { logger } from "../logger";
import { errorMessage } from "../describeUnknownError";
import { ActionableError, type BootedDevice } from "../../models";
import type { Timer } from "../SystemTimer";
import { createGlobalPerformanceTracker } from "../PerformanceTracker";
import { AdbClient } from "./AdbClient";
import type { AdbClientFactory } from "./AdbClientFactory";
import { DefaultEmulatorBootUnlock, type EmulatorBootUnlock } from "./EmulatorBootUnlock";
import {
  READINESS_NAME_TIMEOUT_MS,
  type ReadinessDiagnostic,
} from "./AndroidDeviceInventoryScanner";
import { EmulatorExitedDuringReadinessError } from "./EmulatorLauncher";
import type { AdbDeviceState, AdbExecutor } from "./interfaces/AdbExecutor";
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
import type {
  EmulatorReadinessContext,
  EmulatorReadinessHost,
  EmulatorReadinessPoller,
  EmulatorReadinessState,
  OfflineTracker,
  ReadinessPollCycle,
  ReadinessPollOutcome,
  ReadinessPollingState,
} from "./EmulatorReadinessTypes";
import { AMBIENT_ENV, readEnvRaw } from "../../config/env";

const DEFAULT_EMULATOR_POLLING_INTERVAL_MS = 500;
export const MIN_EMULATOR_POLLING_INTERVAL_MS = 100;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const MAX_POLLING_SLEEP_CHUNK_MS = 500;
const READINESS_PROBE_TIMEOUT_MS = 10_000;

export type {
  EmulatorReadinessHost,
  EmulatorReadinessPoller,
  OfflineTracker,
} from "./EmulatorReadinessTypes";

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

export class DefaultEmulatorReadinessPoller implements EmulatorReadinessPoller {
  private readonly bootUnlock: EmulatorBootUnlock;

  constructor(
    private readonly host: EmulatorReadinessHost,
    bootUnlock?: EmulatorBootUnlock,
  ) {
    this.bootUnlock =
      bootUnlock ??
      new DefaultEmulatorBootUnlock({
        timer: () => this.host.timer(),
        adbFactory: () => this.host.adbFactory(),
      });
  }

  private get timer(): Timer {
    return this.host.timer();
  }

  private get adbFactory(): AdbClientFactory {
    return this.host.adbFactory();
  }

  /**
   * Clear only the CURRENT OBSERVATION on the offline tracker (device serial,
   * offline-since, and last observed state). Used when there is no target serial
   * and when a device-state probe rejects/omits the target, so a stale offline
   * reading cannot drive recovery off out-of-date data (#7054).
   *
   * `recoveryAttempted` is deliberately NOT reset: it is MONOTONIC for the
   * lifetime of a single `waitForEmulatorReady` invocation. A probe gap after
   * the one-shot `adb -s <serial> reconnect` has been dispatched must not wipe that
   * history, or a later re-confirmed offline would issue a SECOND reconnect.
   */
  private clearOfflineTracker(tracker: OfflineTracker): void {
    tracker.deviceId = null;
    tracker.since = null;
    tracker.state = undefined;
  }

  async detectOfflineFailure(
    deviceId: string | undefined,
    tracker: OfflineTracker,
    timeoutMs?: number,
    signal?: AbortSignal,
    observedStates?: AdbDeviceState[],
  ): Promise<ActionableError | null> {
    let states: AdbDeviceState[];
    try {
      states =
        observedStates ??
        (await this.adbFactory.create(null).getDeviceStates?.({ timeoutMs, signal })) ??
        [];
    } catch (error) {
      throwIfReadinessAborted(signal);
      // Auxiliary diagnostic probe; a failure here must not block readiness polling.
      logger.debug(
        `Offline-state probe unavailable during emulator readiness: ${errorMessage(error)}`,
      );
      // A rejected probe is NOT a current offline observation. Clear the tracker
      // so both the reconnect dispatch and the fail-fast wait for a fresh,
      // successful observation that still shows offline; a run of failed probes
      // must not by itself satisfy the offline-failure threshold (#7054).
      this.clearOfflineTracker(tracker);
      return null;
    }
    if (!deviceId) {
      this.clearOfflineTracker(tracker);
      return null;
    }
    const targetState = states.find((state: AdbDeviceState) => state.deviceId === deviceId);
    tracker.state = this.targetReadinessState(targetState);
    if (targetState?.state !== "offline") {
      tracker.deviceId = null;
      tracker.since = null;
      return null;
    }
    if (tracker.deviceId !== targetState.deviceId) {
      // Refresh the current observation for a (re-)observed offline serial.
      // Recovery history stays monotonic for the invocation, so a re-confirmed
      // offline after the one-shot reconnect keeps advancing toward the
      // fail-fast instead of resurrecting a second reconnect (#7054).
      tracker.deviceId = targetState.deviceId;
      tracker.since = this.timer.now();
    }
    // An offline ADB state is transient during normal emulator startup. Keep
    // tracking it for diagnostics, but wait for the caller's readiness deadline
    // unless the emulator process provides definitive failure evidence.
    return null;
  }

  private targetReadinessState(targetState: AdbDeviceState | undefined): TargetReadinessState {
    if (targetState?.state === "offline") {
      return "offline";
    }
    return targetState === undefined ? "absent" : "not-ready";
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
        polling.failure = { reason: signal.reason };
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

  private wakeReadinessWaiters(polling: ReadinessPollingState): void {
    for (const wake of polling.wakeWaiters) {
      wake();
    }
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
            polling.failure = { reason: signal?.reason };
          }
        }
        if (waitState.timeoutHandle) {
          this.timer.clearTimeout(waitState.timeoutHandle);
        }
        signal?.removeEventListener("abort", abort);
        polling.wakeWaiters.delete(wake);
        resolve();
      };
      const abort = () => settle(true);
      const wake = () => settle(false);
      polling.wakeWaiters.add(wake);
      signal?.addEventListener("abort", abort, { once: true });
      waitState.timeoutHandle = this.timer.setTimeout(() => settle(false), delayMs);
      if (signal?.aborted) {
        abort();
      }
    });
  }

  private throwPollingFailure(polling: ReadinessPollingState): void {
    if (polling.failure !== undefined) {
      throw polling.failure.reason;
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
      readEnvRaw(AMBIENT_ENV.EMULATOR_POLLING_INTERVAL_MS),
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
    const polling: ReadinessPollingState = { active: true, wakeWaiters: new Set() };
    const state: EmulatorReadinessState = {
      processExitError: null,
      foundDeviceId: null,
      foundEmulatorName: avdName,
    };

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
    const cleanupProcessListeners = this.monitorReadinessProcess(context);
    // Start background polling immediately
    const pollingPromise = this.startReadinessPolling(context);

    // Main timeout loop
    while (this.readinessWaitActive(polling, startTime, timeoutMs)) {
      const readinessFailure = state.processExitError;
      if (readinessFailure) {
        await this.settleReadinessExit(
          childProcess,
          readinessFailure,
          async (finalizedReadinessFailure) => {
            polling.active = false;
            this.wakeReadinessWaiters(polling);
            await pollingPromise;
            perf.endOperation("devicePolling");
            cleanupProcessListeners();
            throw finalizedReadinessFailure;
          },
        );
        state.processExitError = null;
        // Release a poller parked on this exit's settlement (#14430).
        this.wakeReadinessWaiters(polling);
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

      // Poller completion and process exits wake this bounded fallback delay immediately.
      const delayMs = Math.min(500, timeoutMs - (this.timer.now() - startTime));
      await this.waitForReadinessDelay(delayMs, signal, polling, startTime, timeoutMs);
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
      PromiseSettledResult<Awaited<ReturnType<AdbExecutor["executeCommand"]>>>,
      PromiseSettledResult<Awaited<ReturnType<AdbExecutor["executeCommand"]>>>,
      PromiseSettledResult<Awaited<ReturnType<AdbExecutor["executeCommand"]>>>,
      PromiseSettledResult<Awaited<ReturnType<AdbExecutor["executeCommand"]>>>,
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

  private startReadinessPolling(context: EmulatorReadinessContext): Promise<void> {
    const { polling } = context;
    return this.pollEmulatorReadiness(context)
      .catch((error: unknown) => {
        logger.warn(`Emulator readiness poller failed: ${errorMessage(error)}`, error);
        polling.failure = { reason: error };
        polling.active = false;
      })
      .finally(() => {
        this.wakeReadinessWaiters(polling);
      });
  }

  private async pollEmulatorReadiness(context: EmulatorReadinessContext): Promise<void> {
    const { signal, options, startTime, timeoutMs, polling, state } = context;

    // Let the main loop register its wake-up first. When both sleeps share a
    // deadline, this lets a process-exit failure stop the poller before it
    // schedules another cycle.
    await Promise.resolve();
    while (polling.active && !state.foundDeviceId) {
      await this.awaitExitSettlement(context);
      if (!polling.active) {
        break;
      }
      const cycle: ReadinessPollCycle = { correlatedTargetDeviceId: undefined };
      let outcome: ReadinessPollOutcome = "continue";
      try {
        outcome = await this.runReadinessPollCycle(context, cycle);
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
      if (outcome === "ready") {
        return;
      }
      if (outcome === "stop" || !(await this.sleepBeforeNextPoll(context, cycle, options))) {
        break;
      }
    }
    logger.debug(
      `Background polling stopped - pollingActive: ${polling.active}, foundDeviceId: ${state.foundDeviceId}`,
    );
  }

  /**
   * Parks the poller while the main waiter settles an observed process exit (#14430).
   * The exit wakes every readiness sleep, and the launcher's exit finalization can
   * outlast a polling interval, so a cycle started in that window would leave the
   * fatal path awaiting a scan or probe bounded only by the caller's signal. A fatal
   * settlement stops polling; a non-fatal one clears the error and wakes the poller.
   */
  private async awaitExitSettlement(context: EmulatorReadinessContext): Promise<void> {
    const { signal, startTime, timeoutMs, polling, state } = context;
    while (polling.active && state.processExitError) {
      const remainingMs = timeoutMs - (this.timer.now() - startTime);
      if (remainingMs <= 0) {
        polling.active = false;
        return;
      }
      const delayMs = Math.min(remainingMs, MAX_POLLING_SLEEP_CHUNK_MS);
      await this.waitForReadinessDelay(delayMs, signal, polling, startTime, timeoutMs);
    }
  }

  /** One discovery-and-probe pass: "ready" ends polling successfully, "stop" ends it, else sleep. */
  private async runReadinessPollCycle(
    context: EmulatorReadinessContext,
    cycle: ReadinessPollCycle,
  ): Promise<ReadinessPollOutcome> {
    const {
      avdName,
      timeoutMs,
      childProcess,
      targetDeviceId,
      signal,
      options,
      startTime,
      state,
      polling,
      unresolvedNameSerials,
      offlineTracker,
    } = context;
    this.recordLaunchError(childProcess, (error) => {
      state.processExitError = error;
      this.wakeReadinessWaiters(polling);
    });
    logger.debug(`Background polling iteration - checking for emulator '${avdName}'...`);

    const correlatedTargetDeviceId = this.readinessTargetDeviceId(
      targetDeviceId,
      childProcess,
      state.resolvedTargetDeviceId,
    );
    cycle.correlatedTargetDeviceId = correlatedTargetDeviceId;
    const remainingTimeoutMs = timeoutMs - (this.timer.now() - startTime);
    if (remainingTimeoutMs <= 0) {
      polling.active = false;
      return "stop";
    }
    const snapshotTimeoutMs = Math.min(AdbClient.DEVICE_LIST_TIMEOUT_MS, remainingTimeoutMs);
    const snapshot = await this.readReadinessSnapshot(snapshotTimeoutMs, signal, offlineTracker);
    await this.detectOfflineFailure(
      correlatedTargetDeviceId,
      offlineTracker,
      snapshotTimeoutMs,
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
      return "stop";
    }

    // For local emulators, check for running devices
    logger.debug(`Checking for running local emulators...`);
    const scan = await this.scanReadinessDevices(context, snapshot, correlatedTargetDeviceId);
    const scanDiagnostic = relevantScanDiagnostic(scan, correlatedTargetDeviceId);
    retryUnresolvedReadinessNames(scan.devices, unresolvedNameSerials);
    state.lastDiagnostic = scanDiagnostic;
    const runningEmulators = scan.devices.filter((device) => !device.foreignOwned);
    logger.debug(`Device scan complete - found ${runningEmulators.length} running emulators`);
    const readinessTimeoutMs = Math.max(
      0,
      Math.min(READINESS_PROBE_TIMEOUT_MS, timeoutMs - (this.timer.now() - startTime)),
    );
    if (readinessTimeoutMs <= 0) {
      return "stop";
    }

    const emulator = this.selectReadinessEmulator(
      context,
      runningEmulators,
      correlatedTargetDeviceId,
    );
    if (emulator && emulator.deviceId) {
      const ready = await this.probeSelectedEmulator(
        context,
        emulator,
        scanDiagnostic,
        readinessTimeoutMs,
        correlatedTargetDeviceId,
      );
      return ready ? "ready" : "continue";
    }
    if (runningEmulators.length > 0) {
      logger.debug(`No suitable emulator found for '${avdName}' - will continue polling`);
    }
    return "continue";
  }

  private async readReadinessSnapshot(
    timeoutMs: number,
    signal: AbortSignal | undefined,
    offlineTracker: OfflineTracker,
  ) {
    const discoveryAdb = this.adbFactory.create(null);
    try {
      return discoveryAdb.getReadinessDeviceSnapshot
        ? await discoveryAdb.getReadinessDeviceSnapshot({ timeoutMs, signal })
        : undefined;
    } catch (error) {
      // A failed snapshot is a gap in offline observations, not continued offline time.
      this.clearOfflineTracker(offlineTracker);
      throw error;
    }
  }

  /** Runs the parallel state/package/boot probes against the selected emulator; true when ready. */
  private async probeSelectedEmulator(
    context: EmulatorReadinessContext,
    emulator: BootedDevice,
    scanDiagnostic: ReturnType<typeof relevantScanDiagnostic>,
    readinessTimeoutMs: number,
    correlatedTargetDeviceId: string | undefined,
  ): Promise<boolean> {
    const { signal, state, perf, offlineTracker } = context;
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
      return this.applyReadinessProbeResults(context, emulator, scanDiagnostic, results);
    } catch (parallelError) {
      // Transient readiness probe failures are retried until the deadline.
      throwIfReadinessAborted(signal);
      logger.debug(
        `[PARALLEL] ❌ Parallel checks failed for ${emulator.deviceId}: ${parallelError}`,
      );
      return false;
    }
  }

  /** Sleeps out the polling interval in bounded chunks; false when the deadline has passed. */
  private async sleepBeforeNextPoll(
    context: EmulatorReadinessContext,
    cycle: ReadinessPollCycle,
    options: AndroidEmulatorReadinessOptions | undefined,
  ): Promise<boolean> {
    const { signal, startTime, timeoutMs, polling, state, pollingIntervalMs, offlineTracker } =
      context;
    const now = this.timer.now();
    const remainingPollingTimeMs = timeoutMs - (now - startTime);
    if (remainingPollingTimeMs <= 0) {
      polling.active = false;
      return false;
    }
    let remainingPollingDelayMs = this.host.nextPollingDelayMs(
      offlineTracker,
      options,
      cycle.correlatedTargetDeviceId,
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
    return true;
  }

  private monitorReadinessProcess(context: EmulatorReadinessContext): () => void {
    const { avdName, childProcess, state, polling } = context;
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
        this.wakeReadinessWaiters(polling);
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

  wakeAndUnlock(device: BootedDevice, signal?: AbortSignal): Promise<void> {
    return this.bootUnlock.wakeAndUnlock(device, signal);
  }
}
