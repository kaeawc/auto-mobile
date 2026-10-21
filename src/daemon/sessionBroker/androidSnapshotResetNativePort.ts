import { createHash } from "node:crypto";
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
  inventory(options: { signal: AbortSignal; timeoutMs: number }): Promise<BootedDevice[]>;
  ctrlProxyReady(device: BootedDevice): Promise<boolean>;
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
    await this.assertTarget(device, step);
    const config = await this.dependencies.config.readConfig(device.name);
    await step.assertOwned();
    if (!config?.systemImagePackage || !config.systemImagePath) {
      throw new ActionableError("Android baseline lacks system-image metadata");
    }
    const metadata = await this.dependencies.imageMetadata(config.systemImagePath, step.signal);
    await step.assertOwned();
    const version = await this.dependencies.emulator.executeCommand(
      ["-version"],
      Math.min(2000, step.timeoutMs),
      step.signal,
    );
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
    await this.dependencies.console.runExclusive(device.deviceId, async () => {
      const result = await this.dependencies.adb
        .create(device)
        .execute(buildVmSnapshotCommand(action, ANDROID_BROKER_BASELINE_SNAPSHOT).split(" "), {
          timeoutMs: Math.min(30_000, step.timeoutMs),
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
    if (!(await this.dependencies.ctrlProxyReady(device))) {
      throw new ActionableError("Android snapshot CtrlProxy health check failed");
    }
    await this.assertTarget(device, step);
  }

  async stop(device: BootedDevice, step: AndroidSnapshotStep): Promise<void> {
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
      timeoutMs: Math.min(30_000, step.timeoutMs),
      processStop: { stopper: this.dependencies.processStopper, expectedAvdName: device.name },
    });
    for (;;) {
      await step.assertOwned();
      const devices = await this.dependencies.inventory({
        signal: step.signal,
        timeoutMs: Math.min(2000, step.timeoutMs),
      });
      if (
        !devices.some(
          (candidate) => candidate.deviceId === device.deviceId || candidate.name === device.name,
        )
      ) {
        const unsettled = await this.dependencies.emulator.getListedNonDeviceStatesAmong(
          [device.deviceId],
          {
            signal: step.signal,
            timeoutMs: Math.min(2000, step.timeoutMs),
          },
        );
        if (
          !unsettled.has(device.deviceId) &&
          (await this.processExited(device, step, deadlineMs))
        ) {
          return;
        }
      }
      if (this.dependencies.timer.now() >= deadlineMs) {
        throw new ActionableError(
          "Android reset emulator process did not exit before the deadline",
        );
      }
      await this.dependencies.timer.sleep(100);
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
    await this.dependencies.emulator.waitForEmulatorReady(
      device.name,
      step.timeoutMs,
      null,
      device.deviceId,
      step.signal,
      { skipWakeAndUnlock: true },
    );
  }

  ready(device: BootedDevice, step: AndroidSnapshotStep): Promise<void> {
    return this.dependencies.readiness.ready(device, step);
  }

  private fencedAdb(device: BootedDevice, step: AndroidSnapshotStep): AdbCommandRunner {
    const adb = this.dependencies.adb.create(device);
    const deadlineMs = this.dependencies.timer.now() + step.timeoutMs;
    return {
      executeCommand: async (command, options) => {
        await step.assertOwned();
        step.signal.throwIfAborted();
        const remainingMs = deadlineMs - this.dependencies.timer.now();
        if (remainingMs <= 0) {
          throw new ActionableError("Android health check exceeded its reset deadline");
        }
        return adb.executeCommand(command, {
          ...options,
          timeoutMs: Math.min(options?.timeoutMs ?? 2000, remainingMs),
          signal: step.signal,
          noRetry: true,
          beforeDispatch: () => step.assertOwned(),
        });
      },
    };
  }

  private async assertTarget(
    device: BootedDevice,
    step: AndroidSnapshotStep,
    consoleExclusiveOwner = false,
  ): Promise<void> {
    await step.assertOwned();
    const name = await this.dependencies.emulator.resolveAvdNameForSerial(device.deviceId, {
      signal: step.signal,
      timeoutMs: Math.min(2000, step.timeoutMs),
      consoleExclusiveOwner,
    });
    await step.assertOwned();
    if (name !== device.name) {
      throw new ActionableError("Android snapshot reset serial no longer hosts its owned AVD");
    }
  }
}
