import { existsSync } from "node:fs";
import { extname, resolve } from "node:path";
import type { FileSystem } from "../filesystem/DefaultFileSystem";
import { logger } from "../logger";
import { raceWithDeadline } from "../raceWithDeadline";
import { trackAmbient } from "../PerfContext";
import type { createGlobalPerformanceTracker } from "../PerformanceTracker";
import type { Timer } from "../SystemTimer";
import type { HostChildProcess as ChildProcess } from "../HostCommandExecutor";
import { ActionableError, type BootedDevice } from "../../models";
import type { BootAdmission } from "../../models/BootAdmission";
import { EmulatorLaunchCancelledError } from "./EmulatorLaunchCancelledError";
import type {
  AndroidEmulatorLaunchHandle,
  AndroidEmulatorLaunchRequest,
} from "./AndroidEmulatorLaunchTypes";
import type { BootedDeviceScanOptions } from "./AndroidDeviceInventoryScanner";
import type { AndroidEmulatorLaunchOutcome, EmulatorLauncher } from "./EmulatorLauncher";
import type { EmulatorLaunchTargets } from "./EmulatorLaunchTargets";
import type {
  EmulatorDeviceIdReservation,
  EmulatorPortReservations,
} from "./EmulatorPortReservations";
import { isUnknownEmulatorName } from "./emulatorReadinessEvaluation";

/** Any failure of a launch the caller cancelled is reported as that cancellation, with the spawned child. */
function asLaunchCancellation(
  avdName: string,
  error: unknown,
  process: ChildProcess | null,
): EmulatorLaunchCancelledError {
  return error instanceof EmulatorLaunchCancelledError
    ? error
    : new EmulatorLaunchCancelledError(avdName, process);
}

function shouldCaptureEmulatorReservationSnapshot(deviceId: string | undefined): boolean {
  return deviceId === undefined || deviceId.startsWith("emulator-");
}

/** The reservation queries and release the launch coordinator consumes. */
export type CoordinatorReservations = Pick<
  EmulatorPortReservations,
  | "findReservedLaunchSerial"
  | "findLiveReservationAwaitingAdb"
  | "hasLiveUnreservedLaunch"
  | "releasePendingEmulatorDeviceId"
>;

/** Members resolved through the client at call time (the other extracted units' convention). */
export interface EmulatorLaunchCoordinatorHost {
  timer(): Timer;
  launcher(): EmulatorLauncher;
  reservations(): CoordinatorReservations;
  targets(): EmulatorLaunchTargets;
  posterFileSystem(): Pick<FileSystem, "existsSync"> | undefined;
  getBootedDevicesChecked(
    onlyEmulators: boolean,
    options: BootedDeviceScanOptions,
    signal?: AbortSignal,
  ): Promise<BootedDevice[]>;
  isAvdStarting(avdName: string): Promise<boolean>;
}

/** Owns one launch's lifecycle handle, cancellation, and the adopt-instead-of-spawn decision. */
export interface EmulatorLaunchCoordinator {
  launchEmulator(request: AndroidEmulatorLaunchRequest): Promise<AndroidEmulatorLaunchHandle>;
  adoptsExistingAvdLaunch(
    avdName: string,
    perf: ReturnType<typeof createGlobalPerformanceTracker>,
    signal?: AbortSignal,
  ): Promise<boolean>;
  assertCameraPosterColdBoot(posterPath?: string): void;
  throwIfLaunchCancelled(avdName: string, isCancelled?: () => boolean): void;
  releaseReservationIfLaunchCancelled(
    avdName: string,
    reservation: EmulatorDeviceIdReservation | undefined,
    isCancelled?: () => boolean,
  ): void;
}

export class DefaultEmulatorLaunchCoordinator implements EmulatorLaunchCoordinator {
  constructor(private readonly host: EmulatorLaunchCoordinatorHost) {}

  private resolveCameraPosterPath(posterPath?: string): string | undefined {
    const cameraPosterPath = posterPath === undefined ? undefined : resolve(posterPath);
    if (cameraPosterPath !== undefined) {
      if (![".png", ".jpg", ".jpeg"].includes(extname(cameraPosterPath).toLowerCase())) {
        throw new ActionableError("cameraPosterPath must point to a PNG, JPG, or JPEG image.");
      }
      if (!(this.host.posterFileSystem() ?? { existsSync }).existsSync(cameraPosterPath)) {
        throw new ActionableError(`Camera poster image does not exist: ${cameraPosterPath}`);
      }
    }
    return cameraPosterPath;
  }

  assertCameraPosterColdBoot(posterPath?: string): void {
    if (posterPath !== undefined) {
      throw new ActionableError(
        "cameraPosterPath is unsupported on a running or starting AVD. Stop it first.",
      );
    }
  }

  async launchEmulator(
    request: AndroidEmulatorLaunchRequest,
  ): Promise<AndroidEmulatorLaunchHandle> {
    if (request.signal?.aborted) {
      throw new EmulatorLaunchCancelledError(request.avdName, null);
    }

    const cameraPosterPath = this.resolveCameraPosterPath(request.cameraPosterPath);
    let process: ChildProcess | null = null;
    let outcome: AndroidEmulatorLaunchOutcome = "launched";
    let disposed = false;
    let admission: BootAdmission | undefined;
    const dispose = () => {
      if (disposed) {
        return;
      }
      disposed = true;
      if (process && !process.killed) {
        process.kill();
      }
    };
    request.signal?.addEventListener("abort", dispose, { once: true });

    try {
      // Ambient leaf for the emulator startup command (spawn + startup
      // validation). It ends when `startEmulatorProcess` resolves — never the
      // resident emulator's whole lifetime — mirroring the iOS `simctl boot`
      // leaf (see PerfContext).
      // Raced against the request's abort so a cancel does not outwait the
      // startup validation: without an early serial/stdout signal it can still
      // take the 5 s fallback against an emulator that ignores SIGTERM. The owner
      // needs the child handle inside its abort grace to confirm the exit (#10075).
      const launch = await raceWithDeadline(
        () =>
          trackAmbient(`emulator launch ${request.avdName}`, () =>
            this.host.launcher().startEmulatorProcess(request.avdName, {
              requestedExtraArgs: request.extraArgs,
              cameraPosterPath,
              onSpawn: (spawnedProcess) => {
                process = spawnedProcess;
                if (disposed && !spawnedProcess.killed) {
                  spawnedProcess.kill();
                }
              },
              isCancelled: () => disposed,
              capturePreLaunchDeviceIds: shouldCaptureEmulatorReservationSnapshot(request.deviceId),
              expectedDeviceId: request.deviceId,
              signal: request.signal,
              admitColdBoot: request.admitColdBoot,
              onAdmitted: (admitted) => {
                admission = admitted;
              },
            }),
          ),
        { timer: this.host.timer(), signal: request.signal, label: "Android emulator launch" },
      );
      process = launch.process;
      outcome = launch.outcome;
      if (!process) {
        // A sibling can win the AVD lock after the pre-spawn check. Never adopt its camera state.
        this.assertCameraPosterColdBoot(cameraPosterPath);
      }
      if (disposed) {
        // `dispose` already sent the SIGTERM to this child.
        throw new EmulatorLaunchCancelledError(request.avdName, process);
      }
    } catch (error) {
      request.signal?.removeEventListener("abort", dispose);
      // A failed or cancelled launch frees its capacity slot; the owner confirms the child's exit.
      admission?.release();
      // Hand the spawned child to the owner: one SIGTERM is only a request, and
      // the owner must confirm the exit before freeing the AVD (#10075).
      throw disposed ? asLaunchCancellation(request.avdName, error, process) : error;
    }
    const targets = this.host.targets();
    if (process && request.deviceId) {
      targets.launchTargetDeviceIds.set(process, request.deviceId);
    }

    const release = () => {
      if (!disposed) {
        disposed = true;
      }
      request.signal?.removeEventListener("abort", dispose);
    };

    return {
      avdName: request.avdName,
      process,
      outcome,
      get targetDeviceId() {
        return process ? targets.launchTargetDeviceIds.get(process) : request.deviceId;
      },
      dispose: () => {
        dispose();
        release();
      },
      release,
    };
  }

  /**
   * Whether this AVD is already up or coming up, so the launch must adopt it
   * instead of spawning a second emulator for it.
   *
   * `getBootedDevicesChecked` rather than the swallow-to-[] wrapper: an adb
   * discovery failure must surface as an error, never be read as "this AVD is
   * not running" (#6407).
   */
  async adoptsExistingAvdLaunch(
    avdName: string,
    perf: ReturnType<typeof createGlobalPerformanceTracker>,
    signal?: AbortSignal,
  ): Promise<boolean> {
    perf.startOperation("checkAlreadyRunning");
    try {
      const runningEmulators = await this.host.getBootedDevicesChecked(
        false,
        { bypassDeviceListCache: true },
        signal,
      );
      if (runningEmulators.some((emulator) => emulator.name === avdName)) {
        logger.info(`AVD '${avdName}' is already running - waiting for it to be ready`);
        return true;
      }
      const reservations = this.host.reservations();
      // Mid-boot the scan can only label the emulator `Unknown (<serial>)`, so
      // the console-port reservation, not the name, is the evidence (#6407).
      const launchingDeviceId = reservations.findReservedLaunchSerial(
        avdName,
        runningEmulators,
        isUnknownEmulatorName,
      );
      if (launchingDeviceId) {
        logger.info(
          `AVD '${avdName}' is already starting on ${launchingDeviceId} (this process reserved that console port) - waiting for it to be ready`,
        );
        return true;
      }
      const preAdbLaunchSerial = reservations.findLiveReservationAwaitingAdb(
        avdName,
        runningEmulators,
      );
      if (preAdbLaunchSerial) {
        logger.info(
          `AVD '${avdName}' is already starting on ${preAdbLaunchSerial} (this process holds a live reservation adb has not listed yet) - waiting for it to be ready`,
        );
        return true;
      }
      if (reservations.hasLiveUnreservedLaunch(avdName)) {
        logger.info(
          `AVD '${avdName}' is already starting (this process holds a live launch for it that adb has not named yet) - waiting for it to be ready`,
        );
        return true;
      }
      if (await this.host.isAvdStarting(avdName)) {
        logger.info(`AVD '${avdName}' is already starting - waiting for it to be ready`);
        return true;
      }
      return false;
    } finally {
      perf.endOperation("checkAlreadyRunning");
    }
  }

  throwIfLaunchCancelled(avdName: string, isCancelled?: () => boolean): void {
    if (isCancelled?.()) {
      throw new EmulatorLaunchCancelledError(avdName, null);
    }
  }

  releaseReservationIfLaunchCancelled(
    avdName: string,
    reservation: EmulatorDeviceIdReservation | undefined,
    isCancelled?: () => boolean,
  ): void {
    if (!isCancelled?.()) {
      return;
    }
    if (reservation) {
      this.host.reservations().releasePendingEmulatorDeviceId(reservation);
    }
    this.throwIfLaunchCancelled(avdName, isCancelled);
  }
}
