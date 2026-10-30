import { ENV, readEnvRaw } from "../../config/env";
import {
  availableDaemonSockets,
  getUnavailableAuxiliarySockets,
} from "../auxiliarySocketAvailability";
import { IDE_ROUTE_PARSERS } from "../ideRoutes";
import type { IdeMutationCall } from "./ideMutationCall";
import { runWithAbortSignal } from "../../utils/AbortContext";
import { createHash } from "node:crypto";
import { isDebugModeEnabled } from "../../utils/debug";
import { DaemonRequest, type DaemonOptions } from "../types";
import { type DaemonSelfIdentity } from "../wire/daemonHandshake";
import type { DaemonStateAccess } from "../daemonRequestHandlers";
import {
  assertControlNotOnForeignDaemonDevice,
  assertInputNotOnForeignBindingDevice,
  assertInputRequesterHoldsDevice,
  parseInputRequesterSessionUuid,
  type ForeignDaemonClaimGate,
} from "../inputDeviceOwnership";
import {
  assertFrameTargetIdentityProven,
  canonicalFrameDeviceId,
  canonicalizeFrameDiscovery,
  frameHeldSessionsFrom,
  type CanonicalFrameDiscovery,
  type FrameDeviceIdentityPool,
} from "../frameDeviceIdentity";
import {
  preferenceSetWarning,
  validateTypeForPlatform,
} from "../../features/storage/storageChecks";
import {
  clearAndroidKeyValueFileDirect,
  directFileFallbackRelaunchWarning,
  removeAndroidKeyValueDirect,
  setAndroidKeyValueDirect,
  withAndroidSharedPreferencesInspectionFallback,
} from "../../features/storage/AndroidSharedPreferencesKeyValueFile";
import { rethrowForRouteWithoutUserId } from "../../features/preferences/resolveAndroidPreferencesUser";
import {
  IOS_CTRL_PROXY_APP_HASH,
  resolveApkChecksum,
  resolveApkUrl,
  resolveAssetVersion,
  resolveIpaChecksum,
  resolveIpaUrl,
  resolvePinnedVersion,
} from "../../constants/release";
import { AndroidCtrlProxyManager } from "../../ctrlProxy/CtrlProxyManager";
import { IOSCtrlProxyManager } from "../../ctrlProxy/IOSCtrlProxyManager";
import { PlatformDeviceManagerFactory } from "../../utils/factories/PlatformDeviceManagerFactory";
import {
  AndroidBootedDeviceDiscoveryIncompleteError,
  BootedDeviceDiscoveryIncompleteError,
} from "../../models/BootedDeviceDiscoveryIncompleteError";
import { expectingPooledSources, isDeviceSourceIncomplete } from "../../utils/discoverySource";
import { AndroidCtrlProxyClient } from "../../features/observe/android";
import { IOSCtrlProxyClient } from "../../features/observe/ios";
import { type AdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import type {
  KeyValueType,
  KeyValueWrite,
  PreferenceStoreResolution,
  StorageWriteOptions,
} from "../../features/storage/storageTypes";
import type { BootedDevice, Platform } from "../../models";
import { executionTracker, type ActiveExecution } from "../executionTracker";
import { processGenerationRecordFields } from "../processGenerationFields";
import { sessionReleaseThatCancelledCall } from "../sessionReleasedDuringCall";

/** Server-owned state is resolved per call, including fields initialized after the route table. */
export interface IdeDeviceRoutesPorts {
  daemonIdentity: () => Pick<DaemonSelfIdentity, "version" | "build">;
  identityStartedAt: () => number;
  identityProcessStartedAt: () => number | undefined;
  identityDbPath: () => string | undefined;
  identityPidFilePath: () => string | undefined;
  socketPath: () => string;
  identitySockets: () => Record<string, string> | undefined;
  startupOptions: () => DaemonOptions;
  processGenerationToken: () => string | undefined;
  acceptanceDiscoveryCapability: () => string | undefined;
  daemonState: () => {
    isInitialized(): boolean;
    getSessionManager(): Pick<
      ReturnType<DaemonStateAccess["getSessionManager"]>,
      "getSessionForDevice" | "getDeviceLabels" | "getAllSessions" | "getHeldDeviceSessions"
    >;
    getDevicePool(): Omit<FrameDeviceIdentityPool, "getAllDevices"> &
      ForeignDaemonClaimGate &
      Pick<
        ReturnType<DaemonStateAccess["getDevicePool"]>,
        "isShutdownReserved" | "assertNotAssignedToBinding"
      > & {
        getAllDevices?(): readonly { id: string; platform: Platform }[];
      };
  };
  adbClientFactory: () => AdbClientFactory;
  assertSocketToolEnabled: (deviceId: string, toolName: string) => Promise<void>;
  reconcileDiscoveryObservation: (
    devices: readonly BootedDevice[],
    origin: string,
  ) => Promise<void>;
  assertDeviceActionable: (deviceId: string, action: string) => void;
  assertBrokerConnectionControl: (
    socketSessionId: string | undefined,
    action: string,
    target: { deviceId?: string; requesterSessionUuid?: string },
  ) => void;
  admitInputAsControlCall: (
    execution: ActiveExecution,
    deviceId: string,
    holderSessionUuid: string | undefined,
    ownerSignal: AbortSignal | undefined,
  ) => Promise<void>;
  /** Call through the server so protected instance overrides and spies still intercept. */
  listBootedDevicesForIdeAction: IdeDeviceRoutes["listBootedDevicesForIdeAction"];
  resolveIdeActionDevices: IdeDeviceRoutes["resolveIdeActionDevices"];
  runIdeKeyValueMutation: IdeDeviceRoutes["runIdeKeyValueMutation"];
}

type IdeDeviceRouteHandler = (
  request: DaemonRequest,
  socketSessionId: string | undefined,
  ideMutation: IdeMutationCall | undefined,
) => Promise<unknown>;

/**
 * The narrow key-value mutation surface the `ide/*` handlers need from a
 * platform CtrlProxy client. Both AndroidCtrlProxyClient and IOSCtrlProxyClient
 * satisfy it structurally (#4708). Storage writes notify onDispatch synchronously after a
 * successful socket send; connecting, cancellation and send failures are not session use.
 */
interface KeyValueMutationClient {
  setPreference(
    packageName: string,
    fileName: string,
    entry: KeyValueWrite,
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

/** Device mutation and storage routes for the IDE socket; all state remains on the server. */
export class IdeDeviceRoutes {
  constructor(private readonly ports: IdeDeviceRoutesPorts) {}

  readonly routes: ReadonlyMap<string, IdeDeviceRouteHandler> = new Map<
    string,
    IdeDeviceRouteHandler
  >([
    [
      "ide/status",
      (request, socketSessionId, ideMutation) =>
        this.ideStatus(request, socketSessionId, ideMutation),
    ],
    [
      "ide/updateService",
      (request, socketSessionId, ideMutation) =>
        this.ideUpdateService(request, socketSessionId, ideMutation),
    ],
    [
      "ide/setKeyValue",
      (request, socketSessionId, ideMutation) =>
        this.ideSetKeyValue(request, socketSessionId, ideMutation),
    ],
    [
      "ide/removeKeyValue",
      (request, socketSessionId, ideMutation) =>
        this.ideRemoveKeyValue(request, socketSessionId, ideMutation),
    ],
    [
      "ide/clearKeyValueFile",
      (request, socketSessionId, ideMutation) =>
        this.ideClearKeyValueFile(request, socketSessionId, ideMutation),
    ],
  ]);

  private async ideStatus(
    request: DaemonRequest,
    socketSessionId: string | undefined,
    ideMutation: IdeMutationCall | undefined,
  ): Promise<any | undefined> {
    const acceptanceDiscoveryCapability = this.ports.acceptanceDiscoveryCapability();
    return {
      structuredSessionNotFound: true,
      structuredToolErrorCodes: true,
      // Concrete pinned version (honors AUTOMOBILE_VERSION), never the
      // floating "latest" tag — external consumers must see exactly what the
      // daemon will fetch (#2746).
      version: this.ports.daemonIdentity().version,
      pid: process.pid,
      launchNonce: readEnvRaw(ENV.DAEMON_LAUNCH_NONCE),
      buildId: this.ports.daemonIdentity().build.buildId,
      entryScript: this.ports.daemonIdentity().build.entryScript,
      acceptanceCapabilityFingerprint: acceptanceDiscoveryCapability
        ? createHash("sha256").update(acceptanceDiscoveryCapability).digest("hex").slice(0, 8)
        : null,
      startedAt: this.ports.identityStartedAt(),
      processStartedAt: this.ports.identityProcessStartedAt(),
      dbPath: this.ports.identityDbPath(),
      reportedPidFilePath: this.ports.identityPidFilePath(),
      reportedSocketPath: this.ports.socketPath(),
      reportedSockets: availableDaemonSockets(this.ports.identitySockets() ?? {}),
      unavailableSockets: getUnavailableAuxiliarySockets(),
      effectiveDebug: isDebugModeEnabled(),
      options: this.ports.startupOptions(),
      ...processGenerationRecordFields(this.ports.processGenerationToken()),
      activeProvisioning: executionTracker.hasActiveToolExecution("provisionDevice", {
        scope: "global",
      }),
      releaseVersion: resolveAssetVersion(resolvePinnedVersion()),
      android: {
        ctrlProxy: {
          expectedSha256: resolveApkChecksum(),
          url: resolveApkUrl(),
        },
      },
      ios: {
        xcTestService: {
          expectedSha256: resolveIpaChecksum(),
          expectedAppHash: IOS_CTRL_PROXY_APP_HASH,
          url: resolveIpaUrl(),
        },
      },
    };
  }

  private async ideUpdateService(
    request: DaemonRequest,
    socketSessionId: string | undefined,
    ideMutation: IdeMutationCall | undefined,
  ): Promise<any | undefined> {
    const args = IDE_ROUTE_PARSERS["ide/updateService"](request.params);

    // Find the booted device
    const { devices: bootedDevices, deviceId } = await this.ports.resolveIdeActionDevices(
      args.platform,
      args.deviceId,
      ideMutation?.signal,
    );
    // FUNNEL 1 then FUNNEL 2: reconcile before addressing the serial.
    await this.ports.reconcileDiscoveryObservation(bootedDevices, "socket:ide/updateService");
    this.ports.assertDeviceActionable(deviceId, "to update the accessibility service");
    const targetDevice = bootedDevices.find((d) => d.deviceId === deviceId);
    if (!targetDevice) {
      throw new Error(`Device not found: ${args.deviceId}`);
    }
    if (
      await this.ports.daemonState().getDevicePool().isShutdownReserved?.(targetDevice.deviceId)
    ) {
      throw new Error(`Device '${targetDevice.deviceId}' is shutting down.`);
    }
    // A lifecycle action on a held device: only the holder, or an explicit `force` (as
    // killDevice allows), may reinstall/restart its CtrlProxy (#10827).
    await this.assertIdeMutationOwnership(request, targetDevice, "ide/updateService", {
      force: args.force,
      ideMutation,
    });
    if (args.platform === "android") {
      ideMutation?.signal.throwIfAborted();
      ideMutation?.dispatching();
      AndroidCtrlProxyClient.resumeAfterDeviceStart(targetDevice.deviceId);
      const manager = AndroidCtrlProxyManager.getInstance(targetDevice);
      const result = await manager.ensureCompatibleVersion({
        allowDownloadWhenInstalled: true,
        bypassVersionCheckCache: true,
      });
      const successStatuses = new Set(["compatible", "upgraded", "installed", "reinstalled"]);
      return {
        success: successStatuses.has(result.status),
        message: `Accessibility service ${result.status}${result.error ? `: ${result.error}` : ""}`,
        status: result,
      };
    } else {
      const manager = IOSCtrlProxyManager.getInstance(targetDevice);
      ideMutation?.signal.throwIfAborted();
      ideMutation?.dispatching();
      IOSCtrlProxyClient.resumeAfterDeviceStart(targetDevice.deviceId);
      await manager.forceRestart();
      return {
        success: true,
        message: "CtrlProxy iOS restarted",
      };
    }
  }

  private async ideSetKeyValue(
    request: DaemonRequest,
    socketSessionId: string | undefined,
    ideMutation: IdeMutationCall | undefined,
  ): Promise<any | undefined> {
    const args = IDE_ROUTE_PARSERS["ide/setKeyValue"](request.params);
    await this.ports.assertSocketToolEnabled(args.deviceId, "setKeyValue");
    const { platform, client, device } = await this.resolveKeyValueMutationClient(
      args.platform,
      args.deviceId,
      request,
      { action: "ide/setKeyValue", ideMutation },
    );
    const appId = args.appId;
    const fileName = args.fileName;
    const key = args.key;
    let usedDirectFileFallback = false;
    let resolution: PreferenceStoreResolution | undefined;
    if (args.value === null || args.value === undefined) {
      ({ usedDirectFileFallback, resolution } = await this.ports.runIdeKeyValueMutation(
        platform,
        device,
        appId,
        {
          fileName,
          ideMutation,
          viaSdk: (onDispatch) => client.removePreference(appId, fileName, key, { onDispatch }),
          viaDirectFile: (adb) =>
            removeAndroidKeyValueDirect(adb, device.deviceId, { appId, fileName }, key),
        },
      ));
    } else {
      // Enforce the same cross-platform type guidance as the MCP-tool path
      // (storageTools.ts) before dispatch, so a platform-incompatible type
      // fails with an actionable error rather than deeper in the client (#5022).
      const entry = { key, value: args.value, type: args.type as KeyValueType };
      validateTypeForPlatform(platform, entry.type);
      ({ usedDirectFileFallback, resolution } = await this.ports.runIdeKeyValueMutation(
        platform,
        device,
        appId,
        {
          fileName,
          ideMutation,
          viaSdk: (onDispatch) => client.setPreference(appId, fileName, entry, { onDispatch }),
          viaDirectFile: (adb) =>
            setAndroidKeyValueDirect(adb, device.deviceId, { appId, fileName }, entry),
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

  private async ideRemoveKeyValue(
    request: DaemonRequest,
    socketSessionId: string | undefined,
    ideMutation: IdeMutationCall | undefined,
  ): Promise<any | undefined> {
    const args = IDE_ROUTE_PARSERS["ide/removeKeyValue"](request.params);
    await this.ports.assertSocketToolEnabled(args.deviceId, "removeKeyValue");
    const { platform, client, device } = await this.resolveKeyValueMutationClient(
      args.platform,
      args.deviceId,
      request,
      { action: "ide/removeKeyValue", ideMutation },
    );
    const appId = args.appId;
    const fileName = args.fileName;
    const key = args.key;
    const { usedDirectFileFallback, resolution } = await this.ports.runIdeKeyValueMutation(
      platform,
      device,
      appId,
      {
        fileName,
        ideMutation,
        viaSdk: (onDispatch) => client.removePreference(appId, fileName, key, { onDispatch }),
        viaDirectFile: (adb) =>
          removeAndroidKeyValueDirect(adb, device.deviceId, { appId, fileName }, key),
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

  private async ideClearKeyValueFile(
    request: DaemonRequest,
    socketSessionId: string | undefined,
    ideMutation: IdeMutationCall | undefined,
  ): Promise<any | undefined> {
    const args = IDE_ROUTE_PARSERS["ide/clearKeyValueFile"](request.params);
    await this.ports.assertSocketToolEnabled(args.deviceId, "clearKeyValueFile");
    const { platform, client, device } = await this.resolveKeyValueMutationClient(
      args.platform,
      args.deviceId,
      request,
      { action: "ide/clearKeyValueFile", ideMutation },
    );
    const appId = args.appId;
    const fileName = args.fileName;
    const { usedDirectFileFallback, resolution } = await this.ports.runIdeKeyValueMutation(
      platform,
      device,
      appId,
      {
        fileName,
        ideMutation,
        viaSdk: (onDispatch) => client.clearPreferenceStore(appId, fileName, { onDispatch }),
        viaDirectFile: (adb) =>
          clearAndroidKeyValueFileDirect(adb, device.deviceId, appId, fileName),
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

  /**
   * `ide/*` routes that mutate a device follow device ownership like `input/*` (#10827): a held
   * device accepts them only from its holder (the optional `sessionUuid` param), or when `force`
   * is allowed and set. Reads stay open to watchers. Unheld devices stay open to any client,
   * except a device a broker binding holds, which only that binding's execution may mutate, `force`
   * or not (#11178). A socket bound to broker bindings mutates only its own binding devices, for its own
   * binding sessions, `force` or not (#11596).
   *
   * The holder's own mutation is a control call on its session, so it also passes the session
   * admission `input/*` passes (#11486): a suspect, lapsed or idle-expired holder is refused with
   * the typed code before anything is written. `force` overrides the local holder, so a forced
   * call is not judged against the holder's session.
   *
   * Passing the gate starts the mutation's tracked execution on `ideMutation`, under the holder's
   * session: from here to the end of the route it is control in flight on that session, forced or
   * not, so the session is never released under it (#11486). Tracking is not use: the route
   * restarts the holder's idle window only when it calls `ideMutation.dispatching()`, after its
   * last pre-dispatch check (#11596).
   */
  private async assertIdeMutationOwnership(
    request: DaemonRequest,
    device: BootedDevice,
    action: string,
    { force = false, ideMutation }: { force?: boolean; ideMutation?: IdeMutationCall } = {},
  ): Promise<void> {
    const deviceId = device.deviceId;
    const requesterSessionUuid = parseInputRequesterSessionUuid(request.method, request.params);
    if (!this.ports.daemonState().isInitialized()) {
      return;
    }
    await this.assertFrameTargetProven(device, action, () => requesterSessionUuid);
    this.ports.assertBrokerConnectionControl(ideMutation?.socketSessionId, action, {
      deviceId,
      requesterSessionUuid,
    });
    const sessionManager = this.ports.daemonState().getSessionManager();
    await assertInputNotOnForeignBindingDevice({
      action,
      deviceId,
      platform: device.platform,
      requesterSessionUuid,
      sessionManager,
      gate: this.ports.daemonState().getDevicePool(),
    });
    // Another daemon's device is refused, `force` or not: `force` overrides a local holder only.
    await assertControlNotOnForeignDaemonDevice({
      deviceId,
      platform: device.platform,
      gate: this.ports.daemonState().getDevicePool(),
    });
    const holderSessionUuid = sessionManager.getSessionForDevice?.(deviceId) ?? undefined;
    if (!force) {
      assertInputRequesterHoldsDevice({
        action,
        deviceId,
        ownerSessionUuid: holderSessionUuid,
        requesterSessionUuid,
        sessionManager,
        remedy:
          "pass the holding session's sessionUuid, or wait for the holder to release the device.",
      });
    }
    if (holderSessionUuid) {
      await this.admitIdeMutationOnHolderSession(
        executionTracker.startExecution(action, undefined, holderSessionUuid),
        { deviceId, holderSessionUuid, force },
        ideMutation,
      );
    }
  }

  /**
   * Judge a mutating `ide/*` frame against the session holding its device, under the execution
   * that tracks the mutation, so the admission does not mistake it for earlier work in flight.
   * With a route to track it (`ideMutation`) the execution outlives the gate and the route ends
   * it; otherwise it ends here.
   */
  private async admitIdeMutationOnHolderSession(
    execution: ActiveExecution,
    target: { deviceId: string; holderSessionUuid: string; force: boolean },
    ideMutation: IdeMutationCall | undefined,
  ): Promise<void> {
    ideMutation?.track(execution, !target.force);
    try {
      executionTracker.bindDeviceExecution(execution.id, target.deviceId);
      if (target.force) {
        return;
      }
      await this.ports.admitInputAsControlCall(
        execution,
        target.deviceId,
        target.holderSessionUuid,
        ideMutation?.signal,
      );
      if (ideMutation) {
        // Tracked from here; stamped as session use only when the route dispatches (#11596).
        ideMutation.admit(execution);
      } else {
        // The holder's own admitted mutation is use of its session, like its input (#10824).
        executionTracker.markSessionAdmitted(execution.id);
      }
    } finally {
      if (!ideMutation) {
        executionTracker.endExecution(execution.id);
      }
    }
  }

  /**
   * Run a device-mutating `ide/*` route as one tracked control call. The route's ownership gate
   * starts the execution once the device and its holder are known; it stays in flight until the
   * route settles, so the heartbeat and idle monitors see control in flight on the holder's
   * session. A release that still lands (owner disconnect, forced release) cancels the execution:
   * the holder's own route runs its device work under that signal, and the frame answers the
   * release's typed refusal whatever the interrupted work threw. A forced route is not the
   * holder's call, so the release neither cuts it nor names the holder's session to its caller.
   */
  async runTrackedIdeMutation<T>(
    socketSessionId: string | undefined,
    run: (call: IdeMutationCall) => Promise<T>,
    ownerSignal?: AbortSignal,
  ): Promise<T> {
    const abort = new AbortController();
    let tracked: ActiveExecution | undefined;
    let cutByRelease: ActiveExecution | undefined;
    let admitted: ActiveExecution | undefined;
    const signal = ownerSignal ? AbortSignal.any([ownerSignal, abort.signal]) : abort.signal;
    const call: IdeMutationCall = {
      socketSessionId,
      signal,
      admit: (execution) => {
        admitted = execution;
      },
      dispatching: () => {
        if (admitted) {
          // The holder's own mutation that reaches the device is use of its session (#10824).
          executionTracker.markSessionAdmitted(admitted.id);
        }
      },
      track: (execution, asHolder) => {
        tracked = execution;
        if (!asHolder) {
          return;
        }
        cutByRelease = execution;
        const signal = execution.abortController.signal;
        if (signal.aborted) {
          abort.abort(signal.reason);
          return;
        }
        signal.addEventListener("abort", () => abort.abort(signal.reason), { once: true });
      },
    };
    try {
      signal.throwIfAborted();
      return await runWithAbortSignal(signal, () => run(call));
    } catch (error) {
      throw sessionReleaseThatCancelledCall(cutByRelease?.cancelReason) ?? error;
    } finally {
      if (tracked) {
        executionTracker.endExecution(tracked.id);
      }
    }
  }

  /**
   * Booted devices for an `ide/*` action on one serial. The legacy listing turns a
   * failed sweep into `[]`, which surfaced as a misleading "Device not found". When
   * the serial is absent and the discovery source that would have observed it failed
   * (adb for Android; simctl or devicectl for iOS, by serial shape), the absence
   * proves nothing, so refuse with the retryable discovery error instead (#11122,
   * cf. #11103, #11535).
   */
  async listBootedDevicesForIdeAction(
    platform: "android" | "ios",
    serial: string,
    signal?: AbortSignal,
  ): Promise<BootedDevice[]> {
    signal?.throwIfAborted();
    const manager = PlatformDeviceManagerFactory.getInstance();
    const discovery = expectingPooledSources(
      await manager.getBootedDevicesDetailed(platform),
      this.ports.daemonState()?.isInitialized()
        ? this.ports.daemonState().getDevicePool().getAllDevices?.()
        : undefined,
    );
    if (
      !discovery.devices.map((device) => device.deviceId).includes(serial) &&
      // Tooling that is not installed on this host is not an unknown: no retry can list the serial (#11605).
      isDeviceSourceIncomplete(discovery, platform, serial)
    ) {
      const discoveryError = discovery.discoveryErrors?.[platform];
      throw platform === "android"
        ? new AndroidBootedDeviceDiscoveryIncompleteError(discoveryError)
        : new BootedDeviceDiscoveryIncompleteError(platform, discoveryError);
    }
    signal?.throwIfAborted();
    return discovery.devices;
  }

  /**
   * The booted devices for an `ide/*` action and the device it names, both as pooled canonical
   * ids: the frame may name a held handset by its other transport id (#11596).
   */
  async resolveIdeActionDevices(
    platform: "android" | "ios",
    serial: string,
    signal?: AbortSignal,
  ): Promise<CanonicalFrameDiscovery & { deviceId: string }> {
    const canonical = await this.canonicalFrameDiscovery(
      platform,
      await this.ports.listBootedDevicesForIdeAction(platform, serial, signal),
      serial,
    );
    return { devices: canonical.devices, deviceId: canonical.deviceId ?? serial };
  }

  /**
   * The ONE place a direct frame's discovery rows and `deviceId` become the pool's canonical ids
   * (#11596). Every `input/*` and `ide/*` handler resolves its target through here before any
   * holder, broker binding or admission decision. A no-op in direct mode, where there is no pool.
   */
  async canonicalFrameDiscovery(
    platform: "android" | "ios",
    rawDevices: readonly BootedDevice[],
    deviceId: string | undefined,
  ): Promise<CanonicalFrameDiscovery> {
    return await canonicalizeFrameDiscovery(
      this.ports.daemonState().isInitialized()
        ? this.ports.daemonState().getDevicePool()
        : undefined,
      platform,
      rawDevices,
      deviceId,
    );
  }

  /** Refuse unresolved control only when its target could alias a held device; see the helper. */
  async assertFrameTargetProven(
    device: BootedDevice,
    action: string,
    requester?: () => string | undefined,
  ): Promise<void> {
    if (!this.ports.daemonState().isInitialized()) {
      return;
    }
    const sessionManager = this.ports.daemonState().getSessionManager();
    await assertFrameTargetIdentityProven(
      this.ports.daemonState().getDevicePool(),
      device,
      action,
      Boolean(sessionManager.getSessionForDevice?.(device.deviceId)),
      {
        sessions: frameHeldSessionsFrom(sessionManager),
        requester,
        sessionManager,
      },
    );
  }

  /** A frame's device id as the pool's canonical id, for lookups that run without a discovery. */
  canonicalFrameDeviceId(deviceId: string): string {
    return canonicalFrameDeviceId(
      this.ports.daemonState().isInitialized()
        ? this.ports.daemonState().getDevicePool()
        : undefined,
      deviceId,
    );
  }

  /**
   * Resolve the platform-appropriate storage-mutation client for a key-value
   * `ide/*` request. iOS Storage-facet edits carry `platform: "ios"` so the pane
   * targets the iOS simulator + IOSCtrlProxyClient; a missing platform defaults
   * to Android for backward compatibility with older desktop clients (#4708).
   */
  private async resolveKeyValueMutationClient(
    platformValue: string | undefined,
    deviceId: string,
    request: DaemonRequest,
    { action, ideMutation }: { action: string; ideMutation?: IdeMutationCall },
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
      await this.ports.resolveIdeActionDevices(platform, deviceId, ideMutation?.signal);
    // FUNNEL 1 then FUNNEL 2: reconcile before addressing the serial.
    await this.ports.reconcileDiscoveryObservation(bootedDevices, "socket:ide/keyValueMutation");
    this.ports.assertDeviceActionable(canonicalDeviceId, "to mutate stored values");
    const targetDevice = bootedDevices.find((d) => d.deviceId === canonicalDeviceId);
    if (!targetDevice) {
      throw new Error(`Device not found: ${deviceId}`);
    }
    await this.assertIdeMutationOwnership(request, targetDevice, action, { ideMutation });
    ideMutation?.signal.throwIfAborted();
    const client =
      platform === "ios"
        ? IOSCtrlProxyClient.getInstance(targetDevice)
        : AndroidCtrlProxyClient.getInstance(targetDevice, this.ports.adbClientFactory());
    return { platform, client, device: targetDevice };
  }

  /**
   * Run a key-value mutation from an `ide/*` route through the shared SharedPreferences
   * inspection-disabled fallback (issue #6292). On Android, if the SDK ContentProvider path
   * is gated because inspection is disabled, this falls back to the same direct-file
   * `adb shell run-as` XML edit the MCP `setKeyValue`/`removeKeyValue`/`clearKeyValueFile`
   * tools use — so the desktop Storage pane can write/delete/clear even when inspection is
   * off, exactly like the MCP path. iOS has no on-device XML fallback, so `viaSdk` runs alone.
   * Stamps session use once: from the SDK successful-send hook, or immediately after the
   * fallback abort check before direct-file work. Connecting alone never stamps.
   * Returns the SDK resolution and whether the fallback ran, for store and warning reporting.
   */
  async runIdeKeyValueMutation(
    platform: "android" | "ios",
    device: BootedDevice,
    appId: string,
    mutation: {
      fileName: string;
      ideMutation: IdeMutationCall | undefined;
      viaSdk: (onDispatch: () => void) => Promise<PreferenceStoreResolution | void>;
      viaDirectFile: (adb: ReturnType<AdbClientFactory["create"]>) => Promise<void>;
    },
  ): Promise<{
    usedDirectFileFallback: boolean;
    resolution: PreferenceStoreResolution | undefined;
  }> {
    let dispatched = false;
    const { fileName } = mutation;
    const onDispatch = () => {
      if (dispatched) {
        return;
      }
      dispatched = true;
      mutation.ideMutation?.dispatching();
    };
    if (platform !== "android") {
      mutation.ideMutation?.signal.throwIfAborted();
      const resolution = (await mutation.viaSdk(onDispatch)) || undefined;
      return { usedDirectFileFallback: false, resolution };
    }
    let resolution: PreferenceStoreResolution | undefined;
    const result = await withAndroidSharedPreferencesInspectionFallback(
      appId,
      fileName,
      () => this.ports.adbClientFactory().create(device),
      async () => {
        mutation.ideMutation?.signal.throwIfAborted();
        resolution = (await mutation.viaSdk(onDispatch)) || undefined;
      },
      // The ide/* params carry no userId, so an ambiguous-user error cannot say "pass userId".
      (adb) => {
        mutation.ideMutation?.signal.throwIfAborted();
        onDispatch();
        return mutation.viaDirectFile(adb).catch(rethrowForRouteWithoutUserId);
      },
    );
    return { ...result, resolution };
  }
}
