import { raceWithDeadline } from "../../utils/raceWithDeadline";
import { watchEmulatorProcessDeath } from "./androidEmulatorLiveness";
import { createHash } from "node:crypto";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import type { BootedDevice } from "../../models/DeviceInfo";
import { ActionableError } from "../../models/ActionableError";
import type { BootCapacityReserver } from "../../devices/bootAdmission/BootSlotReservation";
import type {
  AndroidEmulator,
  AndroidEmulatorForDeviceManager,
} from "../../utils/android-cmdline-tools/AndroidEmulatorClient";
import type { AdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import type { AvdConfigReader } from "../../utils/android-cmdline-tools/AvdConfigReader";
import type { EmulatorConsoleBusyRegistry } from "../../utils/android-cmdline-tools/EmulatorConsoleBusyRegistry";
import {
  buildVmSnapshotCommand,
  evaluateVmSnapshotResult,
  isMissingVmSnapshotError,
  type VmSnapshotAction,
} from "../../utils/android-cmdline-tools/vmSnapshot";
import { outputLooksLikeShellFailure } from "../../utils/android-cmdline-tools/shellOutputHeuristics";
import { ANDROID_BROKER_BASELINE_SNAPSHOT } from "../../utils/snapshotNameValidation";
import type { Timer } from "../../utils/SystemTimer";
import { AndroidDeviceClockAdapter } from "../../features/utility/AndroidDeviceClockAdapter";
import {
  restoreDeviceClock,
  type DeviceClockRestoreRegistry,
} from "../../features/utility/DeviceClock";
import type { AdbCommandRunner } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import type { EmulatorProcessStopper } from "../../utils/android-cmdline-tools/EmulatorProcessStop";
import type {
  AndroidSnapshotIdentity,
  AndroidSnapshotResetPort,
  AndroidSnapshotStep,
} from "./androidSnapshotReset";

import {
  adbAttemptTimeoutMs,
  ctrlProxyDeadlineMs,
  pollUntilWithinBudget,
  retryAdbWithinBudget,
} from "./androidResetBudget";

export interface AndroidSnapshotReadiness {
  ready(device: BootedDevice, step: AndroidSnapshotStep): Promise<void>;
  ctrlProxyIdentity(device: BootedDevice, signal: AbortSignal): Promise<string>;
}

export interface AndroidSnapshotNativeDependencies {
  emulator: Pick<
    AndroidEmulator,
    | "executeCommand"
    | "resolveAvdNameForSerial"
    | "killDevice"
    | "launchEmulator"
    | "waitForEmulatorReady"
  > &
    Pick<AndroidEmulatorForDeviceManager, "getListedNonDeviceStatesAmong">;
  adb: AdbClientFactory;
  config: AvdConfigReader;
  console: EmulatorConsoleBusyRegistry;
  capacity: BootCapacityReserver;
  admitColdBoot(
    device: BootedDevice,
    step: AndroidSnapshotStep,
  ): ReturnType<NonNullable<Parameters<AndroidEmulator["launchEmulator"]>[0]["admitColdBoot"]>>;
  readiness: AndroidSnapshotReadiness;
  inventory(options: {
    signal: AbortSignal;
    timeoutMs: number;
    targetDeviceId: string;
  }): Promise<BootedDevice[]>;
  ctrlProxyReady(
    device: BootedDevice,
    options?: { signal?: AbortSignal; timeoutMs?: number; noRetry?: boolean },
  ): Promise<boolean>;
  imageMetadata(imagePath: string, signal: AbortSignal): Promise<string>;
  timer: Timer;
  invalidate(deviceId: string): void;
  clockRegistry: Pick<DeviceClockRestoreRegistry, "runExclusive">;
  processStopper: EmulatorProcessStopper;
  clearQuickBoot(device: BootedDevice, step: AndroidSnapshotStep): Promise<void>;
}

export class NativeAndroidSnapshotResetPort implements AndroidSnapshotResetPort {
  constructor(private readonly dependencies: AndroidSnapshotNativeDependencies) {}

  reserveBoot(options: Parameters<BootCapacityReserver["reserveBoot"]>[0]) {
    return this.dependencies.capacity.reserveBoot(options);
  }

  async identity(
    device: BootedDevice,
    step: AndroidSnapshotStep,
  ): Promise<AndroidSnapshotIdentity> {
    step = this.remainingStep(step);
    await this.assertTarget(device, step);
    const config = await this.dependencies.config.readConfig(device.name);
    await step.assertOwned();
    if (!config?.systemImagePackage || !config.systemImagePath) {
      throw new ActionableError("Android baseline lacks system-image metadata");
    }
    const metadata = await this.dependencies.imageMetadata(config.systemImagePath, step.signal);
    await step.assertOwned();
    const version = await this.retryStep(step, async (timeoutMs) => {
      await step.assertOwned();
      return this.dependencies.emulator.executeCommand(["-version"], timeoutMs, step.signal);
    });
    await step.assertOwned();
    if (version.error || !version.stdout.trim()) {
      throw new ActionableError("Android baseline lacks emulator version");
    }
    const ctrlProxyVersion = await this.dependencies.readiness.ctrlProxyIdentity(
      device,
      step.signal,
    );
    await step.assertOwned();
    return {
      avdName: device.name,
      systemImage: `${config.systemImagePackage}:${createHash("sha256")
        .update(metadata)
        .update(JSON.stringify(config.hardware ?? {}))
        .digest("hex")}`,
      emulatorVersion: version.stdout.trim(),
      ctrlProxyVersion,
    };
  }

  async snapshot(
    action: VmSnapshotAction,
    device: BootedDevice,
    step: AndroidSnapshotStep,
  ): Promise<void> {
    step = this.remainingStep(step);
    await this.dependencies.console.runExclusive(device.deviceId, async () => {
      const result = await this.dependencies.adb
        .create(device)
        .execute(buildVmSnapshotCommand(action, ANDROID_BROKER_BASELINE_SNAPSHOT).split(" "), {
          timeoutMs: step.timeoutMs,
          signal: step.signal,
          noRetry: true,
          waitForProcessSettlementAfterAbort: true,
          beforeDispatch: () => this.assertTarget(device, step, true),
        });
      step.signal.throwIfAborted();
      const evaluated = evaluateVmSnapshotResult(action, ANDROID_BROKER_BASELINE_SNAPSHOT, result);
      if (
        !evaluated.ok &&
        !(action === "delete" && isMissingVmSnapshotError(evaluated.errorMessage))
      ) {
        throw new ActionableError(evaluated.errorMessage ?? "Android baseline snapshot failed");
      }
    });
  }

  async health(device: BootedDevice, step: AndroidSnapshotStep): Promise<void> {
    step = this.remainingStep(step);
    const deadlineMs = this.dependencies.timer.now() + step.timeoutMs;
    await this.assertTarget(device, step);
    const adb = this.fencedAdb(device, step);
    const boot = await adb.executeCommand("shell getprop sys.boot_completed");
    if (boot.stdout.trim() !== "1" || outputLooksLikeShellFailure(boot.stdout, boot.stderr)) {
      throw new ActionableError("Android snapshot target has not completed boot");
    }
    const resynced = await this.dependencies.clockRegistry.runExclusive(
      device.deviceId,
      async (_slot, clockSignal) => {
        await this.assertTarget(device, step);
        const signal = AbortSignal.any([step.signal, clockSignal]);
        const clock = new AndroidDeviceClockAdapter(
          this.fencedAdb(device, {
            ...step,
            signal,
            timeoutMs: deadlineMs - this.dependencies.timer.now(),
          }),
          signal,
        );
        const root = await clock.ensureRoot();
        if (!root.success) {
          throw new ActionableError(root.error);
        }
        return restoreDeviceClock(
          device,
          clock,
          {
            initialAutomaticTime: 1,
            clockChangedByUs: true,
            rootedByUs: root.rootedByUs,
          },
          { hostClock: this.dependencies.timer, invalidate: this.dependencies.invalidate },
        );
      },
    );
    if (!resynced.verified) {
      throw new ActionableError("Android snapshot clock resync did not verify");
    }
    await step.assertOwned();
    if (!(await this.checkCtrlProxy(device, step, deadlineMs))) {
      throw new ActionableError("Android snapshot CtrlProxy health check failed");
    }
    await this.assertTarget(device, step);
  }

  private checkCtrlProxy(
    device: BootedDevice,
    step: AndroidSnapshotStep,
    resetDeadlineMs: number,
  ): Promise<boolean> {
    const timer = this.dependencies.timer;
    const deadlineMs = ctrlProxyDeadlineMs(timer, resetDeadlineMs);
    const controller = new AbortController();
    const signal = AbortSignal.any([step.signal, controller.signal]);
    const failure = () => new ActionableError("Android snapshot CtrlProxy health check failed");
    return raceWithDeadline(
      () =>
        pollUntilWithinBudget(
          async (timeoutMs) => {
            await step.assertOwned();
            const ready = await this.dependencies.ctrlProxyReady(device, {
              signal,
              timeoutMs,
              noRetry: true,
            });
            await step.assertOwned();
            return ready;
          },
          { timer, deadlineMs, signal, label: "Android snapshot CtrlProxy health check" },
        ),
      {
        timer,
        signal: step.signal,
        timeoutMs: Math.max(0, deadlineMs - timer.now()),
        label: "Android snapshot CtrlProxy health check",
        timeoutError: failure,
        onTimeout: () => controller.abort(failure()),
      },
    );
  }

  async stop(device: BootedDevice, step: AndroidSnapshotStep): Promise<void> {
    step = this.remainingStep(step);
    const deadlineMs = this.dependencies.timer.now() + step.timeoutMs;
    await this.assertTarget(device, step);
    const process = await this.dependencies.processStopper.identify(
      { serial: device.deviceId, avdName: device.name },
      { signal: step.signal, deadlineMs },
    );
    await step.assertOwned();
    if (process.kind !== "match") {
      throw new ActionableError("Android reset cannot prove the owned emulator process exists");
    }
    await this.dependencies.emulator.killDevice(device, {
      beforeDispatch: () => this.assertTarget(device, step),
      signal: step.signal,
      timeoutMs: step.timeoutMs,
      processStop: { stopper: this.dependencies.processStopper, expectedAvdName: device.name },
    });
    let lastPollError: unknown;
    const pollTimeout = () => adbAttemptTimeoutMs(deadlineMs - this.dependencies.timer.now(), 2);
    const assertBeforeDeadline = () => {
      if (this.dependencies.timer.now() >= deadlineMs) {
        throw new ActionableError(
          "Android reset emulator process did not exit before the deadline" +
            (lastPollError === undefined ? "" : `: ${errorMessage(lastPollError)}`),
        );
      }
    };
    for (;;) {
      await step.assertOwned();
      step.signal.throwIfAborted();
      assertBeforeDeadline();
      let absent = false;
      try {
        const devices = await this.dependencies.inventory({
          signal: step.signal,
          timeoutMs: pollTimeout(),
          targetDeviceId: device.deviceId,
        });
        if (
          !devices.some(
            (candidate) => candidate.deviceId === device.deviceId || candidate.name === device.name,
          ) &&
          this.dependencies.timer.now() < deadlineMs
        ) {
          const unsettled = await this.dependencies.emulator.getListedNonDeviceStatesAmong(
            [device.deviceId],
            { signal: step.signal, timeoutMs: pollTimeout() },
          );
          absent = !unsettled.has(device.deviceId);
        }
      } catch (error) {
        step.signal.throwIfAborted();
        // A failed read never proves absence; keep waiting and fail closed at the exit deadline.
        logger.debug("Android reset exit inventory poll failed; continuing to wait", error);
        lastPollError = error;
      }
      await step.assertOwned();
      step.signal.throwIfAborted();
      assertBeforeDeadline();
      if (absent && (await this.processExited(device, step, deadlineMs))) {
        return;
      }
      assertBeforeDeadline();
      await this.dependencies.timer.sleep(
        Math.min(100, deadlineMs - this.dependencies.timer.now()),
      );
    }
  }

  private async processExited(
    device: BootedDevice,
    step: AndroidSnapshotStep,
    deadlineMs: number,
  ): Promise<boolean> {
    const process = await this.dependencies.processStopper.identify(
      { serial: device.deviceId, avdName: device.name },
      { signal: step.signal, deadlineMs },
    );
    await step.assertOwned();
    if (process.kind === "absent") {
      await this.dependencies.clearQuickBoot(device, step);
      await step.assertOwned();
      return true;
    }
    if (process.kind !== "match") {
      throw new ActionableError("Android reset cannot prove the owned emulator process exited");
    }
    return false;
  }

  async launchWiped(device: BootedDevice, step: AndroidSnapshotStep): Promise<void> {
    await step.assertOwned();
    const launch = await this.dependencies.emulator.launchEmulator({
      avdName: device.name,
      deviceId: device.deviceId,
      signal: step.signal,
      extraArgs: ["-wipe-data", "-no-snapshot-load", "-no-snapshot-save"],
      admitColdBoot: () => this.dependencies.admitColdBoot(device, step),
    });
    if (
      launch.outcome !== "launched" ||
      !launch.process ||
      launch.targetDeviceId !== device.deviceId
    ) {
      launch.dispose();
      throw new ActionableError(
        "Android wipe-data reset did not launch the exact reserved emulator",
      );
    }
    launch.release();
    await step.assertOwned();
    await this.dependencies.emulator.waitForEmulatorReady(
      device.name,
      step.timeoutMs,
      launch.process,
      device.deviceId,
      step.signal,
      { freshProvision: true },
    );
  }

  async waitForRestore(device: BootedDevice, step: AndroidSnapshotStep): Promise<void> {
    await step.assertOwned();
    const { timer, processStopper } = this.dependencies;
    const controller = new AbortController();
    const signal = AbortSignal.any([step.signal, controller.signal]);
    const deadlineMs = timer.now() + step.timeoutMs;
    try {
      // A snapshot load that kills the emulator would otherwise leave the readiness poll
      // waiting out the whole step budget (#15177); the watch ends the wait on process death.
      await raceWithDeadline(
        [
          this.dependencies.emulator.waitForEmulatorReady(
            device.name,
            step.timeoutMs,
            null,
            device.deviceId,
            signal,
            { skipWakeAndUnlock: true },
          ),
          watchEmulatorProcessDeath(
            { serial: device.deviceId, avdName: device.name },
            { stopper: processStopper, timer, signal, deadlineMs, assertOwned: step.assertOwned },
          ),
        ],
        { timer, signal: step.signal, label: "Android snapshot restore readiness" },
      );
    } finally {
      controller.abort();
    }
  }

  ready(device: BootedDevice, step: AndroidSnapshotStep): Promise<void> {
    return this.dependencies.readiness.ready(device, step);
  }

  private fencedAdb(device: BootedDevice, step: AndroidSnapshotStep): AdbCommandRunner {
    const adb = this.dependencies.adb.create(device);
    step = this.remainingStep(step);
    return {
      executeCommand: (command, options) => {
        // The clock adapter captures this timestamp once; a retry would set stale time.
        const timestampWrite = command.startsWith("shell date -u @");
        return this.retryStep(
          step,
          async (timeoutMs) => {
            await step.assertOwned();
            step.signal.throwIfAborted();
            const remaining = step.timeoutMs;
            const result = await adb.executeCommand(command, {
              ...options,
              timeoutMs: timestampWrite
                ? Math.min(
                    remaining,
                    Math.max(options?.timeoutMs ?? 0, adbAttemptTimeoutMs(remaining, 3)),
                  )
                : timeoutMs,
              signal: step.signal,
              noRetry: true,
              beforeDispatch: () => step.assertOwned(),
            });
            await step.assertOwned();
            return result;
          },
          { minAttemptMs: options?.timeoutMs, attempts: timestampWrite ? 1 : undefined },
        );
      },
    };
  }

  private remainingStep(step: AndroidSnapshotStep): AndroidSnapshotStep {
    const timer = this.dependencies.timer;
    const deadlineMs = timer.now() + step.timeoutMs;
    // The getter keeps nested target checks on the same absolute step deadline.
    return {
      ...step,
      get timeoutMs() {
        return deadlineMs - timer.now();
      },
    };
  }

  private retryStep<T>(
    step: AndroidSnapshotStep,
    operation: (timeoutMs: number) => Promise<T>,
    options: { minAttemptMs?: number; attempts?: number } = {},
  ): Promise<T> {
    return retryAdbWithinBudget(operation, {
      timer: this.dependencies.timer,
      deadlineMs: this.dependencies.timer.now() + step.timeoutMs,
      signal: step.signal,
      label: "Android snapshot reset adb",
      ...options,
    });
  }

  private async assertTarget(
    device: BootedDevice,
    step: AndroidSnapshotStep,
    consoleExclusiveOwner = false,
  ): Promise<void> {
    await step.assertOwned();
    const name = await this.retryStep(step, async (timeoutMs) => {
      await step.assertOwned();
      return this.dependencies.emulator.resolveAvdNameForSerial(device.deviceId, {
        signal: step.signal,
        timeoutMs,
        consoleExclusiveOwner,
        throwOnTimeout: true,
      });
    });
    await step.assertOwned();
    if (name !== device.name) {
      throw new ActionableError("Android snapshot reset serial no longer hosts its owned AVD");
    }
  }
}
