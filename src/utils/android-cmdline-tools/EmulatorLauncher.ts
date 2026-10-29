import { ActionableError } from "../../models";
import { logger } from "../logger";
import { runDetachedFromPerf } from "../PerfContext";
import { createGlobalPerformanceTracker } from "../PerformanceTracker";
import type { HostChildProcess as ChildProcess } from "../HostCommandExecutor";
import { spawnUnderBootAdmission, type OnAdmittedSpawn } from "./spawnUnderBootAdmission";
import {
  AndroidCommandOutputStreamRedactor,
  redactAndroidCommandOutput,
} from "./redactAndroidCommandOutput";
import type {
  EmulatorDeviceIdReservation,
  EmulatorGrpcPortLease,
} from "./EmulatorPortReservations";

import {
  EARLY_EXIT_DRAIN_TIMEOUT_MS,
  boundedEmulatorOutputTail,
  recordEmulatorLaunchOutputSource,
  resolveHeadlessMode,
  parseExtraEmulatorArguments,
  EmulatorExitedDuringReadinessError,
} from "./EmulatorLaunchSupport";
import type {
  EmulatorLaunchState,
  EmulatorLaunchMonitorContext,
  EmulatorEarlyExitContext,
  EmulatorProcessOptions,
  EmulatorProcessLaunch,
  EmulatorLauncherHost,
} from "./EmulatorLaunchSupport";
import { EmulatorStartupValidation } from "./EmulatorStartupValidation";
import {
  handOffEmulatorGrpcLease,
  leaseEmulatorGrpcPort,
} from "./emulatorGrpc/emulatorGrpcLaunchLease";
import { ENV, readEnvRaw } from "../../config/env";

export * from "./EmulatorLaunchSupport";

/**
 * Spawns an emulator for an AVD: claims the AVD, reserves a console port, spawns under boot
 * admission and watches the launch output until startup validates or the process fails early.
 */
export interface EmulatorLauncher {
  startEmulatorProcess(
    avdName: string,
    options?: EmulatorProcessOptions,
  ): Promise<EmulatorProcessLaunch>;
}

export class DefaultEmulatorLauncher implements EmulatorLauncher {
  constructor(private readonly host: EmulatorLauncherHost) {}

  private createLaunchState(): EmulatorLaunchState {
    return {
      launchOutput: "",
      duplicateAvdDetected: false,
      startupValidationComplete: false,
      stdoutGraceTimeout: undefined,
      serialPollInterval: undefined,
      serialProbeInFlight: false,
      startupAccelerationFailureDetected: false,
      childTerminationObserved: false,
      earlyExitCategory: undefined,
      exitCode: undefined,
      exitSignal: undefined,
      provisionalPostValidationExitError: undefined,
      resolvePostValidationExit: undefined,
      exitDrainTimeout: undefined,
      earlyExitFinalization: undefined,
    };
  }

  async startEmulatorProcess(
    avdName: string,
    options: EmulatorProcessOptions = {},
  ): Promise<EmulatorProcessLaunch> {
    logger.info(`Using local emulator for AVD: ${avdName}`);
    const perf = createGlobalPerformanceTracker();

    // Check if the AVD exists
    perf.startOperation("validateAvd");
    const availableAvds = await this.host.listAvds({ signal: options.signal });
    perf.endOperation("validateAvd");
    if (!availableAvds.find((emu) => emu.name === avdName)) {
      throw new ActionableError(
        `AVD '${avdName}' not found. Available AVDs: ${availableAvds.map((emu) => emu.name).join(", ")}`,
      );
    }

    // Claim the AVD before any further await. The claim and its check are
    // adjacent and synchronous, so two concurrent launches of the same AVD in
    // this process can never both reach the spawn (#6407).
    if (this.host.reservations().hasInFlightLaunch(avdName)) {
      this.host.assertCameraPosterColdBoot(options.cameraPosterPath);
      logger.info(
        `AVD '${avdName}' already has a launch in flight in this process - waiting for it to be ready`,
      );
      // Joining an in-flight launch gives us no process handle of our own
      // (issue #3938); the caller's readiness wait adopts the same device.
      return { process: null, outcome: "joined-in-process-launch" };
    }
    this.host.reservations().claimInFlightLaunch(avdName);
    try {
      return await this.startClaimedEmulatorProcess(avdName, perf, options);
    } finally {
      // The claim covers this process up to the spawn; from there the console
      // port reservation carries the AVD identity through the mid-boot window.
      this.host.reservations().releaseInFlightLaunch(avdName);
    }
  }

  private async startClaimedEmulatorProcess(
    avdName: string,
    perf: ReturnType<typeof createGlobalPerformanceTracker>,
    options: EmulatorProcessOptions = {},
  ): Promise<EmulatorProcessLaunch> {
    const { requestedExtraArgs, isCancelled, signal } = options;
    if (await this.host.adoptsExistingAvdLaunch(avdName, perf, signal)) {
      this.host.assertCameraPosterColdBoot(options.cameraPosterPath);
      // Some other actor already owns this AVD, so we hold no process handle for
      // it. Return null rather than a fabricated `{} as ChildProcess`
      // (issue #3938); the caller waits for readiness regardless.
      return { process: null, outcome: "already-running" };
    }

    const avdConfig = await this.host.avdConfigReader().readConfig(avdName);
    this.host.validateAvdMemory(avdName, avdConfig);

    // Check architecture compatibility before attempting to start
    perf.startOperation("architectureCheck");
    const compatibility = await this.host.checkArchitectureCompatibility(avdName, avdConfig);
    perf.endOperation("architectureCheck");
    if (!compatibility.compatible && compatibility.reason) {
      logger.error(`Architecture compatibility check failed: ${compatibility.reason}`);
      throw new ActionableError(
        `Cannot start AVD '${avdName}': ${compatibility.reason}. On ${compatibility.hostArch} hosts, use AVDs with compatible architectures (e.g., arm64-v8a for Apple Silicon Macs).`,
      );
    }

    const args = ["-avd", avdName];
    const headlessMode = resolveHeadlessMode(process.platform, process.env);
    logger.info(
      `Emulator display mode: ${headlessMode.headless ? "headless" : "windowed"} (${headlessMode.reason})`,
    );
    if (headlessMode.headless) {
      args.push("-no-window");
    }
    args.push(...this.host.emulatorAudioArguments());
    const extraArgsRaw = readEnvRaw(ENV.EMULATOR_ARGS);
    if (extraArgsRaw) {
      args.push(...parseExtraEmulatorArguments(extraArgsRaw));
    }
    if (requestedExtraArgs) {
      args.push(...requestedExtraArgs);
    }
    this.appendCameraPosterArguments(args, options.cameraPosterPath);
    let grpcLease: EmulatorGrpcPortLease | undefined;
    try {
      grpcLease = await leaseEmulatorGrpcPort(args, this.host.reservations());
      this.host.throwIfLaunchCancelled(avdName, isCancelled);
      // Queue for capacity only now that this launch will spawn: every adoption
      // path above returned first, and an invalid AVD has already failed fast.
      const launch = await this.spawnWithBootAdmission(avdName, perf, args, options);
      handOffEmulatorGrpcLease(grpcLease, launch.process, this.host.reservations());
      return launch;
    } catch (error) {
      grpcLease?.release();
      throw error;
    }
  }

  /**
   * Holds a boot admission (#11181) across the spawn: handed off to the reserved serial the
   * moment the emulator process exists, freed when the spawn fails or finds a duplicate, and
   * freed early if that emulator exits before adb lists it.
   */
  private async spawnWithBootAdmission(
    avdName: string,
    perf: ReturnType<typeof createGlobalPerformanceTracker>,
    args: string[],
    options: EmulatorProcessOptions,
  ): Promise<EmulatorProcessLaunch> {
    const admission = await options.admitColdBoot?.();
    if (!admission) {
      return await this.spawnAdmittedEmulator(avdName, perf, args, options);
    }
    options.onAdmitted?.(admission);
    return await spawnUnderBootAdmission(admission, options.expectedDeviceId, (onAdmittedSpawn) =>
      this.spawnAdmittedEmulator(avdName, perf, args, options, onAdmittedSpawn),
    );
  }

  private async spawnAdmittedEmulator(
    avdName: string,
    perf: ReturnType<typeof createGlobalPerformanceTracker>,
    args: string[],
    options: EmulatorProcessOptions,
    onAdmittedSpawn?: OnAdmittedSpawn<ChildProcess>,
  ): Promise<EmulatorProcessLaunch & { reservedDeviceId?: string }> {
    const {
      onSpawn,
      isCancelled,
      capturePreLaunchDeviceIds = false,
      expectedDeviceId,
      signal,
    } = options;
    this.host.throwIfLaunchCancelled(avdName, isCancelled);
    const preLaunchEmulatorDeviceSnapshot = await this.host
      .reservations()
      .capturePreLaunchEmulatorDeviceIds(capturePreLaunchDeviceIds, signal);
    this.host.throwIfLaunchCancelled(avdName, isCancelled);
    const reservedEmulator = await this.host
      .reservations()
      .addReservedEmulatorPort(
        args,
        avdName,
        preLaunchEmulatorDeviceSnapshot,
        expectedDeviceId,
        signal,
      );
    this.host.releaseReservationIfLaunchCancelled(avdName, reservedEmulator, isCancelled);
    logger.info(`Starting emulator with AVD: ${avdName}`);
    logger.debug(`Emulator command: ${this.host.emulatorPath()} ${args.join(" ")}`);

    const child = await this.spawnClaimedEmulator({
      avdName,
      perf,
      args,
      reservedEmulator,
      expectedDeviceId,
      signal,
      // The capacity slot is handed off before the launch owner can act on the child.
      onSpawn: (spawned) => {
        onAdmittedSpawn?.(spawned, reservedEmulator?.deviceId);
        onSpawn?.(spawned);
      },
    });
    // The spawn resolves without a process only when the emulator exited as a duplicate of one
    // started outside this process.
    return child
      ? { process: child, outcome: "launched", reservedDeviceId: reservedEmulator?.deviceId }
      : { process: null, outcome: "duplicate-of-external" };
  }

  private appendCameraPosterArguments(args: string[], posterPath?: string): void {
    if (posterPath !== undefined) {
      if (
        args.some(
          (arg) =>
            arg === "-camera-back" ||
            arg === "-virtualscene-poster" ||
            arg.startsWith("-camera-back=") ||
            arg.startsWith("-virtualscene-poster="),
        )
      ) {
        throw new ActionableError(
          "cameraPosterPath cannot be combined with camera-back or virtualscene-poster extra arguments. Remove the conflicting arguments.",
        );
      }
      args.push("-camera-back", "virtualscene", "-virtualscene-poster", `wall=${posterPath}`);
    }
  }

  private spawnReservedEmulator(context: {
    avdName: string;
    perf: ReturnType<typeof createGlobalPerformanceTracker>;
    args: string[];
    reservedEmulator: EmulatorDeviceIdReservation | undefined;
    onSpawn: EmulatorProcessOptions["onSpawn"];
  }): ChildProcess {
    const { avdName, perf, args, reservedEmulator, onSpawn } = context;
    perf.startOperation("spawnEmulator");
    let child: ChildProcess;
    try {
      // Spawn the resident emulator detached from any request perf tracker, so
      // its later `exit` callbacks do not retain a completed request's tracker
      // via AsyncLocalStorage (see PerfContext). The launch-startup timing
      // stays under the ambient `emulator launch` scope.
      child = runDetachedFromPerf(() => this.host.spawnFn()(this.host.emulatorPath(), args));
    } catch (error) {
      if (reservedEmulator) {
        this.host.reservations().releasePendingEmulatorDeviceId(reservedEmulator);
      }
      throw error;
    }
    perf.endOperation("spawnEmulator");
    if (reservedEmulator) {
      this.host.recordReservedEmulatorDeviceId(child, reservedEmulator);
    } else {
      this.host.reservations().trackUnreservedLaunch(child, avdName);
    }
    onSpawn?.(child);

    return child;
  }

  private spawnClaimedEmulator(context: {
    avdName: string;
    perf: ReturnType<typeof createGlobalPerformanceTracker>;
    args: string[];
    reservedEmulator: EmulatorDeviceIdReservation | undefined;
    onSpawn: EmulatorProcessOptions["onSpawn"];
    expectedDeviceId?: string;
    signal?: AbortSignal;
  }): Promise<ChildProcess | null> {
    const { avdName, perf } = context;
    return new Promise((resolve, reject) => {
      const child = this.spawnReservedEmulator(context);

      // Keep only a redacted tail for launch diagnostics and failure classification.
      const stdoutRedactor = new AndroidCommandOutputStreamRedactor();
      const stderrRedactor = new AndroidCommandOutputStreamRedactor();

      const state = this.createLaunchState();
      perf.startOperation("panicDetection");

      const {
        appendRedactedLaunchOutput,
        currentLaunchOutput,
        flushLaunchOutput,
        recordEarlyExitCategory,
      } = this.createLaunchOutputHandlers(state, stdoutRedactor, stderrRedactor);
      recordEmulatorLaunchOutputSource(child, {
        snapshot: currentLaunchOutput,
        flush: flushLaunchOutput,
      });
      const { beginPostValidationExit, finalizePostValidationExit } =
        this.createPostValidationExitHandlers({
          avdName,
          child,
          state,
          recordEarlyExitCategory,
          flushLaunchOutput,
          clearExitDrainTimeout: () => clearExitDrainTimeout(),
        });

      const { stdoutCaptureHandler, stderrCaptureHandler } = this.createLaunchCaptureHandlers(
        stdoutRedactor,
        stderrRedactor,
        appendRedactedLaunchOutput,
      );
      // Monitor emulator output for PANIC errors during startup validation.
      const monitorOutput = (
        data: Buffer,
        outputRedactor: AndroidCommandOutputStreamRedactor,
        isStdout: boolean,
      ) => {
        this.monitorLaunchOutput(
          {
            state,
            child,
            perf,
            appendRedactedLaunchOutput,
            currentLaunchOutput,
            recordEarlyExitCategory,
            completeStartupValidation: () => completeStartupValidation(),
            resolve,
            reject,
          },
          data,
          outputRedactor,
        );
        startupValidation.observeOutput(data.toString(), isStdout, currentLaunchOutput());
      };

      const monitorStdoutHandler = (data: Buffer) => monitorOutput(data, stdoutRedactor, true);
      const monitorStderrHandler = (data: Buffer) => monitorOutput(data, stderrRedactor, false);

      // Set a timeout for startup validation (5 seconds should be enough to detect PANIC)
      const startupTimeout = this.host.timer().setTimeout(() => {
        if (!state.startupValidationComplete) {
          completeStartupValidation();
          perf.endOperation("panicDetection");
          // If no PANIC detected and no clear success indicators, assume success
          resolve(child);
        }
      }, 5000);

      const completeStartupValidation = () => {
        if (state.startupValidationComplete) {
          return;
        }
        state.startupValidationComplete = true;
        startupValidation.cancelEarlySignals();
        this.host.timer().clearTimeout(startupTimeout);
        child.stdout?.off("data", monitorStdoutHandler);
        child.stderr?.off("data", monitorStderrHandler);
        child.stdout?.on("data", stdoutCaptureHandler);
        child.stderr?.on("data", stderrCaptureHandler);
      };

      const startupValidation = this.createStartupValidation(
        { state, child, perf, completeStartupValidation, resolve },
        context,
      );

      const clearExitDrainTimeout = () => {
        if (state.exitDrainTimeout) {
          this.host.timer().clearTimeout(state.exitDrainTimeout);
          state.exitDrainTimeout = undefined;
        }
      };
      const finalizeEarlyExit = () => {
        if (state.startupValidationComplete || state.earlyExitFinalization) {
          return;
        }
        state.earlyExitFinalization = this.finalizeLaunchEarlyExit({
          state,
          child,
          avdName,
          perf,
          clearExitDrainTimeout,
          flushLaunchOutput,
          completeStartupValidation,
          resolve,
          reject,
        }).catch((error) => {
          logger.error(`Unable to finalize Android emulator early-exit diagnostics: ${error}`);
          if (!state.startupValidationComplete) {
            completeStartupValidation();
            perf.endOperation("panicDetection");
            reject(
              this.host.formatEarlyExitError(
                avdName,
                state.exitCode ?? null,
                state.exitSignal ?? null,
                state.earlyExitCategory,
                flushLaunchOutput(),
                "",
              ),
            );
          }
        });
      };

      this.registerLaunchListeners({
        child,
        state,
        perf,
        startupTimeout,
        startupValidation,
        monitorStdoutHandler,
        monitorStderrHandler,
        beginPostValidationExit,
        currentLaunchOutput,
        finalizePostValidationExit,
        flushLaunchOutput,
        clearExitDrainTimeout,
        completeStartupValidation,
        finalizeEarlyExit,
        reject,
      });
      startupValidation.startSerialPolling();
    });
  }

  private createStartupValidation(
    context: Pick<
      EmulatorLaunchMonitorContext,
      "state" | "child" | "perf" | "completeStartupValidation" | "resolve"
    >,
    options: Pick<EmulatorProcessOptions, "expectedDeviceId" | "signal">,
  ): EmulatorStartupValidation {
    return new EmulatorStartupValidation(
      this.host,
      context.state,
      context.child,
      () => {
        context.completeStartupValidation();
        context.perf.endOperation("panicDetection");
        context.resolve(context.child);
      },
      options.expectedDeviceId,
      options.signal,
    );
  }

  private createLaunchCaptureHandlers(
    stdoutRedactor: AndroidCommandOutputStreamRedactor,
    stderrRedactor: AndroidCommandOutputStreamRedactor,
    appendRedactedLaunchOutput: (output: string) => void,
  ) {
    // Continue capturing redacted diagnostics after startup without classifying live output.
    const captureOutput = (data: Buffer, outputRedactor: AndroidCommandOutputStreamRedactor) => {
      const redactedOutput = outputRedactor.append(data);
      appendRedactedLaunchOutput(redactedOutput);
      if (redactedOutput.length > 0) {
        logger.debug(`Emulator output: ${redactedOutput}`);
      }
    };
    const stdoutCaptureHandler = (data: Buffer) => captureOutput(data, stdoutRedactor);
    const stderrCaptureHandler = (data: Buffer) => captureOutput(data, stderrRedactor);

    return { stdoutCaptureHandler, stderrCaptureHandler };
  }

  private createLaunchOutputHandlers(
    state: EmulatorLaunchState,
    stdoutRedactor: AndroidCommandOutputStreamRedactor,
    stderrRedactor: AndroidCommandOutputStreamRedactor,
  ) {
    const appendRedactedLaunchOutput = (output: string) => {
      if (output.length > 0) {
        state.launchOutput = boundedEmulatorOutputTail(state.launchOutput + output);
      }
    };
    const currentLaunchOutput = () =>
      boundedEmulatorOutputTail(
        state.launchOutput + stdoutRedactor.snapshot() + stderrRedactor.snapshot(),
      );
    const flushLaunchOutput = () => {
      for (const redactor of [stdoutRedactor, stderrRedactor]) {
        const flushedOutput = redactor.flush();
        appendRedactedLaunchOutput(flushedOutput);
        if (flushedOutput.length > 0) {
          logger.debug(`Emulator output: ${flushedOutput}`);
        }
      }
      return state.launchOutput;
    };
    const recordEarlyExitCategory = (output: string) => {
      const category = this.host.launchFailureCategory(output);
      if (category && (!state.earlyExitCategory || category === "missing_shared_library")) {
        state.earlyExitCategory = category;
      }
    };

    return {
      appendRedactedLaunchOutput,
      currentLaunchOutput,
      flushLaunchOutput,
      recordEarlyExitCategory,
    };
  }

  private registerLaunchListeners(context: {
    child: ChildProcess;
    state: EmulatorLaunchState;
    perf: ReturnType<typeof createGlobalPerformanceTracker>;
    startupTimeout: NodeJS.Timeout;
    startupValidation: EmulatorStartupValidation;
    monitorStdoutHandler: (data: Buffer) => void;
    monitorStderrHandler: (data: Buffer) => void;
    beginPostValidationExit: (output: string) => void;
    currentLaunchOutput: () => string;
    finalizePostValidationExit: (output: string) => void;
    flushLaunchOutput: () => string;
    clearExitDrainTimeout: () => void;
    completeStartupValidation: () => void;
    finalizeEarlyExit: () => void;
    reject: (error: ActionableError) => void;
  }) {
    const {
      child,
      state,
      perf,
      startupTimeout,
      startupValidation,
      monitorStdoutHandler,
      monitorStderrHandler,
      beginPostValidationExit,
      currentLaunchOutput,
      finalizePostValidationExit,
      flushLaunchOutput,
      clearExitDrainTimeout,
      completeStartupValidation,
      finalizeEarlyExit,
      reject,
    } = context;
    // Log emulator output through the same buffered redaction path as diagnostics.
    child.stdout?.on("data", monitorStdoutHandler);
    child.stderr?.on("data", monitorStderrHandler);

    child.on("exit", (code, signal) => {
      this.host.timer().clearTimeout(startupTimeout);
      startupValidation.cancelEarlySignals();
      this.host.reservations().releaseLaunchChild(child);
      state.childTerminationObserved = true;
      state.exitCode = code;
      state.exitSignal = signal;
      if (code !== 0) {
        logger.error(`Emulator process exited with code: ${code}`);
      } else {
        logger.info(`Emulator process exited with code: ${code}`);
      }
      if (state.startupValidationComplete) {
        beginPostValidationExit(currentLaunchOutput());
      } else {
        state.exitDrainTimeout = this.host.timer().setTimeout(() => {
          logger.debug(
            `Emulator stdio did not close within ${EARLY_EXIT_DRAIN_TIMEOUT_MS}ms after an early exit`,
          );
          finalizeEarlyExit();
        }, EARLY_EXIT_DRAIN_TIMEOUT_MS);
      }
    });

    child.on("close", (code, signal) => {
      this.host.timer().clearTimeout(startupTimeout);
      startupValidation.cancelEarlySignals();
      this.host.reservations().releaseLaunchChild(child);
      clearExitDrainTimeout();
      state.childTerminationObserved = true;
      state.exitCode ??= code;
      state.exitSignal ??= signal;
      if (state.startupValidationComplete) {
        beginPostValidationExit(currentLaunchOutput());
        finalizePostValidationExit(flushLaunchOutput());
        return;
      }
      finalizeEarlyExit();
    });

    child.on("error", (error) => {
      this.host.timer().clearTimeout(startupTimeout);
      if (state.startupValidationComplete) {
        // The exit drain timer or close event owns finalization so later stdio is retained.
        return;
      }
      clearExitDrainTimeout();
      completeStartupValidation();
      perf.endOperation("panicDetection");
      reject(new ActionableError(`Emulator failed to start: ${error.message}`));
    });
  }

  private createPostValidationExitHandlers(context: {
    avdName: string;
    child: ChildProcess;
    state: EmulatorLaunchState;
    recordEarlyExitCategory: (output: string) => void;
    flushLaunchOutput: () => string;
    clearExitDrainTimeout: () => void;
  }) {
    const {
      avdName,
      child,
      state,
      recordEarlyExitCategory,
      flushLaunchOutput,
      clearExitDrainTimeout,
    } = context;
    const postValidationExitError = (output: string): ActionableError => {
      const formattedError = this.host.formatEarlyExitError(
        avdName,
        state.exitCode ?? null,
        state.exitSignal ?? null,
        state.earlyExitCategory,
        output,
        "",
      );
      if (
        !state.earlyExitCategory &&
        !this.host.sandboxFailure(output) &&
        !this.host.detectCorruptImage(output).isCorrupt &&
        !this.host.detectDisplayError(output).isDisplayError &&
        !this.host.detectArchitecturePanic(output).isPanic
      ) {
        return new EmulatorExitedDuringReadinessError(
          state.exitCode ?? null,
          formattedError.message,
        );
      }
      return formattedError;
    };
    const beginPostValidationExit = (output: string) => {
      if (
        !state.startupValidationComplete ||
        state.exitCode === undefined ||
        state.resolvePostValidationExit
      ) {
        return;
      }
      state.duplicateAvdDetected ||= output.includes(
        "Running multiple emulators with the same AVD",
      );
      this.host.launchErrorFinalizations().set(
        child,
        new Promise<ActionableError | undefined>((resolveFinalization) => {
          state.resolvePostValidationExit = resolveFinalization;
        }),
      );
      if (!this.host.launchErrors().has(child)) {
        state.provisionalPostValidationExitError = postValidationExitError(output);
        this.host.launchErrors().set(child, state.provisionalPostValidationExitError);
      }
      state.exitDrainTimeout = this.host.timer().setTimeout(() => {
        logger.debug(
          `Emulator stdio did not close within ${EARLY_EXIT_DRAIN_TIMEOUT_MS}ms after a validated exit`,
        );
        finalizePostValidationExit(flushLaunchOutput());
      }, EARLY_EXIT_DRAIN_TIMEOUT_MS);
    };
    const finalizePostValidationExit = (output: string) => {
      if (!state.resolvePostValidationExit) {
        return;
      }
      clearExitDrainTimeout();
      if (
        state.duplicateAvdDetected ||
        output.includes("Running multiple emulators with the same AVD")
      ) {
        // The in-process guards make this unreachable within one daemon, so a
        // duplicate that still happens came from ANOTHER process. Adoption
        // stays the behaviour, but it is no longer silent (#6407).
        logger.warn(
          `Emulator launch for AVD '${avdName}' exited as a duplicate of an emulator started outside this process; adopting it`,
        );
        this.host.launchErrors().delete(child);
        this.host.launchTargetDeviceIds().delete(child);
        const resolveFinalization = state.resolvePostValidationExit;
        state.resolvePostValidationExit = undefined;
        resolveFinalization(undefined);
        return;
      }
      if (
        !this.host.launchErrors().has(child) ||
        this.host.launchErrors().get(child) === state.provisionalPostValidationExitError
      ) {
        recordEarlyExitCategory(output);
        const sandboxError = this.host.sandboxFailure(output);
        state.provisionalPostValidationExitError = sandboxError
          ? new ActionableError(
              `${postValidationExitError(output).message}\n\n${sandboxError.message}`,
            )
          : postValidationExitError(output);
        this.host.launchErrors().set(child, state.provisionalPostValidationExitError);
      }
      const finalError = this.host.launchErrors().get(child) ?? postValidationExitError(output);
      const resolveFinalization = state.resolvePostValidationExit;
      state.resolvePostValidationExit = undefined;
      resolveFinalization(finalError);
    };

    return { beginPostValidationExit, finalizePostValidationExit };
  }

  private architecturePanicMessage(
    directPanicResult: ReturnType<EmulatorLauncherHost["detectArchitecturePanic"]>,
  ): string {
    // Create a more helpful error message
    let errorMessage = `Emulator failed to start: ${directPanicResult.message}`;
    if (directPanicResult.hostArch && directPanicResult.avdArch) {
      errorMessage += `\n\nSuggestion: On ${directPanicResult.hostArch} hosts, create AVDs with compatible architectures:`;
      if (directPanicResult.hostArch === "aarch64" || directPanicResult.hostArch === "arm64") {
        errorMessage += `\n- Use ARM64 system images (arm64-v8a) instead of x86/x86_64`;
        errorMessage += `\n- Example: avdmanager create avd -n MyAVD -k "system-images;android-35;google_apis;arm64-v8a"`;
      } else if (directPanicResult.hostArch === "x86" || directPanicResult.hostArch === "x86_64") {
        errorMessage += `\n- Use x86/x86_64 system images instead of ARM64`;
        errorMessage += `\n- Example: avdmanager create avd -n MyAVD -k "system-images;android-35;google_apis;x86_64"`;
      }
    }

    return errorMessage;
  }

  private monitorLaunchImageAndDisplay(
    context: EmulatorLaunchMonitorContext,
    safeChunk: string,
    diagnosticOutput: string,
  ): boolean {
    const { state, child, perf, completeStartupValidation, reject } = context;
    // Check for corrupt disk image
    const directCorruptResult = this.host.detectCorruptImage(safeChunk);
    if (directCorruptResult.isCorrupt) {
      logger.error(`Emulator corrupt image detected: ${directCorruptResult.message}`);

      let errorMessage = `Emulator failed to start: ${directCorruptResult.message}`;
      if (directCorruptResult.suggestion) {
        errorMessage += `\n\nSuggestion: ${directCorruptResult.suggestion}`;
      }

      if (!child.killed) {
        child.kill();
      }

      if (!state.startupValidationComplete) {
        completeStartupValidation();
        perf.endOperation("panicDetection");
        reject(new ActionableError(errorMessage));
      }
      return true;
    }

    // Check for display / Qt platform-plugin failure (windowed launch on a headless host)
    const displayResult = this.host.detectDisplayError(diagnosticOutput);
    const directDisplayResult = displayResult.isDisplayError
      ? displayResult
      : this.host.detectDisplayError(safeChunk);
    if (directDisplayResult.isDisplayError) {
      logger.error(`Emulator display error detected: ${directDisplayResult.message}`);

      let errorMessage = `Emulator failed to start: ${directDisplayResult.message}`;
      if (directDisplayResult.suggestion) {
        errorMessage += `\n\nSuggestion: ${directDisplayResult.suggestion}`;
      }

      if (!child.killed) {
        child.kill();
      }

      if (!state.startupValidationComplete) {
        completeStartupValidation();
        perf.endOperation("panicDetection");
        reject(
          this.host.appendCategory(
            new ActionableError(errorMessage),
            "display_initialization_failed",
          ),
        );
      }
      return true;
    }

    return false;
  }

  private monitorLaunchSandboxAndPanic(
    context: EmulatorLaunchMonitorContext,
    safeChunk: string,
    diagnosticOutput: string,
  ): boolean {
    const { state, child, perf, completeStartupValidation, reject } = context;
    // Detect sandbox/JIT entitlement failures before generic PANIC handling.
    const sandboxError =
      this.host.sandboxFailure(diagnosticOutput) ?? this.host.sandboxFailure(safeChunk);
    if (sandboxError) {
      logger.error(`Emulator sandbox error detected: ${sandboxError.message}`);
      this.host.launchErrors().set(child, sandboxError);
      if (!child.killed) {
        child.kill();
      }
      if (!state.startupValidationComplete) {
        completeStartupValidation();
        perf.endOperation("panicDetection");
        reject(sandboxError);
      }
      return true;
    }

    // Check for PANIC in the output
    const directPanicResult = this.host.detectArchitecturePanic(safeChunk);
    if (directPanicResult.isPanic) {
      logger.error(`Emulator PANIC detected: ${directPanicResult.message}`);

      const errorMessage = this.architecturePanicMessage(directPanicResult);

      // Kill the process if it's still running
      if (!child.killed) {
        child.kill();
      }

      // Reject the promise instead of just emitting error
      if (!state.startupValidationComplete) {
        completeStartupValidation();
        perf.endOperation("panicDetection");
        reject(new ActionableError(errorMessage));
      }
      return true;
    }

    return false;
  }

  private monitorLaunchOutput(
    context: EmulatorLaunchMonitorContext,
    data: Buffer,
    outputRedactor: AndroidCommandOutputStreamRedactor,
  ): void {
    const {
      state,
      child,
      perf,
      appendRedactedLaunchOutput,
      currentLaunchOutput,
      recordEarlyExitCategory,
      completeStartupValidation,
      resolve,
    } = context;
    const output = outputRedactor.decode(data);
    const safeChunk = redactAndroidCommandOutput(output);
    const redactedOutput = outputRedactor.append(output);
    appendRedactedLaunchOutput(redactedOutput);
    if (redactedOutput.length > 0) {
      logger.debug(`Emulator output: ${redactedOutput}`);
    }
    const diagnosticOutput = currentLaunchOutput();
    this.host.captureLaunchTargetDeviceId(child, diagnosticOutput);
    state.duplicateAvdDetected ||=
      diagnosticOutput.includes("Running multiple emulators with the same AVD") ||
      safeChunk.includes("Running multiple emulators with the same AVD");
    recordEarlyExitCategory(diagnosticOutput);
    recordEarlyExitCategory(safeChunk);

    if (this.monitorLaunchSandboxAndPanic(context, safeChunk, diagnosticOutput)) {
      return;
    }

    if (this.monitorLaunchImageAndDisplay(context, safeChunk, diagnosticOutput)) {
      return;
    }

    // Check for successful startup indicators
    if (
      output.includes("INFO         | emuDirName:") ||
      output.includes("Hax is enabled") ||
      output.includes("Detected GPU type")
    ) {
      // Emulator has started successfully, resolve with the child process
      if (!state.childTerminationObserved && !state.startupValidationComplete) {
        completeStartupValidation();
        perf.endOperation("panicDetection");
        resolve(child);
      }
    }
  }

  private finalizeKnownLaunchFailure(
    context: EmulatorEarlyExitContext,
    finalizedOutput: string,
  ): boolean {
    const { state, child, perf, completeStartupValidation, reject } = context;
    // Check if exit was due to a sandbox/JIT entitlement failure.
    const sandboxError = this.host.sandboxFailure(finalizedOutput);
    if (sandboxError) {
      logger.error(`Exit was due to emulator sandbox error: ${sandboxError.message}`);
      this.host.launchErrors().set(child, sandboxError);
      if (!state.startupValidationComplete) {
        completeStartupValidation();
        perf.endOperation("panicDetection");
        reject(sandboxError);
      }
      return true;
    }

    // Check if exit was due to PANIC.
    const panicResult = this.host.detectArchitecturePanic(finalizedOutput);
    if (panicResult.isPanic) {
      logger.error(`Exit was due to PANIC: ${panicResult.message}`);
      if (!state.startupValidationComplete) {
        completeStartupValidation();
        perf.endOperation("panicDetection");
        reject(new ActionableError(`Emulator failed to start: ${panicResult.message}`));
      }
      return true;
    }

    // Check if exit was due to corrupt disk image.
    const corruptResult = this.host.detectCorruptImage(finalizedOutput);
    if (corruptResult.isCorrupt) {
      logger.error(`Exit was due to corrupt image: ${corruptResult.message}`);
      if (!state.startupValidationComplete) {
        completeStartupValidation();
        perf.endOperation("panicDetection");
        let errorMessage = `Emulator failed to start: ${corruptResult.message}`;
        if (corruptResult.suggestion) {
          errorMessage += `\n\nSuggestion: ${corruptResult.suggestion}`;
        }
        reject(new ActionableError(errorMessage));
      }
      return true;
    }

    // Check if exit was due to a display / Qt platform-plugin failure.
    // Signal death (e.g. SIGABRT from the failed xcb plugin) arrives as code === null.
    const displayResult = this.host.detectDisplayError(finalizedOutput);
    if (displayResult.isDisplayError) {
      logger.error(`Exit was due to display error: ${displayResult.message}`);
      if (!state.startupValidationComplete) {
        completeStartupValidation();
        perf.endOperation("panicDetection");
        let errorMessage = `Emulator failed to start: ${displayResult.message}`;
        if (displayResult.suggestion) {
          errorMessage += `\n\nSuggestion: ${displayResult.suggestion}`;
        }
        reject(
          this.host.appendCategory(
            new ActionableError(errorMessage),
            "display_initialization_failed",
          ),
        );
      }
      return true;
    }

    return false;
  }

  private adoptDuplicateLaunchExit(
    context: EmulatorEarlyExitContext,
    finalizedOutput: string,
  ): boolean {
    const { state, avdName, perf, completeStartupValidation, resolve } = context;
    // Another emulator already owns this AVD; we hold no process handle
    // for it. Resolve null rather than a fabricated handle (issue #3938);
    // the caller waits for readiness regardless.
    if (
      state.duplicateAvdDetected ||
      finalizedOutput.includes("Running multiple emulators with the same AVD")
    ) {
      logger.warn(
        `AVD '${avdName}' is already starting/running in another process - adopting it instead of the duplicate we launched`,
      );
      if (!state.startupValidationComplete) {
        completeStartupValidation();
        perf.endOperation("panicDetection");
        resolve(null);
      }
      return true;
    }

    return false;
  }

  private async finalizeLaunchEarlyExit(context: EmulatorEarlyExitContext): Promise<void> {
    const {
      state,
      avdName,
      perf,
      clearExitDrainTimeout,
      flushLaunchOutput,
      completeStartupValidation,
      reject,
    } = context;

    clearExitDrainTimeout();
    const finalizedOutput = flushLaunchOutput();
    const completedExitCode = state.exitCode ?? null;
    const completedExitSignal = state.exitSignal ?? null;

    if (this.adoptDuplicateLaunchExit(context, finalizedOutput)) {
      return;
    }

    if (this.finalizeKnownLaunchFailure(context, finalizedOutput)) {
      return;
    }

    let category = state.earlyExitCategory ?? this.host.launchFailureCategory(finalizedOutput);
    let accelCheckOutput = "";
    if (
      completedExitCode !== 0 &&
      this.host.platform() === "linux" &&
      (!category || category === "kvm_permission_denied")
    ) {
      accelCheckOutput = await this.host.runAccelerationCheck();
      category = category ?? this.host.accelerationCheckCategory(accelCheckOutput);
    }
    if (!state.startupValidationComplete) {
      completeStartupValidation();
      perf.endOperation("panicDetection");
      reject(
        this.host.formatEarlyExitError(
          avdName,
          completedExitCode,
          completedExitSignal,
          category,
          finalizedOutput,
          accelCheckOutput,
        ),
      );
    }
  }
}
