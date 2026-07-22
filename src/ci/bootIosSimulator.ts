import { DEVICE_POOL_MATCHING } from "../daemon/poolConfig";
import { ActionableError } from "../models";
import { DeviceBootService } from "../utils/deviceBootService";
import { DefaultDeviceMatcher } from "../utils/deviceMatcher";
import { DefaultDeviceProvisioner, createDefaultAndroidAvdCreator } from "../utils/deviceProvisioning";
import { MultiPlatformDeviceManager } from "../utils/deviceUtils";
import { SimCtlClient } from "../utils/ios-cmdline-tools/SimCtlClient";
import type { DeviceInfo } from "../models";
import { logger } from "../utils/logger";

const CI_SIMULATOR_NAME = "AutoMobile CI iPhone";

export interface CiIosBootOptions {
  iosVersion?: string;
  timeoutMs?: number;
  maxAttempts?: number;
}

/** Injectable CI-only boundary: product boot stays real while recovery is fast to test. */
export interface CiIosBootDependencies {
  isCi(): boolean;
  findOwnedSimulator(options: CiIosBootOptions): Promise<DeviceInfo | undefined>;
  createOwnedSimulator(options: CiIosBootOptions): Promise<DeviceInfo>;
  boot(target: DeviceInfo, timeoutMs?: number): Promise<{ deviceId: string; name: string }>;
  shutdown(target: DeviceInfo): Promise<void>;
  erase(target: DeviceInfo): Promise<void>;
}

/**
 * CI-only wrapper around the product boot service. It erases only the
 * deterministically named simulator it owns, immediately before the final
 * retry. Neither MCP nor the daemon-free product command expose this policy.
 */
export async function bootCiIosSimulator(
  options: CiIosBootOptions = {},
  dependencies: CiIosBootDependencies = createCiIosBootDependencies(),
): Promise<{ deviceId: string; name: string }> {
  if (!dependencies.isCi()) {
    throw new ActionableError("The iOS simulator erase-retry recovery is restricted to CI.");
  }
  const target = await dependencies.findOwnedSimulator(options) ?? await dependencies.createOwnedSimulator(options);
  if (!target.deviceId) {
    throw new ActionableError("CI iOS simulator is missing its UDID.");
  }
  const attempts = options.maxAttempts ?? 2;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await dependencies.boot(target, options.timeoutMs);
    } catch (error) {
      lastError = error;
      if (attempt === attempts) { break; }
      await recover(() => dependencies.shutdown(target));
      if (attempt === attempts - 1) {
        await recover(() => dependencies.erase(target));
      }
    }
  }
  throw new ActionableError(
    `CI iOS simulator failed after ${attempts} attempt(s): ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

async function recover(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    // Recovery is best-effort: preserve the original boot failure and still
    // give the final product boot attempt a chance to repair transient state.
    logger.debug(`[CI iOS boot] recovery command failed: ${error}`);
  }
}

function createCiIosBootDependencies(): CiIosBootDependencies {
  const simctl = new SimCtlClient();
  const manager = new MultiPlatformDeviceManager(null, simctl);
  const service = new DeviceBootService({
    deviceManager: manager,
    deviceMatcher: new DefaultDeviceMatcher(),
    deviceCreationGate: { isCreationAllowed: () => false, describeSource: () => "CI-owned simulator" },
    deviceProvisioner: { provision: async () => { throw new ActionableError("CI simulator was not provisioned."); } },
    matchingStrategy: DEVICE_POOL_MATCHING,
  });
  return {
    isCi: () => isGitHubActionsCi(process.env),
    findOwnedSimulator: async options => {
      const runtime = await simctl.resolveRuntimeIdentifier(options.iosVersion);
      const name = ciSimulatorName(runtime);
      return (await manager.listDeviceImages("ios")).find(
        image => image.name === name && image.runtime === runtime && image.isAvailable !== false,
      );
    },
    createOwnedSimulator: async options => {
      const runtime = await simctl.resolveRuntimeIdentifier(options.iosVersion);
      const provisioner = new DefaultDeviceProvisioner({
        iosCreator: () => simctl,
        androidCreator: createDefaultAndroidAvdCreator,
        createdDeviceName: () => ciSimulatorName(runtime),
      });
      const created = await provisioner.provision({ platform: "ios", minOsVersion: options.iosVersion, formFactor: "phone" });
      return { name: created.name, platform: "ios", deviceId: created.deviceId, isRunning: false };
    },
    boot: async (target, timeoutMs) => {
      const boot = await service.boot({ platform: "ios", deviceId: target.deviceId, timeoutMs });
      return { deviceId: boot.device.deviceId, name: boot.device.name };
    },
    shutdown: target => manager.killDevice({ name: target.name, platform: "ios", deviceId: target.deviceId! }),
    erase: target => simctl.eraseSimulator(target.deviceId!),
  };
}

export function isGitHubActionsCi(environment: NodeJS.ProcessEnv): boolean {
  return environment.CI === "true" && environment.GITHUB_ACTIONS === "true";
}

function ciSimulatorName(runtime: string): string {
  return `${CI_SIMULATOR_NAME} (${runtime})`;
}
