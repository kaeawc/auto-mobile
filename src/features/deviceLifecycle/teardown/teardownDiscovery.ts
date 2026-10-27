import {
  type BootedDeviceDiscovery,
  type DeviceImageDiscovery,
} from "../../../devices/deviceUtils";
import { reconcileDiscoveryObservation } from "../../../daemon/discoveryReconcile";
import { type DevicePoolReads } from "../../../daemon/daemonContext";
import { SomePlatform } from "../../../models";
import { errorMessage } from "../../../utils/describeUnknownError";
import { logger } from "../../../utils/logger";
import { type TeardownContext, findMatchingBootedTeardownDevices } from "./teardownContracts";
import { runWithinShutdownDeadline } from "../core/deadlines";
import { getShutdownInitiatingExecutionId } from "./shutdownPreparation";

export async function readTeardownBootedDiscovery(
  context: TeardownContext,
  detail = "booted-device precondition discovery did not complete",
  discoveryMode: "context" | "name-aware" = "context",
): Promise<BootedDeviceDiscovery> {
  const skipAndroidNameEnrichment = discoveryMode === "context" && context.mode === "serial-only";
  return await runWithinShutdownDeadline(
    context.deadlineDevice,
    context.dependencies.timer,
    context.deadlineMs,
    detail,
    {
      requestAbortSignal: context.requestAbortSignal,
      operation: async () => {
        const discovery = await context.deviceManager.getBootedDevicesDetailed(
          context.args.target.platform,
          {
            bypassAndroidDeviceListCache: true,
            ...(skipAndroidNameEnrichment ? { skipAndroidNameEnrichment: true } : {}),
          },
        );
        // FUNNEL 1: teardown reads pooled entries (`findAbsentTeardownPooledDevices`)
        // against this observation (#6863 review).
        await reconcileDiscoveryObservation(discovery.devices, "teardown-precondition", {
          // Same exemption as the shutdown preflight: a `deleteDevice` cancelled
          // by its own observation returns `operation_cancelled` while its
          // accepted teardown carries on
          // ([#6888](https://github.com/kaeawc/auto-mobile/pull/6888) review).
          excludeExecutionId: getShutdownInitiatingExecutionId(),
          namesResolved: !skipAndroidNameEnrichment,
        });
        return discovery;
      },
      timeoutMs: context.timeoutMs,
    },
  );
}

/**
 * The booted scan target RESOLUTION reads, which for a forced teardown must not
 * be the name-aware one.
 *
 * Normal discovery enriches unclaimed emulators with `emu avd name`, within
 * a shared 2s scan budget. Foreign runtimes stay unnamed; named teardown resolves
 * those separately before deletion. Discovery happens BEFORE the forced branch in
 * `AndroidEmulatorClient.killDevice` can skip its own probe, so three wedged
 * consoles can consume the remaining forced-teardown deadline and `emu kill` is
 * never dispatched -- the flag times out in the exact state it exists for
 * ([#6874](https://github.com/kaeawc/auto-mobile/pull/6874) review). Forced, the
 * first scan therefore lists serials and asks nothing; the pool supplies the AVD
 * label for an emulator this daemon started, including a quarantined one.
 *
 * It is a FAST PATH, not a replacement. An emulator the pool never started has
 * no label to supply, and a serial-only scan can only answer the placeholder for
 * it, so when the cheap scan matches nothing the name-aware scan still runs on
 * the remaining deadline and resolution is unchanged. `force` must not become
 * the one call that cannot find a healthy, name-addressed AVD.
 */
export async function readTeardownTargetDiscovery(
  context: TeardownContext,
  devicePool: DevicePoolReads | undefined,
): Promise<BootedDeviceDiscovery> {
  if (context.mode !== "serial-only" || context.args.target.platform !== "android") {
    return await readTeardownBootedDiscovery(context);
  }
  const serialOnly = await readTeardownBootedDiscovery(context);
  return findMatchingBootedTeardownDevices(serialOnly, context.args, devicePool).length > 0
    ? serialOnly
    : await readTeardownBootedDiscovery(context, undefined, "name-aware");
}

export interface TeardownInventoryDiscovery extends DeviceImageDiscovery {
  androidSources?: {
    emulatorAvdNames: Set<string>;
    avdManagerAvdNames: Set<string>;
    incompleteSources: string[];
  };
}

export async function readTeardownInventory(
  context: TeardownContext,
  platform: SomePlatform,
  detail: string,
): Promise<TeardownInventoryDiscovery> {
  return await runWithinShutdownDeadline(
    context.deadlineDevice,
    context.dependencies.timer,
    context.deadlineMs,
    detail,
    {
      requestAbortSignal: context.requestAbortSignal,
      operation: async (signal) => {
        const platformInventory = await context.deviceManager.getDeviceImagesDetailed(platform, {
          bypassIosDeviceListCache: true,
          signal,
        });
        if (platform !== "android") {
          return platformInventory;
        }

        const avdManagerResult = await Promise.allSettled([
          context.dependencies.avdManagerFactory().listDeviceImages(signal),
        ]);
        const [avdManagerInventory] = avdManagerResult;
        if (avdManagerInventory.status === "rejected") {
          signal.throwIfAborted();
          const message = `avdmanager list avd failed: ${errorMessage(avdManagerInventory.reason)}`;
          logger.warn(`[DeviceTools] ${message}`, avdManagerInventory.reason);
          const succeededPlatforms = new Set(platformInventory.succeededPlatforms);
          succeededPlatforms.delete("android");
          const incompleteSources = platformInventory.succeededPlatforms.has("android")
            ? []
            : ["emulator -list-avds"];
          const existingAndroidError = platformInventory.discoveryErrors?.android;
          return {
            ...platformInventory,
            succeededPlatforms,
            discoveryErrors: {
              ...platformInventory.discoveryErrors,
              android: existingAndroidError
                ? {
                    ...existingAndroidError,
                    message: `${existingAndroidError.message} ${message}`,
                  }
                : { code: "failed", message },
            },
            androidSources: {
              emulatorAvdNames: new Set(
                platformInventory.devices
                  .filter((device) => device.platform === "android")
                  .map((device) => device.name),
              ),
              avdManagerAvdNames: new Set(),
              incompleteSources: [...incompleteSources, "avdmanager list avd"],
            },
          };
        }

        const emulatorAvdNames = new Set(
          platformInventory.devices
            .filter((device) => device.platform === "android")
            .map((device) => device.name),
        );
        const avdManagerAvdNames = new Set(avdManagerInventory.value.map((avd) => avd.name));
        const devices = [...platformInventory.devices];
        for (const avd of avdManagerInventory.value) {
          if (!emulatorAvdNames.has(avd.name)) {
            devices.push({ platform: "android", name: avd.name, isRunning: false });
          }
        }
        return {
          ...platformInventory,
          devices,
          androidSources: {
            emulatorAvdNames,
            avdManagerAvdNames,
            incompleteSources: platformInventory.succeededPlatforms.has("android")
              ? []
              : ["emulator -list-avds"],
          },
        };
      },
      timeoutMs: context.timeoutMs,
    },
  );
}
