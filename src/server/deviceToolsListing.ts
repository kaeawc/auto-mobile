import {
  ActionableError,
  toActionableError,
  type BootedDevice,
  type Platform,
  type SomePlatform,
} from "../models";
import type { BootedDeviceDiscovery } from "../devices/deviceUtils";
import { type DiscoverySource, sourcesForPlatform } from "../utils/discoverySource";
import {
  createConfiguredInventoryContract,
  projectConfiguredDeviceInventory,
} from "../utils/configuredDeviceInventory";
import { describeDevice, projectConfiguredImage } from "./deviceDescription";
import { createStructuredToolResponse } from "../utils/toolUtils";
import { reconcileDiscoveryObservation } from "../daemon/discoveryReconcile";
import { logger } from "../utils/logger";
import { errorMessage } from "../utils/describeUnknownError";
import { describeDisplayRequirements, matchesDeviceCriteria } from "../utils/deviceMatcher";
import { hydrateRequiredDisplayInventories } from "../devices/DisplayInventoryProvider";
import {
  acceptancePresentationOrder,
  androidProvenanceByAvdName,
  availableDeviceResourceNote,
  configuredImagesForBootedDevices,
  detailedDiscoveryOptions,
  getDeviceToolsDependencies,
  initializedDevicePool,
  listDevicePayloads,
} from "./deviceTools";
import type { ListDeviceImagesArgs, ListDevicesArgs } from "./deviceTools";
import { AndroidTransportAliases } from "../utils/androidSerial";
import { describeBootCapacity } from "../features/bootAdmission/sharedBootAdmissionGates";

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
) {
  const failedPlatforms = requestedPlatforms.filter((p) => !succeededPlatforms.has(p));
  const failedSources = succeededSources
    ? requestedPlatforms
        .flatMap((p) => sourcesForPlatform(p))
        .filter((source) => !succeededSources!.has(source))
    : undefined;
  return {
    complete: failedSources ? failedSources.length === 0 : failedPlatforms.length === 0,
    failedPlatforms,
    ...(sourceErrors && Object.keys(sourceErrors).length > 0 ? { sourceErrors } : {}),
    ...(failedSources && failedSources.length > 0 ? { failedSources } : {}),
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

  const listDevicesHandler = async (args: ListDevicesArgs & Record<string, unknown>) => {
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
    const capacity = describeBootCapacity(requestedPlatforms);
    let booted: BootedDevice[] = [];
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
      succeededPlatforms = discovery.succeededPlatforms;
      succeededSources = discovery.succeededSources;
      discoveryErrors = discovery.discoveryErrors;
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
    const devices = listDevicePayloads(
      matchingBooted,
      pool,
      configured.images,
      (deviceId) => pool?.getAndroidTransportAliases(deviceId) ?? directAliases.aliases(deviceId),
      (deviceId) => pool?.getAndroidTransportAvdName(deviceId) ?? directAliases.avdName(deviceId),
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
