import { logger } from "../logger";
import type { HostChildProcess as ChildProcess } from "../HostCommandExecutor";
import type { ActionableError, BootedDevice } from "../../models";
import type {
  EmulatorDeviceIdReservation,
  EmulatorPortReservations,
} from "./EmulatorPortReservations";
import { detectDeviceIdFromEmulatorOutput } from "./emulatorLaunchFailure";

/**
 * Per-child launch bookkeeping: which adb serial a spawned emulator targets, and the
 * early-exit error (plus its in-flight finalization) recorded for it.
 */
export interface EmulatorLaunchTargets {
  readonly launchTargetDeviceIds: WeakMap<ChildProcess, string>;
  readonly launchErrors: WeakMap<ChildProcess, ActionableError>;
  readonly launchErrorFinalizations: WeakMap<ChildProcess, Promise<ActionableError | undefined>>;
  getLaunchTargetDeviceId(childProcess?: ChildProcess | null): string | undefined;
  getLaunchError(childProcess?: ChildProcess | null): ActionableError | undefined;
  getLaunchErrorFinalization(
    childProcess?: ChildProcess | null,
  ): Promise<ActionableError | undefined> | undefined;
  throwLaunchError(error?: ActionableError): void;
  captureLaunchTargetDeviceId(childProcess: ChildProcess, output: string): void;
  recordReservedEmulatorDeviceId(
    childProcess: ChildProcess,
    reservation: EmulatorDeviceIdReservation,
  ): void;
  findNamedEmulator(
    avdName: string,
    childProcess: ChildProcess | null | undefined,
    runningEmulators: BootedDevice[],
  ): { emulator?: BootedDevice; failure?: string };
}

export class DefaultEmulatorLaunchTargets implements EmulatorLaunchTargets {
  readonly launchTargetDeviceIds = new WeakMap<ChildProcess, string>();
  readonly launchErrors = new WeakMap<ChildProcess, ActionableError>();
  readonly launchErrorFinalizations = new WeakMap<
    ChildProcess,
    Promise<ActionableError | undefined>
  >();

  /** Resolved per call because the reservations are built after the client's own fields. */
  constructor(
    private readonly reservations: () => Pick<
      EmulatorPortReservations,
      "recordReservedEmulatorDeviceId"
    >,
  ) {}

  getLaunchTargetDeviceId(childProcess?: ChildProcess | null): string | undefined {
    return childProcess ? this.launchTargetDeviceIds.get(childProcess) : undefined;
  }

  getLaunchError(childProcess?: ChildProcess | null): ActionableError | undefined {
    return childProcess ? this.launchErrors.get(childProcess) : undefined;
  }

  getLaunchErrorFinalization(
    childProcess?: ChildProcess | null,
  ): Promise<ActionableError | undefined> | undefined {
    return childProcess ? this.launchErrorFinalizations.get(childProcess) : undefined;
  }

  throwLaunchError(error?: ActionableError): void {
    if (error) {
      throw error;
    }
  }

  captureLaunchTargetDeviceId(childProcess: ChildProcess, output: string): void {
    if (this.launchTargetDeviceIds.has(childProcess)) {
      return;
    }
    const targetDeviceId = detectDeviceIdFromEmulatorOutput(output);
    if (targetDeviceId) {
      this.recordLaunchTargetDeviceId(childProcess, targetDeviceId, "process output");
    }
  }

  recordReservedEmulatorDeviceId(
    childProcess: ChildProcess,
    reservation: EmulatorDeviceIdReservation,
  ): void {
    this.reservations().recordReservedEmulatorDeviceId(childProcess, reservation);
    this.recordLaunchTargetDeviceId(childProcess, reservation.deviceId, "reserved console port");
  }

  findNamedEmulator(
    avdName: string,
    childProcess: ChildProcess | null | undefined,
    runningEmulators: BootedDevice[],
  ): { emulator?: BootedDevice; failure?: string } {
    const namedEmulator = runningEmulators.find((emulator) => emulator.name === avdName);
    logger.debug(
      `Exact name match for '${avdName}': ${namedEmulator ? `Found ${namedEmulator.deviceId}` : "Not found"}`,
    );
    if (namedEmulator) {
      this.recordLaunchTargetDeviceId(childProcess, namedEmulator.deviceId, "AVD name");
      return { emulator: namedEmulator };
    }
    return {};
  }

  private recordLaunchTargetDeviceId(
    childProcess: ChildProcess | null | undefined,
    targetDeviceId: string,
    source: string,
  ): void {
    if (!childProcess || this.launchTargetDeviceIds.has(childProcess)) {
      return;
    }
    this.launchTargetDeviceIds.set(childProcess, targetDeviceId);
    logger.debug(`Captured emulator launch target deviceId from ${source}: ${targetDeviceId}`);
  }
}
