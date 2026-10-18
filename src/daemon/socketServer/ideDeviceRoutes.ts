import type { AndroidCtrlProxyManager } from "../../ctrlProxy/CtrlProxyManager";
import type { BootedDevice } from "../../models";

type CtrlProxyEnsureResult = Awaited<
  ReturnType<AndroidCtrlProxyManager["ensureCompatibleVersion"]>
>;
import type { AdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import type {
  KeyValueType,
  PreferenceStoreResolution,
  StorageWriteOptions,
} from "../../features/storage/storageTypes";
import {
  clearAndroidKeyValueFileDirect,
  directFileFallbackRelaunchWarning,
  removeAndroidKeyValueDirect,
  setAndroidKeyValueDirect,
  withAndroidSharedPreferencesInspectionFallback,
} from "../../features/storage/AndroidSharedPreferencesKeyValueFile";
import { rethrowForRouteWithoutUserId } from "../../features/preferences/resolveAndroidPreferencesUser";
import { preferenceSetWarning, validateTypeForPlatform } from "../../server/storageTools";
import { getAbortSignal } from "../../utils/AbortContext";
import { IDE_ROUTE_PARSERS } from "../ideRoutes";
import type { DaemonRequest } from "../types";
import type { IdeMutationCall } from "./ideMutationCall";

/**
 * The device-touching `ide/*` routes (#11815): `ide/updateService` and the key-value mutations.
 * The route module names exactly what it needs from the socket server in
 * {@link IdeDeviceRouteDeps} (device pool, ownership and discovery accessors, the CtrlProxy
 * clients); the server supplies it and mounts the handlers in its route map.
 */

/**
 * The narrow key-value mutation surface the `ide/*` handlers need from a
 * platform CtrlProxy client. Both AndroidCtrlProxyClient and IOSCtrlProxyClient
 * satisfy it structurally (#4708). Storage writes notify onDispatch synchronously after a
 * successful socket send; connecting, cancellation and send failures are not session use.
 */
export interface KeyValueMutationClient {
  setPreference(
    packageName: string,
    fileName: string,
    key: string,
    value: string,
    type: KeyValueType,
    timeoutMsOrOptions?: number | StorageWriteOptions,
  ): Promise<PreferenceStoreResolution | void>;
  removePreference(
    packageName: string,
    fileName: string,
    key: string,
    timeoutMsOrOptions?: number | StorageWriteOptions,
  ): Promise<PreferenceStoreResolution | void>;
  clearPreferenceStore(
    packageName: string,
    fileName: string,
    timeoutMsOrOptions?: number | StorageWriteOptions,
  ): Promise<PreferenceStoreResolution | void>;
}

export type IdeDeviceRouteHandler = (
  request: DaemonRequest,
  socketSessionId: string | undefined,
  ideMutation: IdeMutationCall | undefined,
) => Promise<unknown>;

export interface IdeDeviceRouteDeps {
  /** Booted devices and the target serial, both as pooled canonical ids. */
  resolveIdeActionDevices: (
    platform: "android" | "ios",
    serial: string,
  ) => Promise<{ devices: readonly BootedDevice[]; deviceId: string }>;
  /** FUNNEL 1: fold a discovery observation into pooled identity. A no-op in direct mode. */
  reconcileDiscoveryObservation: (
    devices: readonly BootedDevice[],
    source: string,
  ) => Promise<void>;
  /** FUNNEL 2: refuse a quarantined serial. A no-op in direct mode. */
  assertDeviceActionable: (deviceId: string, purpose: string) => void;
  isShutdownReserved: (deviceId: string) => Promise<boolean>;
  /** The ownership/admission gate; starts the mutation's tracked execution on `ideMutation`. */
  assertIdeMutationOwnership: (
    request: DaemonRequest,
    device: BootedDevice,
    action: string,
    force: boolean,
    ideMutation: IdeMutationCall | undefined,
  ) => Promise<void>;
  assertSocketToolEnabled: (deviceId: string, toolName: string) => Promise<void>;
  keyValueClient: (platform: "android" | "ios", device: BootedDevice) => KeyValueMutationClient;
  createAdb: (device: BootedDevice) => ReturnType<AdbClientFactory["create"]>;
  androidCtrlProxy: (device: BootedDevice) => {
    resumeAfterDeviceStart: () => void;
    ensureCompatibleVersion: (options: {
      allowDownloadWhenInstalled: boolean;
      bypassVersionCheckCache: boolean;
    }) => Promise<CtrlProxyEnsureResult>;
  };
  iosCtrlProxy: (device: BootedDevice) => {
    resumeAfterDeviceStart: () => void;
    forceRestart: () => Promise<void>;
  };
}

async function resolveKeyValueMutationClient(
  deps: IdeDeviceRouteDeps,
  platformValue: string | undefined,
  deviceId: string,
  request: DaemonRequest,
  action: string,
  ideMutation: IdeMutationCall | undefined,
): Promise<{
  platform: "android" | "ios";
  client: KeyValueMutationClient;
  device: BootedDevice;
}> {
  const platform = platformValue ?? "android";
  if (platform !== "android" && platform !== "ios") {
    throw new Error(`Invalid platform: ${platform}. Must be 'android' or 'ios'.`);
  }
  const { devices: bootedDevices, deviceId: canonicalDeviceId } =
    await deps.resolveIdeActionDevices(platform, deviceId);
  // FUNNEL 1 then FUNNEL 2: reconcile before addressing the serial.
  await deps.reconcileDiscoveryObservation(bootedDevices, "socket:ide/keyValueMutation");
  deps.assertDeviceActionable(canonicalDeviceId, "to mutate stored values");
  const targetDevice = bootedDevices.find((d) => d.deviceId === canonicalDeviceId);
  if (!targetDevice) {
    throw new Error(`Device not found: ${deviceId}`);
  }
  await deps.assertIdeMutationOwnership(request, targetDevice, action, false, ideMutation);
  getAbortSignal()?.throwIfAborted();
  return { platform, client: deps.keyValueClient(platform, targetDevice), device: targetDevice };
}

/**
 * Run a key-value mutation through the shared SharedPreferences inspection-disabled fallback
 * (issue #6292). On Android, if the SDK ContentProvider path is gated because inspection is
 * disabled, this falls back to the same direct-file `adb shell run-as` XML edit the MCP
 * `setKeyValue`/`removeKeyValue`/`clearKeyValueFile` tools use. iOS has no on-device XML
 * fallback, so `viaSdk` runs alone. Stamps session use once: from the SDK successful-send
 * hook, or immediately after the fallback abort check before direct-file work. Connecting
 * alone never stamps.
 */
export async function runIdeKeyValueMutation(
  deps: Pick<IdeDeviceRouteDeps, "createAdb">,
  platform: "android" | "ios",
  device: BootedDevice,
  appId: string,
  fileName: string,
  mutation: {
    dispatching: () => void;
    viaSdk: (onDispatch: () => void) => Promise<PreferenceStoreResolution | void>;
    viaDirectFile: (adb: ReturnType<AdbClientFactory["create"]>) => Promise<void>;
  },
): Promise<{
  usedDirectFileFallback: boolean;
  resolution: PreferenceStoreResolution | undefined;
}> {
  let dispatched = false;
  const onDispatch = () => {
    if (dispatched) {
      return;
    }
    dispatched = true;
    mutation.dispatching();
  };
  if (platform !== "android") {
    getAbortSignal()?.throwIfAborted();
    const resolution = (await mutation.viaSdk(onDispatch)) || undefined;
    return { usedDirectFileFallback: false, resolution };
  }
  let resolution: PreferenceStoreResolution | undefined;
  const result = await withAndroidSharedPreferencesInspectionFallback(
    appId,
    fileName,
    () => deps.createAdb(device),
    async () => {
      getAbortSignal()?.throwIfAborted();
      resolution = (await mutation.viaSdk(onDispatch)) || undefined;
    },
    // The ide/* params carry no userId, so an ambiguous-user error cannot say "pass userId".
    (adb) => {
      getAbortSignal()?.throwIfAborted();
      onDispatch();
      return mutation.viaDirectFile(adb).catch(rethrowForRouteWithoutUserId);
    },
  );
  return { ...result, resolution };
}

async function updateService(
  deps: IdeDeviceRouteDeps,
  request: DaemonRequest,
  ideMutation: IdeMutationCall | undefined,
): Promise<unknown> {
  const args = IDE_ROUTE_PARSERS["ide/updateService"](request.params);

  // Find the booted device
  const { devices: bootedDevices, deviceId } = await deps.resolveIdeActionDevices(
    args.platform,
    args.deviceId,
  );
  // FUNNEL 1 then FUNNEL 2: reconcile before addressing the serial.
  await deps.reconcileDiscoveryObservation(bootedDevices, "socket:ide/updateService");
  deps.assertDeviceActionable(deviceId, "to update the accessibility service");
  const targetDevice = bootedDevices.find((d) => d.deviceId === deviceId);
  if (!targetDevice) {
    throw new Error(`Device not found: ${args.deviceId}`);
  }
  if (await deps.isShutdownReserved(targetDevice.deviceId)) {
    throw new Error(`Device '${targetDevice.deviceId}' is shutting down.`);
  }
  // A lifecycle action on a held device: only the holder, or an explicit `force` (as
  // killDevice allows), may reinstall/restart its CtrlProxy (#10827).
  await deps.assertIdeMutationOwnership(
    request,
    targetDevice,
    "ide/updateService",
    args.force,
    ideMutation,
  );
  if (args.platform === "android") {
    getAbortSignal()?.throwIfAborted();
    ideMutation?.dispatching();
    const proxy = deps.androidCtrlProxy(targetDevice);
    proxy.resumeAfterDeviceStart();
    const result = await proxy.ensureCompatibleVersion({
      allowDownloadWhenInstalled: true,
      bypassVersionCheckCache: true,
    });
    const successStatuses = new Set(["compatible", "upgraded", "installed", "reinstalled"]);
    return {
      success: successStatuses.has(result.status),
      message: `Accessibility service ${result.status}${result.error ? `: ${result.error}` : ""}`,
      status: result,
    };
  }
  const proxy = deps.iosCtrlProxy(targetDevice);
  getAbortSignal()?.throwIfAborted();
  ideMutation?.dispatching();
  proxy.resumeAfterDeviceStart();
  await proxy.forceRestart();
  return {
    success: true,
    message: "CtrlProxy iOS restarted",
  };
}

async function setKeyValue(
  deps: IdeDeviceRouteDeps,
  request: DaemonRequest,
  ideMutation: IdeMutationCall | undefined,
): Promise<unknown> {
  const args = IDE_ROUTE_PARSERS["ide/setKeyValue"](request.params);
  await deps.assertSocketToolEnabled(args.deviceId, "setKeyValue");
  const { platform, client, device } = await resolveKeyValueMutationClient(
    deps,
    args.platform,
    args.deviceId,
    request,
    "ide/setKeyValue",
    ideMutation,
  );
  const appId = args.appId;
  const fileName = args.fileName;
  const key = args.key;
  let usedDirectFileFallback = false;
  let resolution: PreferenceStoreResolution | undefined;
  if (args.value === null || args.value === undefined) {
    ({ usedDirectFileFallback, resolution } = await runIdeKeyValueMutation(
      deps,
      platform,
      device,
      appId,
      fileName,
      {
        dispatching: () => ideMutation?.dispatching(),
        viaSdk: (onDispatch) => client.removePreference(appId, fileName, key, { onDispatch }),
        viaDirectFile: (adb) =>
          removeAndroidKeyValueDirect(adb, device.deviceId, appId, fileName, key),
      },
    ));
  } else {
    // Enforce the same cross-platform type guidance as the MCP-tool path
    // (storageTools.ts) before dispatch, so a platform-incompatible type
    // fails with an actionable error rather than deeper in the client (#5022).
    validateTypeForPlatform(platform, args.type as KeyValueType);
    const value = args.value;
    const type = args.type as KeyValueType;
    ({ usedDirectFileFallback, resolution } = await runIdeKeyValueMutation(
      deps,
      platform,
      device,
      appId,
      fileName,
      {
        dispatching: () => ideMutation?.dispatching(),
        viaSdk: (onDispatch) =>
          client.setPreference(appId, fileName, key, value, type, { onDispatch }),
        viaDirectFile: (adb) =>
          setAndroidKeyValueDirect(adb, device.deviceId, appId, fileName, key, value, type),
      },
    ));
  }
  const resolvedStore = resolution?.resolvedStore;
  const effectiveValueDiffers = resolution?.effectiveValueDiffers;
  const warning = preferenceSetWarning(
    usedDirectFileFallback ? directFileFallbackRelaunchWarning(appId, fileName) : undefined,
    effectiveValueDiffers,
  );
  return {
    success: true,
    ...(resolvedStore ? { resolvedStore } : {}),
    ...(effectiveValueDiffers ? { effectiveValueDiffers } : {}),
    ...(warning ? { warning } : {}),
  };
}

async function removeKeyValue(
  deps: IdeDeviceRouteDeps,
  request: DaemonRequest,
  ideMutation: IdeMutationCall | undefined,
): Promise<unknown> {
  const args = IDE_ROUTE_PARSERS["ide/removeKeyValue"](request.params);
  await deps.assertSocketToolEnabled(args.deviceId, "removeKeyValue");
  const { platform, client, device } = await resolveKeyValueMutationClient(
    deps,
    args.platform,
    args.deviceId,
    request,
    "ide/removeKeyValue",
    ideMutation,
  );
  const appId = args.appId;
  const fileName = args.fileName;
  const key = args.key;
  const { usedDirectFileFallback, resolution } = await runIdeKeyValueMutation(
    deps,
    platform,
    device,
    appId,
    fileName,
    {
      dispatching: () => ideMutation?.dispatching(),
      viaSdk: (onDispatch) => client.removePreference(appId, fileName, key, { onDispatch }),
      viaDirectFile: (adb) =>
        removeAndroidKeyValueDirect(adb, device.deviceId, appId, fileName, key),
    },
  );
  const resolvedStore = resolution?.resolvedStore;
  const warning = usedDirectFileFallback
    ? directFileFallbackRelaunchWarning(appId, fileName)
    : undefined;
  return {
    success: true,
    ...(resolvedStore ? { resolvedStore } : {}),
    ...(warning ? { warning } : {}),
  };
}

async function clearKeyValueFile(
  deps: IdeDeviceRouteDeps,
  request: DaemonRequest,
  ideMutation: IdeMutationCall | undefined,
): Promise<unknown> {
  const args = IDE_ROUTE_PARSERS["ide/clearKeyValueFile"](request.params);
  await deps.assertSocketToolEnabled(args.deviceId, "clearKeyValueFile");
  const { platform, client, device } = await resolveKeyValueMutationClient(
    deps,
    args.platform,
    args.deviceId,
    request,
    "ide/clearKeyValueFile",
    ideMutation,
  );
  const appId = args.appId;
  const fileName = args.fileName;
  const { usedDirectFileFallback, resolution } = await runIdeKeyValueMutation(
    deps,
    platform,
    device,
    appId,
    fileName,
    {
      dispatching: () => ideMutation?.dispatching(),
      viaSdk: (onDispatch) => client.clearPreferenceStore(appId, fileName, { onDispatch }),
      viaDirectFile: (adb) => clearAndroidKeyValueFileDirect(adb, device.deviceId, appId, fileName),
    },
  );
  const resolvedStore = resolution?.resolvedStore;
  const warning = usedDirectFileFallback
    ? directFileFallbackRelaunchWarning(appId, fileName)
    : undefined;
  return {
    success: true,
    ...(resolvedStore ? { resolvedStore } : {}),
    ...(warning ? { warning } : {}),
  };
}

export function ideDeviceRoutes(
  deps: IdeDeviceRouteDeps,
): ReadonlyMap<string, IdeDeviceRouteHandler> {
  return new Map<string, IdeDeviceRouteHandler>([
    ["ide/updateService", (request, _sessionId, call) => updateService(deps, request, call)],
    ["ide/setKeyValue", (request, _sessionId, call) => setKeyValue(deps, request, call)],
    ["ide/removeKeyValue", (request, _sessionId, call) => removeKeyValue(deps, request, call)],
    [
      "ide/clearKeyValueFile",
      (request, _sessionId, call) => clearKeyValueFile(deps, request, call),
    ],
  ]);
}
