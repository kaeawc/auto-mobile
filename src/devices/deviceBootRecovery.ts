import { ActionableError, type DeviceInfo } from "../models";
import { BootCapacityExhaustedError } from "../models/BootCapacityExhaustedError";
import type { DeviceBootRequest } from "./deviceBootService";
import {
  DefaultDeviceProvisioner,
  createDefaultAndroidAvdCreator,
  resolveIosProvisioningSelection,
} from "./deviceProvisioning";
import type { DeviceProvisioner, IosSimulatorCreator } from "./deviceProvisioning";
import { MultiPlatformDeviceManager } from "./deviceUtils";
import type { DeviceManagerSimCtl, PlatformDeviceManager } from "./deviceUtils";
import {
  SimulatorStillShuttingDownError,
  SimCtlClient,
  type SimCtl,
} from "../utils/ios-cmdline-tools/SimCtlClient";
import { iosVersionStringFromRuntimeId } from "../utils/ios-cmdline-tools/iosVersion";
import { logger } from "../utils/logger";
import { defaultTimer } from "../utils/SystemTimer";
import { raceWithDeadline } from "../utils/raceWithDeadline";
import { AMBIENT_ENV, readEnvRaw } from "../config/env";
export { NoopDeviceBootRecovery } from "./NoopDeviceBootRecovery";

const CI_SIMULATOR_NAME = "AutoMobile CI iPhone";

/** Recovery policy for a cold device boot. Product callers default to no recovery. */
export interface DeviceBootRecovery {
  run<T>(target: DeviceInfo, boot: () => Promise<T>, signal?: AbortSignal): Promise<T>;
}

export interface CiIosBootRecoveryDependencies {
  ownedSimulatorName: string;
  shutdown(target: DeviceInfo): Promise<void>;
  erase(udid: string): Promise<void>;
}

/**
 * GitHub Actions-only recovery for the deterministic simulator AutoMobile owns.
 * It is deliberately not a general iOS recovery policy: arbitrary simulators
 * must never be erased by product boot.
 */
export class CiIosBootRecovery implements DeviceBootRecovery {
  constructor(private readonly dependencies: CiIosBootRecoveryDependencies) {}

  async run<T>(target: DeviceInfo, boot: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!this.isOwnedTarget(target)) {
      return boot();
    }
    let firstFailure: unknown;
    try {
      return await boot();
    } catch (error) {
      // Capacity exhaustion is not a broken simulator: erasing it would not free a slot.
      if (signal?.aborted || error instanceof BootCapacityExhaustedError) {
        throw error;
      }
      firstFailure = error;
    }
    this.throwIfCancelled(signal);
    try {
      await this.recover(signal, () => this.dependencies.shutdown(target), true);
    } catch (error) {
      if (error instanceof SimulatorStillShuttingDownError) {
        logger.warn(
          "[CI iOS boot] simulator shutdown remains pending; skipping erase and boot retry",
          error,
        );
        throw firstFailure;
      }
      throw error;
    }
    this.throwIfCancelled(signal);
    await this.recover(signal, () => this.dependencies.erase(target.deviceId!));
    this.throwIfCancelled(signal);
    try {
      return await boot();
    } catch {
      this.throwIfCancelled(signal);
      throw firstFailure;
    }
  }

  private isOwnedTarget(target: DeviceInfo): boolean {
    return (
      target.platform === "ios" &&
      target.name === this.dependencies.ownedSimulatorName &&
      Boolean(target.deviceId)
    );
  }

  private throwIfCancelled(signal: AbortSignal | undefined): void {
    if (signal?.aborted) {
      throw new ActionableError("startDevice cancelled while recovering the CI iOS simulator");
    }
  }

  private async recover(
    signal: AbortSignal | undefined,
    action: () => Promise<void>,
    guardPendingShutdown = false,
  ): Promise<void> {
    const actionPromise = Promise.resolve()
      .then(action)
      .catch((error) => {
        if (guardPendingShutdown && error instanceof SimulatorStillShuttingDownError) {
          throw error;
        }
        // Recovery is best-effort; an unavailable simulator can still be retried.
        logger.debug(`[CI iOS boot] recovery command failed: ${error}`);
      });
    if (!signal) {
      await actionPromise;
      return;
    }
    this.throwIfCancelled(signal);
    try {
      await raceWithDeadline(actionPromise, {
        timer: defaultTimer,
        signal,
        label: "CI iOS simulator recovery",
      });
    } catch (error) {
      if (signal.aborted) {
        throw new ActionableError("startDevice cancelled while recovering the CI iOS simulator");
      }
      throw error;
    }
  }
}

export interface CiIosBootConfiguration {
  request: DeviceBootRequest;
  deviceManager: PlatformDeviceManager;
  deviceProvisioner: DeviceProvisioner;
  recovery: DeviceBootRecovery;
}

/** Exactly the simctl calls CI boot makes: provisioning, the device manager, and the erase step. */
export type CiIosBootSimctl = DeviceManagerSimCtl &
  IosSimulatorCreator &
  Pick<SimCtl, "eraseSimulator">;

export interface CiIosBootConfigurationDependencies {
  simctl: CiIosBootSimctl;
}

/** True only in the CI environment where AutoMobile owns the simulator lifecycle. */
export function isGitHubActionsCi(environment: NodeJS.ProcessEnv): boolean {
  return (
    readEnvRaw(AMBIENT_ENV.CI, environment) === "true" &&
    readEnvRaw(AMBIENT_ENV.GITHUB_ACTIONS, environment) === "true"
  );
}

/** CI recovery owns only the un-targeted product boot used by the workflow. */
export function shouldUseCiIosBootRecovery(
  request: DeviceBootRequest,
  environment: NodeJS.ProcessEnv,
): boolean {
  return (
    request.platform === "ios" &&
    !request.name &&
    !request.deviceId &&
    isGitHubActionsCi(environment)
  );
}

/** Match the runtime-qualified CI-owned name across fallback without changing provisioning bounds. */
export function normalizeCiIosBootRequest(
  request: DeviceBootRequest,
  ownedSimulatorName: string,
): DeviceBootRequest {
  return { ...request, name: ownedSimulatorName, matchNamedDeviceIgnoringOsVersion: true };
}

/**
 * Give daemon-free product boot a deterministic, CI-owned iOS simulator and
 * its erase-on-final-retry policy. All other callers retain the no-op default.
 */
export async function createCiIosBootConfiguration(
  request: DeviceBootRequest,
  environment: NodeJS.ProcessEnv = process.env,
  dependencies?: CiIosBootConfigurationDependencies,
): Promise<CiIosBootConfiguration | undefined> {
  if (!shouldUseCiIosBootRecovery(request, environment)) {
    return undefined;
  }
  const simctl = dependencies?.simctl ?? new SimCtlClient();
  const { runtime } = await resolveIosProvisioningSelection(simctl, request);
  const runtimeLabel = iosVersionStringFromRuntimeId(runtime) ?? runtime;
  const ownedSimulatorName = `${CI_SIMULATOR_NAME} (${runtimeLabel})`;
  const deviceManager = new MultiPlatformDeviceManager(null, simctl);
  return {
    request: normalizeCiIosBootRequest(request, ownedSimulatorName),
    deviceManager,
    deviceProvisioner: new DefaultDeviceProvisioner({
      iosCreator: () => simctl,
      androidCreator: createDefaultAndroidAvdCreator,
      createdDeviceName: () => ownedSimulatorName,
    }),
    recovery: new CiIosBootRecovery({
      ownedSimulatorName,
      shutdown: async (target) => {
        await deviceManager.killDevice({
          name: target.name,
          platform: "ios",
          deviceId: target.deviceId!,
        });
      },
      erase: (udid) => simctl.eraseSimulator(udid),
    }),
  };
}
