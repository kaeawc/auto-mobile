import { ActionableError } from "../models/ActionableError";
import type { BootedDevice } from "../models";
import { AndroidCtrlProxyClient } from "../features/observe/android";
import { IOSCtrlProxyClient } from "../features/observe/ios";
import { LEGACY_PROVENANCE_SENTINEL } from "../features/navigation/NavigationGraphManager";
import type { NavigationGraphStreamSource } from "../features/navigation/NavigationGraphStreamSource";
import { resolveToolSelectionBaseSessionUuid } from "../features/toolSelection/selectionSessionResolver";
import { errorMessage } from "../utils/describeUnknownError";
import { logger } from "../utils/logger";
import { DeviceOwnedByOtherDaemonError } from "../models/deviceAcquisitionRefusals";
import { holderOf } from "./deviceBinding";
import type { DeviceDataStreamSocketServer } from "./deviceDataStreamSocketServer";
import type { PooledDevice } from "./devicePool";
import {
  assertControlNotOnForeignDaemonDevice,
  assertInputNotOnForeignBindingDevice,
} from "./inputDeviceOwnership";
import {
  convertSummaryToStreamData,
  createNavigationGraphRequestHandler,
} from "./navigationGraphRequestHandler";
import type { ObservationStreamIosClient } from "./observationInitialFrame";
import { DeviceAssignedToBindingError } from "./sessionBroker/provisioning/refusal";
import { createDefaultStreamSocketAuthenticator } from "./streamSocketAuth";
import { ENV } from "../config/env";

/**
 * Observation-stream routing split out of daemon.ts (#11808): the navigation-graph push bridge, the
 * "who holds this device" classification behind read-only observations, storage-subscription
 * expansion and the iOS CtrlProxy adapter. Each piece reads the daemon only through the narrow
 * interfaces below, so it is unit-testable with fakes.
 */

/** Completes the FUNNEL 2 refusal: "Refusing `<purpose>` on device '<serial>'". */
const STORAGE_WATCH_PURPOSE = "to watch stored values";

/** What the bridge pushes through; the observation stream server satisfies it. */
export type NavigationGraphPushTarget = Pick<
  DeviceDataStreamSocketServer,
  "pushBuildContextUpdate" | "pushNavigationGraphUpdate" | "setOnNavigationGraphRequested"
>;

/** The manager surface the bridge uses; the real managers satisfy it. */
export type NavigationGraphBridgeSource = Pick<
  NavigationGraphStreamSource,
  | "getBuildContexts"
  | "setBuildContextUpdateListener"
  | "setGraphUpdateListener"
  | "exportGraphSummary"
  | "exportGraphSummaryForApp"
  | "getDeviceIdForApp"
>;

export interface NavigationGraphStreamBridgeDeps {
  /** The current stream server; health recovery replaces it, so read it per use. */
  server(): NavigationGraphPushTarget | null | undefined;
  sessionIds(): readonly string[];
  defaultManager(): NavigationGraphBridgeSource;
  managerForSession(sessionId: string): NavigationGraphBridgeSource;
}

/**
 * Wires navigation-graph and build-context changes to the observation stream. The two weak
 * registries cache callback identity per manager and per server so rebinding is idempotent and a
 * released or replaced owner is ignored.
 */
export class NavigationGraphStreamBridge {
  /** Managers with a live listener; also read by session-lifecycle wiring to detect release. */
  readonly listenerManagers = new WeakSet<NavigationGraphBridgeSource>();
  private readonly seededStreamManagers = new WeakMap<
    NavigationGraphPushTarget,
    WeakSet<NavigationGraphBridgeSource>
  >();

  constructor(private readonly deps: NavigationGraphStreamBridgeDeps) {}

  /**
   * Set up listener for navigation graph changes.
   * When the navigation graph changes, push updates to all subscribed IDE plugins.
   */
  listen(server: NavigationGraphPushTarget | null | undefined): void {
    if (!server) {
      return;
    }

    this.attach(this.deps.defaultManager());
    for (const sessionId of this.deps.sessionIds()) {
      this.attach(this.deps.managerForSession(sessionId));
    }

    // Requests retain the legacy unattributed graph behavior. Live graph changes
    // above are also wired to each active session manager, which is where tool
    // execution records navigation state.
    server.setOnNavigationGraphRequested(
      createNavigationGraphRequestHandler({
        exportGraphSummary: () => this.resolveUnscopedManager().exportGraphSummary(),
        exportGraphSummaryForApp: (appId) =>
          this.resolveUnscopedManager().exportGraphSummaryForApp(appId),
      }),
    );

    logger.info("[Daemon] Navigation graph stream listener configured");
  }

  private resolveUnscopedManager(): NavigationGraphBridgeSource {
    const sessionIds = this.deps.sessionIds();
    return sessionIds.length === 1
      ? this.deps.managerForSession(sessionIds[0]!)
      : this.deps.defaultManager();
  }

  attach(navGraphManager: NavigationGraphBridgeSource): void {
    const streamServer = this.deps.server();
    if (streamServer && !this.seededStreamManagers.get(streamServer)?.has(navGraphManager)) {
      const seededManagers =
        this.seededStreamManagers.get(streamServer) ?? new WeakSet<NavigationGraphBridgeSource>();
      seededManagers.add(navGraphManager);
      this.seededStreamManagers.set(streamServer, seededManagers);
      for (const context of navGraphManager.getBuildContexts()) {
        if (context.deviceId !== LEGACY_PROVENANCE_SENTINEL) {
          streamServer.pushBuildContextUpdate(context.deviceId, context.appId, {
            packageId: context.appId,
            versionCode: context.versionCode,
            ...(context.versionKey === undefined ? {} : { versionKey: context.versionKey }),
            contentHash: context.contentHash,
          });
        }
      }
    }
    if (this.listenerManagers.has(navGraphManager)) {
      return;
    }
    this.listenerManagers.add(navGraphManager);
    navGraphManager.setBuildContextUpdateListener(({ appId, deviceId, buildContext }) => {
      if (!this.listenerManagers.has(navGraphManager) || deviceId === LEGACY_PROVENANCE_SENTINEL) {
        return;
      }
      this.deps.server()?.pushBuildContextUpdate(
        deviceId,
        appId,
        buildContext === null
          ? null
          : {
              packageId: appId,
              versionCode: buildContext.versionCode,
              ...(buildContext.versionKey === undefined
                ? {}
                : { versionKey: buildContext.versionKey }),
              contentHash: buildContext.contentHash,
            },
      );
    });
    navGraphManager.setGraphUpdateListener(async () => {
      logger.info("[Daemon] Navigation graph listener triggered, exporting summary...");
      try {
        const summary = await navGraphManager.exportGraphSummary();
        if (!this.listenerManagers.has(navGraphManager)) {
          logger.debug("[Daemon] Ignoring navigation update from a released or rebound session");
          return;
        }
        logger.info(
          `[Daemon] Got summary: appId=${summary.appId}, nodes=${summary.nodes.length}, edges=${summary.edges.length}`,
        );

        const streamData = convertSummaryToStreamData(summary);
        // Attribute the update to the device that owns this app's graph so panes
        // watching other devices are not cross-contaminated (epic #5256; #4837).
        const deviceId = navGraphManager.getDeviceIdForApp(summary.appId);
        this.deps.server()?.pushNavigationGraphUpdate(streamData, deviceId);

        logger.info(
          `[Daemon] Pushed navigation graph update: ${summary.nodes.length} nodes, ${summary.edges.length} edges`,
        );
      } catch (error) {
        logger.warn(`[Daemon] Failed to push navigation graph update: ${error}`);
      }
    });
  }
}

export function logSkippedObservationStreamDevice(
  platform: "android" | "ios",
  deviceId: string,
  action: string,
): void {
  const optInEnv =
    platform === "android"
      ? ENV.ANDROID_OBSERVATION_STREAM_DEVICES.name
      : ENV.IOS_WARMUP_DEVICES.name;
  logger.info(
    `[Daemon] Skipping observation-stream ${action} for ${platform} device ${deviceId}: passive-work policy filtered it; set ${optInEnv} to opt in`,
  );
}

export interface SessionHolderLookupDeps {
  sessionManager: Parameters<typeof resolveToolSelectionBaseSessionUuid>[1] & {
    getSessionForDevice(deviceId: string): string | null | undefined;
  };
  devicePool: { getDevice(deviceId: string): Pick<PooledDevice, "sessionId"> | null | undefined };
}

export interface DeviceHolderLookupDeps {
  sessionManager: Parameters<typeof resolveToolSelectionBaseSessionUuid>[1] &
    Parameters<typeof assertInputNotOnForeignBindingDevice>[0]["sessionManager"] & {
      getSessionForDevice(deviceId: string): string | null | undefined;
    };
  devicePool: Parameters<typeof assertInputNotOnForeignBindingDevice>[0]["gate"] &
    Parameters<typeof assertControlNotOnForeignDaemonDevice>[0]["gate"] & {
      getDevice(deviceId: string): PooledDevice | null | undefined;
    };
}

/**
 * Whether a device is held by a session other than the requester's (a derived
 * `${base}:${label}` session counts as its base). Such a requester only watches it (#10967).
 */
export function isHeldByAnotherSession(
  deps: SessionHolderLookupDeps,
  deviceId: string,
  requesterSessionUuid?: string,
): boolean {
  const holder =
    deps.sessionManager.getSessionForDevice(deviceId) ??
    holderOf(deps.devicePool.getDevice(deviceId));
  if (!holder) {
    return false;
  }
  const base = (sessionUuid: string | undefined) =>
    resolveToolSelectionBaseSessionUuid(sessionUuid, deps.sessionManager);
  return base(holder) !== base(requesterSessionUuid?.trim() || undefined);
}

/**
 * Whether anyone but the requester holds the device, for classifying a READ: another local
 * session, a broker binding (idle or not, unless the requester is the binding's execution), or
 * another daemon's claim. Such a request is downgraded to the connect-only read, never refused.
 * An ownership state that cannot be read counts as held: a read must not risk a rebind on a
 * device that may belong to someone else. The checks reuse the pool's own gates and their
 * one-second snapshots, so an observation adds no cross-daemon round trip beyond them.
 */
export async function isHeldByAnotherOwner(
  deps: DeviceHolderLookupDeps,
  pooledDevice: PooledDevice,
  requesterSessionUuid?: string,
): Promise<boolean> {
  const deviceId = pooledDevice.id;
  if (isHeldByAnotherSession(deps, deviceId, requesterSessionUuid)) {
    return true;
  }
  if (deps.sessionManager.getSessionForDevice(deviceId) ?? holderOf(pooledDevice)) {
    // The requester's own session holds it; the pool's gates govern others, not the holder.
    return false;
  }
  const platform = pooledDevice.platform;
  const requester = requesterSessionUuid?.trim() || undefined;
  try {
    await assertInputNotOnForeignBindingDevice({
      action: "observe",
      deviceId,
      platform,
      requesterSessionUuid: requester,
      sessionManager: deps.sessionManager,
      gate: deps.devicePool,
    });
    await assertControlNotOnForeignDaemonDevice({
      deviceId,
      platform,
      gate: deps.devicePool,
    });
    return false;
  } catch (error) {
    if (
      error instanceof DeviceAssignedToBindingError ||
      error instanceof DeviceOwnedByOtherDaemonError
    ) {
      // A broker binding or another daemon holds the device: an expected verdict, so the read is
      // downgraded to connect-only rather than refused.
      logger.debug(`[Daemon] observation of ${deviceId} is read-only: ${errorMessage(error)}`);
    } else {
      // Unknown ownership is treated as held; the trace says why the read was downgraded.
      logger.warn(
        `[Daemon] ownership of ${deviceId} unreadable; observation is read-only: ${errorMessage(error)}`,
        error,
      );
    }
    return true;
  }
}

export interface StorageSubscriptionDeps {
  devicePool: {
    getAllDevices(): readonly PooledDevice[];
    assertDeviceActionable(deviceId: string, purpose: string): void;
  };
}

export interface StorageSubscriptionRequest {
  deviceId: string | null;
  sessionUuid?: string;
  packageName: string;
  fileName: string;
  subscribe: boolean;
}

/**
 * Expand one storage (un)subscription to the devices it targets and apply it.
 *
 * FUNNEL 2 for every target the expansion produces. A request that scopes
 * itself to a serial is already refused at the socket server, but an
 * ALL-DEVICE request names no serial at all, so nothing there can preflight it
 * — and `deviceId === null` means every pooled Android device here. Gating each
 * expanded target is what stops the request from installing a content observer
 * on whichever replacement AVD now answers on a quarantined serial and still
 * acking success. The refusals are collected rather than thrown at the first
 * one, so a healthy device still gets its observer and the caller learns which
 * targets the request could not cover -- the same partial-completion shape the
 * all-device observation path uses
 * ([#6888](https://github.com/kaeawc/auto-mobile/pull/6888) review).
 *
 * Teardown is exempt, as it is at the socket server: refusing it would strand
 * the observer this daemon registered, and releasing one touches only
 * bookkeeping the quarantine does not question.
 */
export async function applyStorageSubscriptionRequest(
  deps: StorageSubscriptionDeps,
  { deviceId, sessionUuid, packageName, fileName, subscribe }: StorageSubscriptionRequest,
): Promise<void> {
  const devices = deps.devicePool
    .getAllDevices()
    .filter((device) => deviceId === null || device.id === deviceId);
  const refusals: string[] = [];
  const authenticator = createDefaultStreamSocketAuthenticator("observationStream", {
    allowObserverSessions: true,
  });
  for (const device of devices) {
    if (device.platform !== "android") {
      continue;
    }
    try {
      // Watching stored values is a read: a held device admits any live identity (#10830).
      authenticator.authorize({ sessionUuid, deviceId: device.id, admitViewer: true });
    } catch (error) {
      refusals.push(errorMessage(error));
      continue;
    }
    if (subscribe) {
      try {
        deps.devicePool.assertDeviceActionable(device.id, STORAGE_WATCH_PURPOSE);
      } catch (error) {
        refusals.push(errorMessage(error));
        continue;
      }
    }
    const client = AndroidCtrlProxyClient.getExistingInstance(device.id);
    if (!client) {
      continue;
    }
    if (subscribe) {
      await client.subscribeStorage(packageName, fileName);
    } else {
      await client.unsubscribeStorage(`${packageName}:${fileName}`);
    }
  }
  if (refusals.length > 0) {
    throw new ActionableError(refusals.join("; "));
  }
}

export function createObservationStreamIosClient(
  device: BootedDevice,
  currentServer: () => Pick<DeviceDataStreamSocketServer, "getHierarchyIntervalMsForDevice"> | null,
): ObservationStreamIosClient {
  const client = IOSCtrlProxyClient.getInstance(device);
  return {
    ensureConnected: async () => {
      const connected = await client.ensureConnected();
      const server = currentServer();
      if (connected && server) {
        client.refreshObservationStreamHierarchyCadence(
          server.getHierarchyIntervalMsForDevice(device.deviceId),
        );
      }
      return connected;
    },
    getLatestHierarchy: (...args) => client.getLatestHierarchy(...args),
    requestHierarchySyncWithoutObservationStreamPush: async (...args) => {
      const result = await client.requestHierarchySyncWithoutObservationStreamPush(...args);
      return result
        ? {
            hierarchy: result.hierarchy,
            ...(result.frameContext === undefined ? {} : { frameContext: result.frameContext }),
          }
        : null;
    },
    convertToViewHierarchyResult: (hierarchy) =>
      client.convertToViewHierarchyResult(hierarchy as never),
    recordInitialObservationStreamHierarchy: (hierarchy, captureSequence) =>
      client.recordInitialObservationStreamHierarchy(hierarchy, captureSequence),
    requestScreenshotWithoutObservationStreamPush: (...args) =>
      client.requestScreenshotWithoutObservationStreamPush(...args),
  };
}
