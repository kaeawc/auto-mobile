import { AndroidCtrlProxyClient } from "../features/observe/android/AndroidCtrlProxyClient";
import {
  sdkCapabilitiesUnavailable,
  type SdkCapabilitiesReader,
  type SdkCapabilitiesResult,
} from "../features/sdk/sdkCapabilities";
import type { BootedDevice } from "../models";
import {
  defaultAdbClientFactory,
  type AdbClientFactory,
} from "../utils/android-cmdline-tools/AdbClientFactory";
import { encodeUriSegment } from "../utils/encodeUriSegment";
import { logger } from "../utils/logger";
import { findBootedDeviceForResource } from "./resourceDeviceResolver";
import { ResourceRegistry, type ResourceContent } from "./resourceRegistry";

/** Payload schema version of this resource envelope (the nested snapshot carries its own). */
export const SDK_CAPABILITIES_RESOURCE_SCHEMA_VERSION = 1 as const;

// The optional {?appId} query variant matches both the bare and the app-scoped URI. Without an
// appId the foreground app of the bound device is used.
const SDK_CAPABILITIES_TEMPLATE = "automobile:devices/{deviceId}/sdk/capabilities{?appId}";

export interface SdkCapabilityResourceDependencies {
  createReader?: (device: BootedDevice) => SdkCapabilitiesReader;
  adbFactory?: AdbClientFactory;
}

function buildUri(deviceId: string, appId?: string): string {
  const base = `automobile:devices/${deviceId}/sdk/capabilities`;
  return appId ? `${base}?appId=${encodeUriSegment(appId)}` : base;
}

function envelope(uri: string, body: Record<string, unknown>, deviceId?: string): ResourceContent {
  return {
    uri,
    mimeType: "application/json",
    text: JSON.stringify(
      { schemaVersion: SDK_CAPABILITIES_RESOURCE_SCHEMA_VERSION, deviceId, ...body },
      null,
      2,
    ),
  };
}

async function resolveForegroundAppId(
  device: BootedDevice,
  dependencies: SdkCapabilityResourceDependencies,
): Promise<string | undefined> {
  try {
    const adb = (dependencies.adbFactory ?? defaultAdbClientFactory).create(device);
    return (await adb.getForegroundApp())?.packageName;
  } catch (error) {
    logger.warn("[SdkCapabilityResources] Foreground app probe failed", error);
    return undefined;
  }
}

async function readCapabilities(
  device: BootedDevice,
  appId: string,
  dependencies: SdkCapabilityResourceDependencies,
): Promise<SdkCapabilitiesResult> {
  try {
    const reader =
      dependencies.createReader?.(device) ?? AndroidCtrlProxyClient.getInstance(device);
    return await reader.getSdkCapabilities(appId);
  } catch (error) {
    logger.warn("[SdkCapabilityResources] SDK capability read failed", error);
    return sdkCapabilitiesUnavailable("CTRLPROXY_UNREACHABLE");
  }
}

/** SDK capability and capture-policy resource handler (issue #5191). */
export async function getSdkCapabilitiesResource(
  params: Record<string, string>,
  dependencies: SdkCapabilityResourceDependencies = {},
): Promise<ResourceContent> {
  const { deviceId } = params;
  // The resource registry already percent-decodes query params (see #5686).
  const requestedAppId = params.appId ? params.appId : undefined;
  const uri = buildUri(deviceId, requestedAppId);
  try {
    const device = await findBootedDeviceForResource(deviceId, "SdkCapabilityResources");
    if (!device) {
      return envelope(uri, { error: `Device not found or not booted: ${deviceId}` });
    }
    if (device.platform !== "android") {
      return envelope(
        uri,
        {
          appId: requestedAppId ?? null,
          result: sdkCapabilitiesUnavailable("UNSUPPORTED_PLATFORM"),
        },
        deviceId,
      );
    }
    const appId = requestedAppId ?? (await resolveForegroundAppId(device, dependencies));
    if (!appId) {
      return envelope(uri, { appId: null, result: sdkCapabilitiesUnavailable("NO_APP") }, deviceId);
    }
    return envelope(
      uri,
      { appId, result: await readCapabilities(device, appId, dependencies) },
      deviceId,
    );
  } catch (error) {
    logger.error(`[SdkCapabilityResources] Failed to read SDK capabilities: ${error}`);
    return envelope(uri, { error: `Failed to read SDK capabilities: ${error}` }, deviceId);
  }
}

/** Register the SDK capabilities resource (issue #5191). */
export function registerSdkCapabilityResources(
  dependencies: SdkCapabilityResourceDependencies = {},
): void {
  ResourceRegistry.registerTemplate(
    SDK_CAPABILITIES_TEMPLATE,
    "SDK Capabilities",
    "Versioned SDK capability states and capture policy (headers, bodies, mutations) for the bound device's app, read through CtrlProxy. An older SDK, CtrlProxy, or a release build yields status 'unavailable' with a reason, never an empty capability set.",
    "application/json",
    (params) => getSdkCapabilitiesResource(params, dependencies),
  );
  logger.info("[SdkCapabilityResources] Registered SDK capability resources");
}
