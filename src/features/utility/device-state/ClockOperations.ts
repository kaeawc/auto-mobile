import type { BootedDevice } from "../../../models";
import type { AdbClientFactory } from "../../../utils/android-cmdline-tools/AdbClientFactory";
import type { Timer } from "../../../utils/SystemTimer";
import { logger } from "../../../utils/logger";
import { invalidateDisplayCaches } from "../../observe/DisplayTransition";
import {
  AndroidDeviceClockAdapter,
  cancellableDeviceClockAdapter,
  defaultDeviceClockRestoreRegistry,
  readDeviceClock,
  writeDeviceClock,
  preflightDeviceClock,
  clockFailure,
  DeviceClockValidationError,
  type DeviceClockRestoreSlot,
  type DeviceClockRestoreRegistry,
  type PreparedDeviceClock,
  type DeviceClockAdapter,
  type DeviceClockState,
  type SetDeviceClockInput,
} from "../DeviceClock";
import { LocationWriteAdmissionError } from "./LocationOperations";
import type {
  DeviceStateDependencies,
  SetDeviceStateInput,
  RequestedDeviceStates,
} from "./DeviceStateTypes";

interface ClockOperationsDependencies {
  device: () => BootedDevice;
  adbFactory: () => AdbClientFactory;
  timer: () => Timer;
}

export class ClockOperations {
  private readonly clockRestoreRegistry: DeviceClockRestoreRegistry;
  private readonly clockSignal: AbortSignal;
  private clockAdapter!: DeviceClockAdapter;
  private clockMutation!: NonNullable<DeviceStateDependencies["clockMutation"]>;
  private invalidateClockCaches!: (deviceId: string) => void;

  constructor(
    private readonly dependencies: ClockOperationsDependencies,
    restoreRegistry?: DeviceClockRestoreRegistry,
  ) {
    this.clockRestoreRegistry = restoreRegistry ?? defaultDeviceClockRestoreRegistry;
    this.clockSignal = this.clockRestoreRegistry.signal(this.dependencies.device().deviceId);
  }

  // Initialization stays in phases to preserve DeviceState's constructor ordering:
  // registry/signal, ADB factory, adapter, timer, mutation, then invalidation.
  initializeAdapter(adapter?: DeviceClockAdapter): void {
    this.clockAdapter = cancellableDeviceClockAdapter(
      adapter ??
        new AndroidDeviceClockAdapter(
          {
            executeCommand: (command, options) =>
              this.dependencies
                .adbFactory()
                .create(this.dependencies.device())
                .executeCommand(command, options),
          },
          this.clockSignal,
        ),
      this.clockSignal,
    );
  }

  initializeMutation(mutation: DeviceStateDependencies["clockMutation"]): void {
    this.clockMutation = mutation ?? ((mutation) => mutation());
  }

  initializeCacheInvalidation(invalidate: DeviceStateDependencies["invalidateClockCaches"]): void {
    this.invalidateClockCaches =
      invalidate ?? ((deviceId) => invalidateDisplayCaches(deviceId, "Device clock changed"));
  }

  read(): Promise<DeviceClockState> {
    return readDeviceClock(this.dependencies.device(), this.clockAdapter);
  }

  async writeClockCombinedStates(
    input: SetDeviceStateInput,
    writeRequestedStates: (
      input: SetDeviceStateInput,
      prepared?: PreparedDeviceClock,
      failure?: DeviceClockState,
      slot?: DeviceClockRestoreSlot,
    ) => Promise<RequestedDeviceStates>,
  ): Promise<RequestedDeviceStates> {
    try {
      // Track session setup before taking the device lock. Release drains those
      // setups first, then takes this same lock for restoration.
      return await this.clockMutation((sessionSlot) =>
        this.clockRestoreRegistry.runExclusive(
          this.dependencies.device().deviceId,
          async (slot) => {
            const preflight = await this.preflightClock(input.clock);
            this.clockSignal.throwIfAborted();
            return writeRequestedStates(input, preflight.prepared, preflight.failure, slot);
          },
          sessionSlot,
          this.clockSignal,
        ),
      );
    } catch (error) {
      if (
        error instanceof DeviceClockValidationError ||
        error instanceof LocationWriteAdmissionError
      ) {
        throw error;
      }
      logger.warn(`Clock mutation failed for ${this.dependencies.device().deviceId}`, error);
      return { clock: clockFailure(error) };
    }
  }

  private async preflightClock(
    input: SetDeviceClockInput | undefined,
  ): Promise<{ prepared?: PreparedDeviceClock; failure?: DeviceClockState }> {
    return input?.mode === "advance"
      ? preflightDeviceClock(this.dependencies.device(), this.clockAdapter, input)
      : {};
  }

  async writeClock(
    input: SetDeviceClockInput,
    prepared?: PreparedDeviceClock,
    slot?: DeviceClockRestoreSlot,
  ): Promise<DeviceClockState> {
    try {
      return await writeDeviceClock(this.dependencies.device(), this.clockAdapter, input, {
        slot,
        dependencies: {
          hostClock: this.dependencies.timer(),
          invalidate: this.invalidateClockCaches,
          restoreRegistry: this.clockRestoreRegistry,
          mutationSignal: this.clockSignal,
        },
        prepared,
      });
    } catch (error) {
      logger.warn(`Clock mutation failed for ${this.dependencies.device().deviceId}`, error);
      return clockFailure(error);
    }
  }
}
