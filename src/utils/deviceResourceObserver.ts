import type { BootedDevice } from "../models/DeviceInfo";
import type { AndroidDeviceResource } from "../models/AndroidDeviceResource";
import type { AppleDeviceResource } from "../models/AppleDeviceResource";
import type { DeviceResourceMap, DeviceResourceStatus } from "../models/DeviceResource";
import type { ConfigurableDeviceResource } from "../models/DeviceResourceConfiguration";
import type { AdbClientFactory } from "./android-cmdline-tools/AdbClientFactory";
import type { SimCtl } from "./ios-cmdline-tools/SimCtlClient";
import type { PlistReader } from "./ios-cmdline-tools/PlistClient";
import type { Timer } from "./SystemTimer";
import {
  AndroidDeviceResourceReader,
  type AndroidResourceReadRun,
} from "./androidDeviceResourceReader";
import { IosDeviceResourceReader } from "./iosDeviceResourceReader";
import {
  androidDeviceResourceCatalog,
  androidResourceSettings,
} from "./androidDeviceResourceCatalog";
import { iosDeviceResourceCatalog } from "./iosDeviceResourceCatalog";
import { resolveIosDeviceKind } from "./ios-cmdline-tools/IosDeviceKind";
import { errorMessage } from "./describeUnknownError";
import { logger } from "./logger";

export interface DeviceResourceObservationRequest {
  device: BootedDevice;
  deadlineMs: number;
  signal?: AbortSignal;
}

/** Read-only observation; independent of requested configuration and restoration receipts. */
export interface DeviceResourceObserver {
  observeResources(
    request: DeviceResourceObservationRequest,
  ): Promise<AndroidDeviceResource | AppleDeviceResource>;
}

const noReadPath = "This resource has no approved native read path on this device type.";
function unsupported(reason = noReadPath): DeviceResourceStatus {
  return { state: "unsupported", reason };
}
function commonResources(reason = noReadPath): DeviceResourceMap {
  return {
    wallpaperRendering: unsupported(reason),
    widgets: unsupported(reason),
    liveActivities: unsupported(reason),
    backgroundSync: unsupported(reason),
    searchIndexing: unsupported(reason),
    animations: unsupported(reason),
  };
}

/** Every catalog target must be covered. Absent targets never imply enabled/disabled peers. */
function assembleGroup(evidence: DeviceResourceStatus[]): DeviceResourceStatus {
  if (!evidence.length || evidence.every(({ state }) => state === "unsupported")) {
    return unsupported(
      "No compatible installed targets with an approved read path for this resource.",
    );
  }
  const state = evidence[0]!.state;
  if (
    (state === "enabled" || state === "disabled") &&
    evidence.every((entry) => entry.state === state)
  ) {
    return {
      state,
      reason: `Verified all ${evidence.length} catalog targets on the current boot.`,
    };
  }
  const reasons = [...new Set(evidence.flatMap((entry) => (entry.reason ? [entry.reason] : [])))];
  return {
    state: "unknown",
    reason: `Mixed or incomplete resource group evidence.${reasons.length ? ` ${reasons.join(" ")}` : ""}`,
  };
}

function failure(error: unknown): DeviceResourceStatus {
  logger.warn(`Device resource observation failed: ${errorMessage(error)}`, error);
  return { state: "unknown", reason: errorMessage(error) };
}

export class DefaultDeviceResourceObserver implements DeviceResourceObserver {
  private readonly android: AndroidDeviceResourceReader;
  private readonly ios: IosDeviceResourceReader;
  constructor(
    options: {
      adbFactory?: Pick<AdbClientFactory, "create">;
      simctl?: Pick<SimCtl, "executeCommandArgs">;
      plist?: Pick<PlistReader, "readJsonFile">;
      timer?: Pick<Timer, "now">;
      readDirectory?: (path: string) => Promise<string[]>;
    } = {},
  ) {
    this.android = new AndroidDeviceResourceReader(options);
    this.ios = new IosDeviceResourceReader(options);
  }

  async observeResources(
    request: DeviceResourceObservationRequest,
  ): Promise<AndroidDeviceResource | AppleDeviceResource> {
    request.signal?.throwIfAborted();
    return request.device.platform === "android"
      ? this.observeAndroid(request)
      : this.observeIos(request);
  }

  private async observeAndroid(
    request: DeviceResourceObservationRequest,
  ): Promise<AndroidDeviceResource> {
    const snapshot: AndroidDeviceResource = {
      deviceId: request.device.deviceId,
      platform: "android",
      resources: { ...commonResources(), googlePlayServices: unsupported() },
    };
    if (!/^emulator-\d+$/.test(request.device.deviceId)) {
      const reason = "Resource observation currently requires an Android emulator.";
      snapshot.resources = { ...commonResources(reason), googlePlayServices: unsupported(reason) };
      return snapshot;
    }
    const groups: (keyof AndroidDeviceResource["resources"])[] = [
      ...(Object.keys(
        androidDeviceResourceCatalog,
      ) as (keyof typeof androidDeviceResourceCatalog)[]),
      ...(Object.keys(androidResourceSettings) as (keyof typeof androidResourceSettings)[]),
      "backup",
    ];
    let run: AndroidResourceReadRun;
    try {
      run = this.android.createRun(request, true);
      await this.android.identifyRun(run);
    } catch (error) {
      request.signal?.throwIfAborted();
      const status = failure(error);
      for (const resource of groups) {
        snapshot.resources[resource] = status;
      }
      return snapshot;
    }
    for (const resource of groups) {
      snapshot.resources[resource] = await this.observeAndroidGroup(run, resource);
    }
    request.signal?.throwIfAborted();
    return snapshot;
  }

  private async observeAndroidGroup(
    run: AndroidResourceReadRun,
    resource: ConfigurableDeviceResource,
  ): Promise<DeviceResourceStatus> {
    try {
      const entries = await this.android.discover(run, resource);
      const catalog: Partial<Record<ConfigurableDeviceResource, readonly string[]>> =
        androidDeviceResourceCatalog;
      const expected = catalog[resource]?.length ?? entries.length;
      const evidence: DeviceResourceStatus[] = [];
      for (const entry of entries) {
        try {
          evidence.push({ state: this.android.state(entry, await this.android.read(run, entry)) });
        } catch (error) {
          run.request.signal?.throwIfAborted();
          evidence.push(failure(error));
        }
      }
      while (evidence.length < expected) {
        evidence.push(unsupported("Catalog target absent on this device."));
      }
      return assembleGroup(evidence);
    } catch (error) {
      run.request.signal?.throwIfAborted();
      return failure(error);
    }
  }

  private async observeIos(
    request: DeviceResourceObservationRequest,
  ): Promise<AppleDeviceResource> {
    const snapshot: AppleDeviceResource = {
      deviceId: request.device.deviceId,
      platform: "ios",
      resources: { ...commonResources(), icloudSync: unsupported(), photoAnalysis: unsupported() },
    };
    if (resolveIosDeviceKind({ deviceId: request.device.deviceId }) !== "simulator") {
      const reason = "Resource observation currently requires an iOS Simulator.";
      snapshot.resources = {
        ...commonResources(reason),
        icloudSync: unsupported(reason),
        photoAnalysis: unsupported(reason),
      };
      return snapshot;
    }
    request = this.ios.createObservationRequest(request);
    let paths: Map<string, string>;
    try {
      paths = await this.ios.readRuntimeInventory(request);
    } catch (error) {
      request.signal?.throwIfAborted();
      const status = failure(error);
      for (const resource of Object.keys(
        iosDeviceResourceCatalog,
      ) as (keyof typeof iosDeviceResourceCatalog)[]) {
        snapshot.resources[resource] = status;
      }
      return snapshot;
    }
    if (!paths.size) {
      for (const resource of Object.keys(
        iosDeviceResourceCatalog,
      ) as (keyof typeof iosDeviceResourceCatalog)[]) {
        snapshot.resources[resource] = unsupported(
          "No approved installed service definitions found for this booted iOS runtime.",
        );
      }
      return snapshot;
    }
    for (const resource of Object.keys(
      iosDeviceResourceCatalog,
    ) as (keyof typeof iosDeviceResourceCatalog)[]) {
      snapshot.resources[resource] = await this.observeIosGroup(
        request,
        iosDeviceResourceCatalog[resource],
        paths,
      );
    }
    request.signal?.throwIfAborted();
    return snapshot;
  }

  private async observeIosGroup(
    request: DeviceResourceObservationRequest,
    labels: readonly string[],
    paths: Map<string, string>,
  ): Promise<DeviceResourceStatus> {
    try {
      const evidence: Record<string, DeviceResourceStatus> = {};
      const definitions = await this.ios.resolveDefinitions(request, labels, paths, evidence);
      for (const { label } of definitions) {
        try {
          const { state } = await this.ios.readService(request, label);
          evidence[label] = {
            state,
            ...(state === "unknown"
              ? { reason: "Service override and registration do not verify availability." }
              : {}),
          };
        } catch (error) {
          request.signal?.throwIfAborted();
          evidence[label] = failure(error);
        }
      }
      return assembleGroup(
        labels.map(
          (label) => evidence[label] ?? { state: "unknown", reason: `No evidence for ${label}.` },
        ),
      );
    } catch (error) {
      request.signal?.throwIfAborted();
      return failure(error);
    }
  }
}
