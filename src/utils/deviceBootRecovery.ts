import { ActionableError, type DeviceInfo } from "../models";
import type { DeviceBootRequest } from "./deviceBootService";
import { DefaultDeviceProvisioner, createDefaultAndroidAvdCreator } from "./deviceProvisioning";
import type { DeviceProvisioner } from "./deviceProvisioning";
import { MultiPlatformDeviceManager } from "./deviceUtils";
import type { PlatformDeviceManager } from "./deviceUtils";
import { SimCtlClient } from "./ios-cmdline-tools/SimCtlClient";
import { logger } from "./logger";

const CI_SIMULATOR_NAME = "AutoMobile CI iPhone";

/** Recovery policy for a cold device boot. Product callers default to no recovery. */
export interface DeviceBootRecovery {
  run<T>(target: DeviceInfo, boot: () => Promise<T>, signal?: AbortSignal): Promise<T>;
}

/** The default product policy: surface the first boot failure unchanged. */
export class NoopDeviceBootRecovery implements DeviceBootRecovery {
  run<T>(_target: DeviceInfo, boot: () => Promise<T>, _signal?: AbortSignal): Promise<T> {
    return boot();
  }
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
      if (signal?.aborted) {
        throw error;
      }
      firstFailure = error;
    }
    this.throwIfCancelled(signal);
    await this.recover(signal, () => this.dependencies.shutdown(target));
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
  ): Promise<void> {
    const actionPromise = Promise.resolve()
      .then(action)
      .catch((error) => {
        // Recovery is best-effort; an unavailable simulator can still be retried.
        logger.debug(`[CI iOS boot] recovery command failed: ${error}`);
      });
    if (!signal) {
      await actionPromise;
      return;
    }
    this.throwIfCancelled(signal);
    let rejectCancellation!: (error: ActionableError) => void;
    const cancellation = new Promise<never>((_resolve, reject) => {
      rejectCancellation = reject;
    });
    const cancel = () => {
      rejectCancellation(
        new ActionableError("startDevice cancelled while recovering the CI iOS simulator"),
      );
    };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      await Promise.race([actionPromise, cancellation]);
    } finally {
      signal.removeEventListener("abort", cancel);
    }
  }
}

export interface CiIosBootConfiguration {
  request: DeviceBootRequest;
  deviceManager: PlatformDeviceManager;
  deviceProvisioner: DeviceProvisioner;
  recovery: DeviceBootRecovery;
}

/** True only in the CI environment where AutoMobile owns the simulator lifecycle. */
export function isGitHubActionsCi(environment: NodeJS.ProcessEnv): boolean {
  return environment.CI === "true" && environment.GITHUB_ACTIONS === "true";
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
): Promise<CiIosBootConfiguration | undefined> {
  if (!shouldUseCiIosBootRecovery(request, environment)) {
    return undefined;
  }
  const simctl = new SimCtlClient();
  const runtime = await simctl.resolveRuntimeIdentifier(request.minOsVersion);
  const ownedSimulatorName = `${CI_SIMULATOR_NAME} (${runtime})`;
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
