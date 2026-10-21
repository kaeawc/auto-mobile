import {
  ActionableError,
  toActionableError,
  type BootedDevice,
  type Platform,
  type SomePlatform,
} from "../models";
import type { BootedDeviceDiscovery, DeviceDiscoveryError } from "../devices/deviceUtils";
import {
  type DiscoverySource,
  expectingPooledSources,
  incompleteDiscoverySources,
  notApplicableDiscoverySources,
  sourcesForPlatform,
} from "../utils/discoverySource";
import {
  createConfiguredInventoryContract,
  projectConfiguredDeviceInventory,
} from "../utils/configuredDeviceInventory";
import { describeDevice, projectConfiguredImage } from "../daemon/deviceDescription";
import { createStructuredToolResponse } from "../utils/toolUtils";
import { reconcileDiscoveryObservation } from "../daemon/discoveryReconcile";
import { logger } from "../utils/logger";
import type { ProgressCallback } from "./toolRegistry";
import { ResourceRegistry } from "./resourceRegistry";
import {
  BOOTED_DEVICE_RESOURCE_URIS,
  DEVICE_IMAGE_RESOURCE_URIS,
} from "../constants/deviceResourceUris";
import { errorMessage } from "../utils/describeUnknownError";
import { describeDisplayRequirements, matchesDeviceCriteria } from "../utils/deviceMatcher";
import { hydrateRequiredDisplayInventories } from "../devices/DisplayInventoryProvider";
import { AndroidTransportAliases } from "../utils/androidSerial";
import { adbOfflineHeldDevices, transitionalHeldSimulators } from "../daemon/adbOfflineHeldDevices";
import type { TransitionalHold } from "../daemon/inventoryDeviceDescription";
import { describeBootCapacity } from "../features/bootAdmission/sharedBootAdmissionGates";
import {
  ListDeviceImagesArgs,
  ListDevicesArgs,
  acceptancePresentationOrder,
  androidProvenanceByAvdName,
  configuredImagesForBootedDevices,
  detailedDiscoveryOptions,
  getDeviceToolsDependencies,
  initializedDevicePool,
  listDevicePayloads,
} from "../features/deviceLifecycle/deviceLifecycleCore";

/** Held Android devices adb lists offline and held simulators simctl lists Booting / Shutting Down. */
async function transitionalHeldListing(input: {
  platform: SomePlatform;
  discovered: BootedDevice[];
  discovery: BootedDeviceDiscovery;
  pool: ReturnType<typeof initializedDevicePool>;
  deviceManager: ReturnType<ReturnType<typeof getDeviceToolsDependencies>["deviceManagerFactory"]>;
  signal: AbortSignal | undefined;
}): Promise<{
  devices: BootedDevice[];
  holds: Map<string, TransitionalHold>;
  /** Set when a held Android device's state could not be probed: that platform is incomplete. */
  probeFailure: DeviceDiscoveryError | undefined;
}> {
  const { discovered, discovery, pool, deviceManager } = input;
  let probeFailure: DeviceDiscoveryError | undefined;
  const devices: BootedDevice[] = [];
  const holds = new Map<string, TransitionalHold>();
  for (const offlineHeld of await adbOfflineHeldDevices({
    platform: input.platform === "ios" ? "ios" : "android",
    discovered,
    devicePool: pool,
    deviceManager,
    signal: input.signal,
    onProbeFailure: (failure) => {
      probeFailure = failure;
    },
  })) {
    holds.set(offlineHeld.device.deviceId, {
      adbState: offlineHeld.adbState,
      avdName: offlineHeld.avdName,
    });
    devices.push(offlineHeld.device);
  }
  for (const held of transitionalHeldSimulators({
    transitional: discovery.transitionalSimulators,
    discovered,
    devicePool: pool,
  })) {
    holds.set(held.device.deviceId, { simulatorState: held.simulatorState });
    devices.push(held.device);
  }
  return { devices, holds, probeFailure };
}

/**
 * The discovery completeness this listing reports. A failed held-device state probe means the
 * held Android device may still be attached: that platform is unknown, not empty.
 */
function withHeldProbeFailure(
  discovery: BootedDeviceDiscovery,
  probeFailure: DeviceDiscoveryError | undefined,
) {
  const succeededPlatforms = new Set(discovery.succeededPlatforms);
  const succeededSources = discovery.succeededSources && new Set(discovery.succeededSources);
  if (!probeFailure) {
    return { succeededPlatforms, succeededSources, discoveryErrors: discovery.discoveryErrors };
  }
  succeededPlatforms.delete("android");
  succeededSources?.delete("android");
  return {
    succeededPlatforms,
    succeededSources,
    discoveryErrors: { ...discovery.discoveryErrors, android: probeFailure },
  };
}

function selectBootedDevices(
  booted: BootedDevice[],
  args: ListDevicesArgs,
  discoveryComplete: boolean,
): BootedDevice[] {
  if (args.requires?.panels === undefined && args.requires?.posture === undefined) {
    return booted;
  }
  const matching = booted.filter((device) =>
    matchesDeviceCriteria(device, { platform: device.platform, requires: args.requires }),
  );
  if (matching.length === 0 && discoveryComplete) {
    throw new ActionableError(
      describeDisplayRequirements(
        { platform: args.platform ?? "android", requires: args.requires },
        booted.map((device) => ({ ...device, booted: true })),
      ),
    );
  }
  return matching;
}

function listingDiscoveryObservation(
  requestedPlatforms: Platform[],
  succeededPlatforms: Set<Platform>,
  succeededSources: Set<DiscoverySource> | undefined,
  discoveryErrors: BootedDeviceDiscovery["discoveryErrors"],
  sourceErrors: BootedDeviceDiscovery["sourceErrors"],
  pool: { getAllDevices(): Iterable<{ platform: Platform; id: string }> } | null | undefined,
) {
  // One classifier for every inventory surface (#11605): a source whose tooling is not installed
  // on this host is not a failure, so it is neither a failed source nor a failed platform.
  const evidence = expectingPooledSources(
    { succeededPlatforms, succeededSources, discoveryErrors, sourceErrors },
    pool?.getAllDevices(),
  );
  const incompleteSources = incompleteDiscoverySources(evidence, requestedPlatforms);
  const notApplicableSources = notApplicableDiscoverySources(evidence, requestedPlatforms);
  const failedPlatforms = requestedPlatforms.filter(
    (p) =>
      !succeededPlatforms.has(p) &&
      sourcesForPlatform(p).some((source) => incompleteSources.includes(source)),
  );
  const failedSources = succeededSources ? incompleteSources : undefined;
  return {
    complete: incompleteSources.length === 0,
    failedPlatforms,
    ...(sourceErrors && Object.keys(sourceErrors).length > 0 ? { sourceErrors } : {}),
    ...(failedSources && failedSources.length > 0 ? { failedSources } : {}),
    ...(notApplicableSources.length > 0 ? { notApplicableSources } : {}),
    ...(discoveryErrors && Object.keys(discoveryErrors).length > 0
      ? { errors: discoveryErrors }
      : {}),
  };
}

export function createListingHandlers() {
  // List AVDs handler
  const listDeviceImagesHandler = async (args: ListDeviceImagesArgs) => {
    try {
      const deps = getDeviceToolsDependencies();
      const deviceUtils = deps.deviceManagerFactory();
      const discovery = await deviceUtils.getDeviceImagesDetailed(args.platform, {
        bypassIosDeviceListCache: args.platform === "ios",
        ...(args.platform === "android" ? { coalesceInventoryEnrichment: true } : {}),
      });
      const projection = projectConfiguredDeviceInventory(args.platform, discovery);
      const configuredInventory = createConfiguredInventoryContract([args.platform], {
        [args.platform]: projection.observation,
      });
      const androidProvenance =
        args.platform === "android"
          ? await androidProvenanceByAvdName(deps.avdManagerFactory(), deps.timer)
          : undefined;
      const images = projection.sourceImages.map((image) => {
        const description = describeDevice({
          kind: "image",
          image,
          androidProvenance: androidProvenance?.get(image.name),
        });
        return projectConfiguredImage(description);
      });

      return createStructuredToolResponse({
        message: `Found ${images.length} configured ${args.platform} device images`,
        images,
        count: images.length,
        platform: args.platform,
        configuredInventory,
      });
    } catch (error) {
      throw toActionableError(error, `Failed to list ${args.platform} AVDs`);
    }
  };

  const listDevicesHandler = async (
    args: ListDevicesArgs & Record<string, unknown>,
    _progress?: ProgressCallback,
    signal?: AbortSignal,
  ) => {
    // #5870: a tool named `listDevices` returns the devices. The data is right
    // here — enumerate booted devices directly instead of forcing a modality
    // switch to resources. The resource pointers (which also cover not-yet-booted
    // images and richer per-device detail) survive as a `note`.
    const platform: SomePlatform = args.platform ?? "either";
    const presentationOrder = acceptancePresentationOrder(args);
    const requestedPlatforms: Platform[] = platform === "either" ? ["android", "ios"] : [platform];
    const deps = getDeviceToolsDependencies();
    const deviceManager = deps.deviceManagerFactory();
    const pool = initializedDevicePool();
    const directAliases = new AndroidTransportAliases(deps.androidAdbFactory);
    // Sampled alongside discovery; best-effort and absent when no platform is gated (#11181).
    const capacity = describeBootCapacity(requestedPlatforms, deps.bootCapacityReporters);
    let booted: BootedDevice[] = [];
    const transitionalHolds = new Map<string, TransitionalHold>();
    // #5893 item 4: `getBootedDevices` collapses a failed per-platform probe to
    // `[]`, so a transient tooling failure is indistinguishable from a genuinely
    // empty inventory. Use the detailed contract, which reports which platforms
    // completed, and surface an incomplete/error marker so the two are distinct.
    let succeededPlatforms = new Set<Platform>(requestedPlatforms);
    // #5918: iOS is discovered by two independent sources (simctl + devicectl).
    // `succeededPlatforms.ios` tracks only the simulator source, so a devicectl
    // failure leaves the platform "succeeded" while physical-iOS discovery is
    // actually incomplete. Derive completeness from the finer per-source set,
    // falling back to the platform aggregate for producers that predate #5683
    // (which return no `succeededSources`).
    let succeededSources: Set<DiscoverySource> | undefined;
    let sourceErrors: BootedDeviceDiscovery["sourceErrors"];
    let discoveryErrors: BootedDeviceDiscovery["discoveryErrors"];
    try {
      const discovery = await deviceManager.getBootedDevicesDetailed(platform, {
        ...detailedDiscoveryOptions(presentationOrder),
        coalesceInventoryEnrichment: true,
      });
      // FUNNEL 1: listDevices publishes each entry's pool-derived label/epoch
      // through the same join the booted-devices resource uses (#6863 review).
      booted =
        platform === "ios"
          ? discovery.devices
          : pool
            ? pool.mapAndroidDiscovery(discovery.devices)
            : directAliases.fold(
                discovery.devices,
                await directAliases.prepare(discovery.devices),
                new Set(),
              );
      await reconcileDiscoveryObservation(booted, "listDevices");
      // Held devices their platform lists in a transitional state are absent from booted
      // discovery; list them like the booted-devices resource does (#11118, #11455, #11573).
      const transitional = await transitionalHeldListing({
        platform,
        discovered: booted,
        discovery,
        pool,
        deviceManager,
        signal,
      });
      booted = [...booted, ...transitional.devices];
      for (const [deviceId, hold] of transitional.holds) {
        transitionalHolds.set(deviceId, hold);
      }
      ({ succeededPlatforms, succeededSources, discoveryErrors } = withHeldProbeFailure(
        discovery,
        transitional.probeFailure,
      ));
      sourceErrors = discovery.sourceErrors;
    } catch (error) {
      // Discovery is best-effort — a partial/failed probe still returns the
      // resource guidance rather than failing the whole call. A thrown error
      // means no platform (and thus no source) completed.
      logger.warn(`listDevices booted-device discovery failed: ${errorMessage(error)}`, error);
      succeededPlatforms = new Set<Platform>();
      succeededSources = new Set<DiscoverySource>();
    }

    const discovery = listingDiscoveryObservation(
      requestedPlatforms,
      succeededPlatforms,
      succeededSources,
      discoveryErrors,
      sourceErrors,
      pool,
    );

    const resolvedBooted = await hydrateRequiredDisplayInventories(
      booted,
      args.requires,
      deps.displayInventory,
    );
    const matchingBooted = selectBootedDevices(resolvedBooted, args, discovery.complete);
    const configured = await configuredImagesForBootedDevices(
      deviceManager,
      deps.avdManagerFactory(),
      matchingBooted,
      deps.timer,
    );
    // Refresh the broker binding snapshot so held devices are not reported as free.
    await pool?.refreshInventoryOwnership();
    const devices = listDevicePayloads(
      matchingBooted,
      pool,
      configured.images,
      (deviceId) => pool?.getAndroidTransportAliases(deviceId) ?? directAliases.aliases(deviceId),
      (deviceId) => pool?.getAndroidTransportAvdName(deviceId) ?? directAliases.avdName(deviceId),
      transitionalHolds,
    );
    const platformFilter = args.platform ? ` (${args.platform} only)` : "";

    return createStructuredToolResponse({
      message: `Found ${devices.length} booted device${devices.length === 1 ? "" : "s"}${platformFilter}`,
      devices,
      count: devices.length,
      discovery,
      ...(configured.enrichment ? { enrichment: configured.enrichment } : {}),
      ...(await capacity.then((report) => (report ? { capacity: report } : {}))),
      note: availableDeviceResourceNote(),
    });
  };

  return { listDeviceImagesHandler, listDevicesHandler };
}

export function availableDeviceResourceNote() {
  const listedResourceUris = new Set(
    ResourceRegistry.getResourceDefinitions().map((resource) => resource.uri),
  );
  const resourceUris = [
    BOOTED_DEVICE_RESOURCE_URIS.ALL_BOOTED,
    `${BOOTED_DEVICE_RESOURCE_URIS.ALL_BOOTED}/android`,
    `${BOOTED_DEVICE_RESOURCE_URIS.ALL_BOOTED}/ios`,
    DEVICE_IMAGE_RESOURCE_URIS.ALL_IMAGES,
    `${DEVICE_IMAGE_RESOURCE_URIS.ALL_IMAGES}/android`,
    `${DEVICE_IMAGE_RESOURCE_URIS.ALL_IMAGES}/ios`,
  ];
  const availableResourceUris = resourceUris.filter((uri) => listedResourceUris.has(uri));
  return {
    message:
      "Acquire a booted device with getAndroid { deviceId } or getApple { deviceId }. " +
      (availableResourceUris.length > 0
        ? "For available images and richer per-device detail, read these MCP resources:"
        : "Refresh resources/list to discover available images and richer per-device detail."),
    resources: availableResourceUris,
    uriPrefix:
      "All resource URIs use the 'automobile:' prefix. URIs like 'android://devices' are not supported.",
  };
}
