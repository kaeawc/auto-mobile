import type { Timer } from "../utils/SystemTimer";
import type { DeviceBootServiceDependencies } from "./deviceBootSelection";
import type { DeviceBootExecution } from "./DeviceBootExecution";
import type { VirtualDeviceLifecycleCoordinator } from "./virtualDeviceLifecycleCoordinator";
import type { BootedDevice, DeviceInfo } from "../models";
import { ActionableError } from "../models";
import type { DeviceMatchCriteria } from "../models/DeviceMatchCriteria";
import { matchesDeviceCriteria } from "../utils/deviceMatcher";
import { logger } from "../utils/logger";
import { raceWithDeadline } from "../utils/raceWithDeadline";
import type { BootDeadlineContext } from "./deviceBootContext";
import {
  findBootedDeviceMatchingImage,
  findUniqueBootedAndroidDeviceByName,
  hasInFlightAndroidColdBoot,
  IOS_POST_LEASE_RECHECK_TIMEOUT_MS,
  isExcludedImage,
} from "./deviceBootSelection";
import type { StableVirtualDeviceIdentity } from "./virtualDeviceLifecycleCoordinator";
interface DeviceBootRevalidationContext {
  execution: DeviceBootExecution;
  dependencies: DeviceBootServiceDependencies;
  lifecycleCoordinator: VirtualDeviceLifecycleCoordinator;
  timer: Pick<Timer, "now" | "setTimeout" | "clearTimeout">;
}

export async function revalidateRunningIdentity(
  host: Pick<DeviceBootRevalidationContext, "execution">,
  device: BootedDevice,
  context: BootDeadlineContext,
): Promise<StableVirtualDeviceIdentity> {
  const devices = await host.execution.discoverBootedDevices(
    device.platform,
    context,
    "revalidating the running device after lifecycle wait",
    device.platform === "android",
  );
  const current = devices.find((candidate) => candidate.deviceId === device.deviceId);
  if (!current) {
    throw new ActionableError(
      "Selected running device disappeared during lifecycle wait; retry device selection",
    );
  }
  return {
    platform: current.platform,
    stableId: current.platform === "android" ? current.name : current.deviceId,
  };
}

export async function revalidateImageIdentity(
  host: Pick<DeviceBootRevalidationContext, "execution" | "dependencies">,
  image: DeviceInfo,
  context: BootDeadlineContext,
): Promise<StableVirtualDeviceIdentity> {
  const images = await host.execution.runPhase(
    context,
    "revalidating the device image after lifecycle wait",
    (signal) => host.dependencies.deviceManager.listDeviceImages(image.platform, signal),
  );
  const request = context.request;
  const criteria: DeviceMatchCriteria = {
    platform: request.platform,
    name: request.name,
    minOsVersion: request.matchNamedDeviceIgnoringOsVersion ? undefined : request.minOsVersion,
    maxOsVersion: request.matchNamedDeviceIgnoringOsVersion ? undefined : request.maxOsVersion,
    formFactor: request.formFactor,
    requires: request.requires,
    screenSize: request.screenSize,
  };
  const eligible = images.filter(
    (candidate) =>
      !isExcludedImage(candidate, request.excludeDeviceNames, request.excludeDeviceIds) &&
      matchesDeviceCriteria(candidate, criteria),
  );
  const current = request.deviceId
    ? eligible.find(
        (candidate) =>
          candidate.deviceId === request.deviceId || candidate.name === request.deviceId,
      )
    : request.matchExactName && request.name
      ? eligible.find((candidate) => candidate.name === request.name)
      : host.dependencies.deviceMatcher.matchDeviceImage(
          criteria,
          eligible,
          host.dependencies.matchingStrategy,
        );
  if (!current) {
    throw new ActionableError(
      "Selected device image disappeared during lifecycle wait; retry device selection",
    );
  }
  return {
    platform: current.platform,
    stableId: current.platform === "android" ? current.name : current.deviceId!,
  };
}

/**
 * The image's live device once its lifecycle lease settled, if another
 * acquisition (or an outside actor) booted it while this one was queued.
 * Android defers to a still-in-flight cold boot; iOS needs no marker because
 * a sibling boot of the same UDID holds the stable lease this call just won.
 */
export async function findRunningImageAfterLease(
  host: DeviceBootRevalidationContext,
  image: DeviceInfo,
  context: BootDeadlineContext,
  useBoundedIosRecheck = true,
): Promise<BootedDevice | undefined> {
  const phase = "re-checking the running device after the shared lifecycle lease settled";
  if (image.platform === "android") {
    const booted = await host.execution.discoverBootedDevices(
      image.platform,
      context,
      phase,
      true,
      true,
    );
    const running = findUniqueBootedAndroidDeviceByName(booted, image.name);
    return running && !hasInFlightAndroidColdBoot(host.lifecycleCoordinator, image.name)
      ? running
      : undefined;
  }
  // Bypass the simulator-list cache: the cached list is what made this image
  // look stopped, and `startDevice` itself bypasses it before refusing a boot.
  // The image is a simctl simulator, so devicectl discovery cannot answer for its UDID.
  const discoverSimulators = (signal: AbortSignal) =>
    host.dependencies.deviceManager.getBootedDevicesDetailed(image.platform, {
      bypassIosDeviceListCache: true,
      skipPhysicalIosDiscovery: true,
      signal,
    });
  // The boot path's own "already running" refusal means the list already
  // answered within the boot budget, so that follow-up read is not bounded.
  const discovery = await host.execution.runPhase(context, phase, (signal) =>
    useBoundedIosRecheck
      ? boundedIosRecheck(host, phase, signal, discoverSimulators)
      : discoverSimulators(signal),
  );
  // An unanswered inventory proves nothing; fall through to the boot path,
  // whose own running-state check reports an unreadable simulator list.
  return discovery?.succeededPlatforms.has("ios")
    ? findBootedDeviceMatchingImage(image, discovery.devices)
    : undefined;
}

/**
 * This optimization must never cost the boot its budget: a `simctl list` that
 * never answers is abandoned after its own short timeout (#9920) and the
 * caller falls through to the boot path, which reports the real state. Caller
 * abort and the boot deadline still win through `signal`.
 */
export async function boundedIosRecheck<T>(
  host: Pick<DeviceBootRevalidationContext, "timer">,
  phase: string,
  signal: AbortSignal,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T | undefined> {
  const recheck = new AbortController();
  const timedOut = new Error(`${phase} timed out`);
  try {
    return await raceWithDeadline(operation(AbortSignal.any([signal, recheck.signal])), {
      timer: host.timer,
      timeoutMs: IOS_POST_LEASE_RECHECK_TIMEOUT_MS,
      signal,
      label: phase,
      timeoutError: () => timedOut,
      onTimeout: () => recheck.abort(timedOut),
    });
  } catch (error) {
    if (error !== timedOut) {
      throw error;
    }
    logger.warn(
      `[startDevice] Simulator re-check did not answer within ${IOS_POST_LEASE_RECHECK_TIMEOUT_MS}ms; ` +
        "continuing to the boot path",
    );
    return undefined;
  }
}
