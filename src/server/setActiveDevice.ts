import { mintedSession, type AcquisitionReceipt } from "../daemon/acquisitionReceipt";
import { DaemonState } from "../daemon/daemonState";
import type { DevicePool, PooledDevice } from "../daemon/devicePool";
import type { SessionManager } from "../daemon/sessionManager";
import type { DisplayInventoryProvider } from "../devices/DisplayInventoryProvider";
import type { BootedDevice, Platform, SomePlatform } from "../models";
import { ActionableError, toActionableError } from "../models/ActionableError";
import { DisplayPinNeedsSessionError } from "../models/PinnedDisplayError";
import { RealObserveScreen } from "../features/observe/ObserveScreen";
import { DeviceSessionManager, type DeviceReadyOptions } from "../devices/DeviceSessionManager";
import { logger } from "../utils/logger";
import {
  AndroidBootedDeviceDiscoveryIncompleteError,
  BootedDeviceDiscoveryIncompleteError,
} from "../models/BootedDeviceDiscoveryIncompleteError";
import {
  deviceListRefreshFailureMessage,
  type DevicePoolRefreshResult,
} from "../daemon/devicePoolRefresh";
import { discoverySourceFor, type DiscoverySource } from "../utils/discoverySource";
import { isIosUdid } from "../utils/ios-cmdline-tools/iosDeviceType";
import { isAndroidEmulatorSerial, isAndroidTransportAddressSerial } from "../utils/androidSerial";
import { createJSONToolResponse } from "../utils/toolUtils";
import {
  registerDirectSessionDevice,
  resolveDirectSessionDevice,
} from "./directSessionDeviceRegistry";
import { prepareSessionDisplayPin } from "./sessionDisplayPin";
import { deviceAssignedToOtherSessionError } from "../daemon/inputDeviceOwnership";
import { executionTracker } from "./executionTracker";
import { isClientCancelled } from "../utils/AbortContext";
import { acquireUndoneIfUndelivered } from "./undeliveredAcquisition";
import { getToolSelectionContext } from "../features/toolSelection/toolSelectionContext";
import { refuseControlOnForeignOwnedSession } from "./foreignOwnedSessionRefusal";

export interface SetActiveDeviceArgs {
  deviceId: string;
  platform?: Platform;
  display?: string | null;
}

interface HandlerArgs extends SetActiveDeviceArgs {
  sessionUuid?: string;
  __mcpSessionId?: string;
  __executionId?: string;
}

type ResumeCtrlProxy = (deviceId: string, platform: Platform) => Promise<void>;

/** The global device selection the sessionless path readies and pins. */
export interface LegacyDeviceSelection {
  getCurrentDevice(): BootedDevice | undefined;
  getCurrentPlatform(): Platform | undefined;
  ensureDeviceReady(
    platform: SomePlatform,
    providedDeviceId?: string,
    options?: DeviceReadyOptions,
  ): Promise<BootedDevice>;
  setExplicitDevicePin(device: BootedDevice): void;
}

interface SetActiveDeviceDependencies {
  displayInventory?: DisplayInventoryProvider;
  resumeCtrlProxy: ResumeCtrlProxy;
  /** Defaults to the process-wide DeviceSessionManager. */
  legacyDeviceSelection?: () => LegacyDeviceSelection;
}

/** Preserve the existing MCP-owned autolock resolution and explicit UUID precedence. */
function resolveAutolockSelection(args: HandlerArgs): string | undefined {
  const mcpSessionId = args.__mcpSessionId;
  if (!mcpSessionId || !DaemonState.getInstance().isInitialized()) {
    return undefined;
  }
  const pool = DaemonState.getInstance().getDevicePool();
  const ownedSession = pool.resolveAutolockSessionForMcpSession(
    mcpSessionId,
    args.platform,
    undefined,
    args.deviceId,
  );
  // #11167: without an explicit platform the pooled device names it. The default-session
  // fallback must stay on that platform; a session is never rebound across platforms.
  const fallbackPlatform = args.platform ?? pool.getDevice(args.deviceId)?.platform;
  const targetSession =
    ownedSession ?? pool.resolveAutolockSessionForMcpSession(mcpSessionId, fallbackPlatform);
  args.sessionUuid ??= targetSession;
  return targetSession === args.sessionUuid ? targetSession : undefined;
}

/**
 * #11167, #11344: sharing a session needs its owner to release it first. Naming a session another
 * connected client owns is refused, typed, before anything is selected or rebound, with autolock
 * on or off: otherwise the caller could move that client's session to another device and adopt it
 * as its own default. The refusal is the one every other tool gives (#11647): its evidence is the
 * device the SESSION holds, never the requested target, which may be free.
 */
function refuseForeignOwnedSession(args: HandlerArgs): void {
  // #11469: a plan step or nested call carries no socket identity of its own and is judged as
  // the connection of the call that started it.
  const callerMcpSessionId = args.__mcpSessionId ?? getToolSelectionContext()?.callerMcpSessionId;
  refuseControlOnForeignOwnedSession("setActiveDevice", args.sessionUuid, callerMcpSessionId);
}

/**
 * The discovery sources that could have listed `deviceId`. The requested platform decides when
 * given; otherwise the id's shape does: an iOS UDID is listed only by its iOS source, an adb
 * emulator serial or transport address only by adb. Any other id could be either platform's.
 */
function sourcesThatCouldList(deviceId: string, platform: Platform | undefined): DiscoverySource[] {
  if (platform !== undefined) {
    return [discoverySourceFor(platform, deviceId)];
  }
  if (isIosUdid(deviceId)) {
    return [discoverySourceFor("ios", deviceId)];
  }
  if (isAndroidEmulatorSerial(deviceId) || isAndroidTransportAddressSerial(deviceId)) {
    return ["android"];
  }
  return ["android", "ios-simulator", "ios-physical"];
}

/**
 * The typed retryable refusal for a refresh that could not have seen `deviceId` (#11511), by the
 * platform whose discovery failed (#11586). Undefined when every source that could have listed
 * the device completed: a failure of an unrelated platform's discovery does not make the device's
 * absence unknown, so it is simply not found.
 */
function discoveryIncompleteFor(
  outcome: DevicePoolRefreshResult,
  deviceId: string,
  platform: Platform | undefined,
): BootedDeviceDiscoveryIncompleteError | undefined {
  const sources = sourcesThatCouldList(deviceId, platform);
  const failedSources = outcome.failedSources;
  let source: DiscoverySource | undefined;
  let reason: string | undefined;
  if (failedSources) {
    source = sources.find((candidate) => failedSources[candidate] !== undefined);
    reason = source ? failedSources[source]?.message : undefined;
  } else {
    // The refresh threw before its cause was attributed to a source, so it may have hidden any.
    source = sources[0];
    reason = outcome.failure;
  }
  if (source === undefined || reason === undefined) {
    return undefined;
  }
  const message = deviceListRefreshFailureMessage(reason);
  return source === "android"
    ? new AndroidBootedDeviceDiscoveryIncompleteError(failedSources?.[source], message)
    : new BootedDeviceDiscoveryIncompleteError("ios", failedSources?.[source], message);
}

async function requestedPoolDevice(
  pool: DevicePool,
  deviceId: string,
  platform: Platform | undefined,
): Promise<PooledDevice> {
  let device = pool.getDevice(deviceId);
  if (!device) {
    const outcome = await pool.refreshDevicesWithOutcome();
    device = pool.getDevice(deviceId);
    const discoveryIncomplete = device
      ? undefined
      : discoveryIncompleteFor(outcome, deviceId, platform);
    if (discoveryIncomplete) {
      throw discoveryIncomplete;
    }
  }
  if (!device) {
    throw new ActionableError(`Device '${deviceId}' not found in device pool`);
  }
  return device;
}

function assertDeviceOwner(input: {
  device: PooledDevice;
  sessionUuid: string;
  sessions: SessionManager;
}): void {
  const { device, sessionUuid, sessions } = input;
  if (
    device.sessionId &&
    device.sessionId !== sessionUuid &&
    sessions.getSession(device.sessionId)
  ) {
    throw deviceAssignedToOtherSessionError(device.id, device.sessionId, sessionUuid);
  }
}

async function bindRequestedDevice(input: {
  args: HandlerArgs & { sessionUuid: string };
  device: PooledDevice;
  pool: DevicePool;
  sessions: SessionManager;
  receipt: AcquisitionReceipt;
  rememberPrior: (prior: PriorSelection) => void;
}): Promise<void> {
  const { args, device, pool, sessions, receipt } = input;
  const existing = sessions.getSession(args.sessionUuid);
  if (existing?.assignedDevice === args.deviceId) {
    return;
  }
  if (existing?.assignedDevice) {
    input.rememberPrior({
      sessionUuid: args.sessionUuid,
      deviceId: existing.assignedDevice,
      displayPin: existing.cacheData.displayPin,
    });
  }
  if (existing && existing.platform !== device.platform) {
    throw new ActionableError(
      `Session ${args.sessionUuid} is a ${existing.platform} session and cannot be rebound to ` +
        `${device.platform} device '${args.deviceId}'. Start or select a ${device.platform} ` +
        `session for that device instead.`,
    );
  }
  // The pool persists the replacement before releasing the previous binding.
  // #5870: infer platform from the resolved device when the caller omitted it.
  const boundSession = await pool.bindOrReuseDeviceSession(
    args.sessionUuid,
    args.deviceId,
    args.platform ?? device.platform,
    undefined,
    undefined,
    undefined,
    true,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    // Records the move (or the mint), so a call cancelled before it answers is undone (#11593).
    receipt,
  );
  if (boundSession !== args.sessionUuid) {
    throw deviceAssignedToOtherSessionError(args.deviceId, boundSession, args.sessionUuid);
  }
  const minted = existing ? null : sessions.getSession(args.sessionUuid);
  if (minted) {
    // The pool leaves a rebind's session to its caller: this call created it, so a call
    // cancelled before it answers releases it again. The client chose the id and may retry it.
    receipt.minted = mintedSession(minted, args.deviceId, true);
  }
  sessions.setDeviceReadiness(args.sessionUuid, "booted");
}

/** Where a session was bound, and its display pin, before a selection that may be undone. */
type PriorSelection = { sessionUuid: string; deviceId: string; displayPin: string | undefined };

/**
 * A rebind drops the session's display pin, and the selection may have set a new one. Once a
 * cancelled selection is undone and the session is back on its device, it gets its pin back too.
 */
function restorePriorDisplayPin(prior: PriorSelection | undefined): void {
  if (!prior || !DaemonState.getInstance().isInitialized()) {
    return;
  }
  const sessions = DaemonState.getInstance().getSessionManager();
  if (
    sessions.getSession(prior.sessionUuid)?.assignedDevice === prior.deviceId &&
    sessions.getDisplayPin(prior.sessionUuid) !== prior.displayPin
  ) {
    sessions.setDisplayPin(prior.sessionUuid, prior.displayPin ?? null);
  }
}

async function selectSessionDevice(input: {
  args: HandlerArgs & { sessionUuid: string };
  dependencies: SetActiveDeviceDependencies;
  receipt: AcquisitionReceipt;
  signal: AbortSignal | undefined;
  rememberPrior: (prior: PriorSelection) => void;
}): Promise<boolean> {
  const { args, dependencies, receipt, signal, rememberPrior } = input;
  const sessions = DaemonState.getInstance().getSessionManager();
  const pool = DaemonState.getInstance().getDevicePool();
  const device = await requestedPoolDevice(pool, args.deviceId, args.platform);
  const hadDisplayPin = sessions.getDisplayPin(args.sessionUuid) !== undefined;
  const displayPin =
    args.display === undefined
      ? undefined
      : await prepareSessionDisplayPin({
          display: args.display,
          device: { deviceId: device.id, name: device.name, platform: device.platform },
          identityToken: `${device.incarnation}:${device.name}`,
          inventory: dependencies.displayInventory,
        });
  pool.assertDeviceCleanupComplete(args.deviceId);
  await dependencies.resumeCtrlProxy(args.deviceId, device.platform);
  assertDeviceOwner({ device, sessionUuid: args.sessionUuid, sessions });
  // A request cancelled before the bind changes nothing.
  signal?.throwIfAborted();
  await bindRequestedDevice({ args, device, pool, sessions, receipt, rememberPrior });
  if (displayPin !== undefined) {
    sessions.setDisplayPin(args.sessionUuid, displayPin);
  }
  logger.info(`[setActiveDevice] Bound device ${args.deviceId} to session ${args.sessionUuid}`);
  return args.display !== undefined || hadDisplayPin;
}

/**
 * In daemon mode a sessionless selection of a device another session holds (a live bound session
 * or an autolock owner) is refused before readiness touches it (#11071): readiness would set up
 * CtrlProxy, appearance and settings on the holder's device and make it the global pin. The
 * holder's own connection adopts its session instead (#10994). A selection admitted on a free
 * device is marked as sessionless device use, so a session acquiring the device mid-call cancels
 * it (#10829).
 */
function admitSessionlessSelection(args: HandlerArgs): void {
  const daemonState = DaemonState.getInstance();
  if (args.sessionUuid || !daemonState.isInitialized()) {
    return;
  }
  const pool = daemonState.getDevicePool();
  const sessions = daemonState.getSessionManager();
  const boundHolder = sessions.getSessionForDevice(args.deviceId);
  const liveHolder =
    (boundHolder && sessions.getSession(boundHolder) ? boundHolder : undefined) ??
    pool.getDevice(args.deviceId)?.autolockSessionId;
  if (liveHolder) {
    const ownSession = pool.resolveOwnedDeviceSessionForMcpSession(
      args.__mcpSessionId,
      args.deviceId,
    );
    if (ownSession) {
      args.sessionUuid = ownSession;
      return;
    }
    if (args.display !== undefined) {
      // A display pin needs a session regardless of who holds the device.
      throw new DisplayPinNeedsSessionError();
    }
    throw deviceAssignedToOtherSessionError(args.deviceId, liveHolder, undefined);
  }
  if (args.__executionId && args.display === undefined) {
    executionTracker.markSessionlessDeviceUse(args.__executionId, args.deviceId);
  }
}

async function selectLegacyDevice(input: {
  args: HandlerArgs;
  resumeCtrlProxy: ResumeCtrlProxy;
  sessions: LegacyDeviceSelection;
  signal?: AbortSignal;
}): Promise<void> {
  const { args, resumeCtrlProxy, sessions, signal } = input;
  const previousDevice = sessions.getCurrentDevice();
  const previousPlatform = sessions.getCurrentPlatform();
  // #5870: "either" lets deviceId disambiguate when platform is omitted.
  const readyDevice = await sessions.ensureDeviceReady(
    args.platform ?? "either",
    args.deviceId,
    signal ? { signal } : undefined,
  );
  // A session that acquired the device during readiness cancelled this call: never pin its device.
  signal?.throwIfAborted();
  const resolvedPlatform = args.platform ?? readyDevice.platform;
  await resumeCtrlProxy(readyDevice.deviceId, resolvedPlatform);
  signal?.throwIfAborted();
  if (args.sessionUuid && resolveDirectSessionDevice(args.sessionUuid)) {
    registerDirectSessionDevice(args.sessionUuid, readyDevice);
  }
  if (previousPlatform && previousPlatform !== resolvedPlatform && previousDevice) {
    logger.info(
      `[setActiveDevice] Platform switch detected (${previousPlatform} -> ${resolvedPlatform}), ` +
        `clearing observation cache for previous device ${previousDevice.deviceId}`,
    );
    RealObserveScreen.clearCache(previousDevice.deviceId);
  }
  sessions.setExplicitDevicePin(readyDevice);
}

function currentDisplayPinResult(input: { sessionUuid?: string; reportClearedPin: boolean }): {
  displayPin?: string | null;
} {
  if (!input.sessionUuid || !DaemonState.getInstance().isInitialized()) {
    return {};
  }
  const pin = DaemonState.getInstance().getSessionManager().getDisplayPin(input.sessionUuid);
  return pin !== undefined || input.reportClearedPin ? { displayPin: pin ?? null } : {};
}

/** Existing device selection with a session-only, side-effect-free display selection slot. */
export function createSetActiveDeviceHandler(dependencies: SetActiveDeviceDependencies) {
  const legacyDeviceSelection =
    dependencies.legacyDeviceSelection ?? (() => DeviceSessionManager.getInstance());
  return async (args: HandlerArgs, _progress?: unknown, signal?: AbortSignal) => {
    const mcpSessionId = args.__mcpSessionId;
    let prior: PriorSelection | undefined;
    try {
      const selectedAutolockSession = resolveAutolockSelection(args);
      refuseForeignOwnedSession(args);
      admitSessionlessSelection(args);
      const sessionUuid = args.sessionUuid;
      const sessionScoped = Boolean(sessionUuid) && DaemonState.getInstance().isInitialized();
      if (args.display !== undefined && !sessionScoped) {
        throw new DisplayPinNeedsSessionError();
      }
      const select = async (receipt: AcquisitionReceipt) => {
        let reportClearedPin = false;
        if (sessionScoped && sessionUuid) {
          reportClearedPin = await selectSessionDevice({
            args: { ...args, sessionUuid },
            dependencies,
            receipt,
            signal,
            rememberPrior: (selection) => {
              prior = selection;
            },
          });
        } else {
          await selectLegacyDevice({
            args,
            resumeCtrlProxy: dependencies.resumeCtrlProxy,
            sessions: legacyDeviceSelection(),
            signal,
          });
        }
        if (selectedAutolockSession) {
          await DaemonState.getInstance()
            .getDevicePool()
            .attachAutolockSessionToMcpSession(selectedAutolockSession, mcpSessionId, true, true);
        }
        const payload = {
          message: `Active device set to '${args.deviceId}'`,
          deviceId: args.deviceId,
          ...(args.sessionUuid ? { sessionUuid: args.sessionUuid } : {}),
          ...currentDisplayPinResult({ sessionUuid: args.sessionUuid, reportClearedPin }),
        };
        return createJSONToolResponse(payload);
      };
      if (!sessionScoped || !sessionUuid) {
        // A legacy selection binds no session, so there is nothing a cancellation leaves behind.
        return await select({});
      }
      // A session-scoped selection cancelled before it answers leaves the session where it was:
      // moved back to the device it held, or released when this call minted it (#11593).
      return await acquireUndoneIfUndelivered(signal, select);
    } catch (error) {
      if (isClientCancelled(signal)) {
        restorePriorDisplayPin(prior);
      }
      logger.error("Failed to set active device:", error);
      throw toActionableError(error, "Failed to set active device");
    }
  };
}
