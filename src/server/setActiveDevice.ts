import { internalMcpSessionId } from "./internalToolParams";
import { holderOf } from "../daemon/deviceBinding";
import { RunnerReadinessError } from "../ctrlProxy/RunnerReadinessService";
import type { AcquisitionReceipt } from "../daemon/acquisitionReceipt";
import { defaultDaemonContext, type DaemonContext } from "../daemon/daemonContext";
import type { DevicePool, PooledDevice } from "../daemon/devicePool";
import type { SessionManager } from "../daemon/sessionManager";
import { TransitionalAdbBindWait } from "../daemon/transitionalAdbBindWait";
import type { DisplayInventoryProvider } from "../devices/DisplayInventoryProvider";
import type { PlatformDeviceManager } from "../devices/deviceUtils";
import type { BootedDevice, Platform, SomePlatform } from "../models";
import { ActionableError, toActionableError } from "../models/ActionableError";
import { DisplayPinNeedsSessionError } from "../models/PinnedDisplayError";
import { DirectSessionNotActiveError } from "../models/DirectSessionNotActiveError";
import { RealObserveScreen } from "../features/observe/ObserveScreen";
import type { DeviceReadyOptions } from "../daemon/readiness/DeviceReadiness";
import { logger } from "../utils/logger";
import { defaultTimer, type Timer } from "../utils/SystemTimer";
import { resetAdbDeviceListCache } from "../utils/android-cmdline-tools/AdbClient";
import { PlatformDeviceManagerFactory } from "../utils/factories/PlatformDeviceManagerFactory";
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
import { createStructuredToolResponse } from "../utils/toolUtils";
import {
  registerDirectSessionDevice,
  resolveDirectSessionDevice,
} from "../utils/directSessionDeviceRegistry";
import { prepareSessionDisplayPin } from "./sessionDisplayPin";
import {
  deviceAssignedToOtherSessionError,
  heldDeviceBindRefusal,
} from "../daemon/inputDeviceOwnership";
import { executionTracker } from "../daemon/executionTracker";
import { isTypedToolRefusal } from "../daemon/shapeToolCallError";
import { isClientCancelled } from "../utils/AbortContext";
import { acquireUndoneIfUndelivered } from "../daemon/acquisitionUndo";
import {
  currentExecution,
  getToolSelectionContext,
} from "../features/toolSelection/toolSelectionContext";
import { refuseControlOnForeignOwnedSession } from "./foreignOwnedSessionRefusal";
import { deviceConnectionIdFor } from "./deviceConnectionId";

export interface SetActiveDeviceArgs {
  deviceId: string;
  platform?: Platform;
  display?: string | null;
}

/** The handler's arguments; the in-band `__*` keys are read through `internalToolParams`. */
interface HandlerArgs extends SetActiveDeviceArgs {
  sessionUuid?: string;
  __mcpSessionId?: string;
}

type ResumeCtrlProxy = (deviceId: string, platform: Platform) => Promise<void>;

/** The legacy device selection the sessionless path readies and pins per connection. */
export interface LegacyDeviceSelection {
  getExplicitDevicePin(connectionId?: string): BootedDevice | undefined;
  ensureDeviceReady(
    platform: SomePlatform,
    providedDeviceId?: string,
    options?: DeviceReadyOptions,
  ): Promise<BootedDevice>;
  setExplicitDevicePin(device: BootedDevice, connectionId?: string): void;
}

interface SetActiveDeviceDependencies {
  displayInventory?: DisplayInventoryProvider;
  transportWait?: {
    timer: Timer;
    probe?: PlatformDeviceManager["getAndroidListedDeviceStates"];
    probeTimeoutMs?: number;
    invalidateDeviceList?: () => void;
  };
  resumeCtrlProxy: ResumeCtrlProxy;
  /** The process composition supplies readiness for legacy selection. */
  legacyDeviceSelection?: () => LegacyDeviceSelection;
}

/** The collaborators a registrar may inject into the setActiveDevice handler. */
export type SetActiveDeviceSeams = Pick<
  SetActiveDeviceDependencies,
  "displayInventory" | "legacyDeviceSelection"
>;

// Matches the pool's unexported ANDROID_OFFLINE_PROBE_TIMEOUT_MS.
const ANDROID_OFFLINE_PROBE_TIMEOUT_MS = 10_000;

type TransportAttempt = <T>(attempt: () => Promise<T>) => Promise<T>;

function transitionalTransportAttempt(
  args: HandlerArgs,
  dependencies: SetActiveDeviceDependencies,
  signal: AbortSignal | undefined,
): TransportAttempt {
  const ports = dependencies.transportWait;
  const wait = new TransitionalAdbBindWait(args.deviceId, {
    timer: ports?.timer ?? defaultTimer,
    probeTimeoutMs: ports?.probeTimeoutMs ?? ANDROID_OFFLINE_PROBE_TIMEOUT_MS,
    getSignal: () => signal,
    holdAbsenceAfterTransitional: true,
    probe: ports
      ? ports.probe
      : async (ids, options) => {
          const manager = PlatformDeviceManagerFactory.getInstance();
          return (await manager.getAndroidListedDeviceStates?.(ids, options)) ?? new Map();
        },
  });
  const isNonReadinessRefusal = (error: unknown): boolean =>
    isTypedToolRefusal(error) && !(error instanceof RunnerReadinessError);
  return async (attempt) => {
    for (;;) {
      try {
        return await attempt();
      } catch (error) {
        if (
          signal?.aborted ||
          args.platform === "ios" ||
          isIosUdid(args.deviceId) ||
          isNonReadinessRefusal(error) ||
          error instanceof DisplayPinNeedsSessionError ||
          !(await wait.waitIfTransitional())
        ) {
          throw error;
        }
        // Readiness uses the cached adb list; the recovered transport needs a fresh retry.
        (ports?.invalidateDeviceList ?? resetAdbDeviceListCache)();
      }
    }
  };
}

/** Preserve the existing MCP-owned autolock resolution and explicit UUID precedence. */
function resolveAutolockSelection(args: HandlerArgs): string | undefined {
  const mcpSessionId = internalMcpSessionId(args);
  const pool = mcpSessionId ? defaultDaemonContext.devicePool() : undefined;
  if (!mcpSessionId || !pool) {
    return undefined;
  }
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
  const callerMcpSessionId =
    internalMcpSessionId(args) ?? getToolSelectionContext()?.callerMcpSessionId;
  refuseControlOnForeignOwnedSession("setActiveDevice", args.sessionUuid, callerMcpSessionId);
  // #11235: a caller with no connection identity is not judged above, but a live autolock session
  // is owned by connection, so it is foreign to that caller too.
  if (
    !callerMcpSessionId &&
    args.sessionUuid &&
    defaultDaemonContext.devicePool()?.isSessionOwnedByOtherConnection(args.sessionUuid)
  ) {
    const sessionDevice = defaultDaemonContext
      .sessionManager()
      ?.getSession(args.sessionUuid)?.assignedDevice;
    throw deviceAssignedToOtherSessionError(
      sessionDevice ?? "unknown",
      args.sessionUuid,
      undefined,
    );
  }
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
  if (
    !device ||
    (device.platform === "watchos") !== (platform === "watchos") ||
    (device.platform === "tvos") !== (platform === "tvos")
  ) {
    // Non-iOS Apple simulators are selected only when the call names their platform.
    throw new ActionableError(
      `Device '${deviceId}' not found in device pool` +
        (device?.platform === "watchos"
          ? '; pass platform "watchos" to select an Apple Watch'
          : device?.platform === "tvos"
            ? '; pass platform "tvos" to select an Apple TV'
            : ""),
    );
  }
  return device;
}

function assertDeviceOwner(input: {
  device: PooledDevice;
  sessionUuid: string;
  sessions: SessionManager;
  pool: object;
}): void {
  const { device, sessionUuid, sessions, pool } = input;
  if (
    holderOf(device) &&
    holderOf(device) !== sessionUuid &&
    sessions.getSession(holderOf(device)!)
  ) {
    throw heldDeviceBindRefusal(pool, device.id, holderOf(device)!, {
      requesterSessionUuid: sessionUuid,
    });
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
  if (existing?.assignedDevice) {
    // Remembered for a selection of the device the session already holds too: nothing is
    // rebound then, but the selection may still replace the session's display pin.
    input.rememberPrior({
      sessionUuid: args.sessionUuid,
      deviceId: existing.assignedDevice,
      displayPin: existing.cacheData.displayPin,
    });
  }
  if (existing?.assignedDevice === args.deviceId) {
    return;
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
  if (!existing) {
    // This call mints the session under an id its client chose and will name again: from here
    // on a cancellation takes the session back without retiring the id, wherever it lands in
    // the mint (#11593).
    receipt.clientChosenSessionId = args.sessionUuid;
  }
  const boundSession = await pool.bindOrReuseDeviceSession({
    sessionId: args.sessionUuid,
    deviceId: args.deviceId,
    platform: args.platform ?? device.platform,
    allowSessionRebind: true,
    // Records the move (or the mint), so a call cancelled before it answers is undone (#11593).
    receipt,
    // Asked again under the pool's assignment mutex: a start may have reserved the device since.
    refusePreparedForOtherRequest: true,
  });
  if (boundSession !== args.sessionUuid) {
    throw heldDeviceBindRefusal(pool, args.deviceId, boundSession, {
      requesterSessionUuid: args.sessionUuid,
    });
  }
  sessions.setDeviceReadiness(args.sessionUuid, "booted");
}

/** Where a session was bound, and its display pin, before a selection that may be undone. */
type PriorSelection = { sessionUuid: string; deviceId: string; displayPin: string | undefined };

/**
 * A rebind drops the session's display pin, and the selection may have set a new one. Once a
 * cancelled selection is undone and the session is back on its device, it gets its pin back too.
 */
function restorePriorDisplayPin(
  prior: PriorSelection | undefined,
  daemon: DaemonContext = defaultDaemonContext,
): void {
  const sessions = prior ? daemon.sessionManager() : undefined;
  if (!prior || !sessions) {
    return;
  }
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
  transportAttempt: TransportAttempt;
}): Promise<boolean> {
  const { args, dependencies, receipt, signal, rememberPrior } = input;
  const sessions = defaultDaemonContext.requireSessionManager();
  const pool = defaultDaemonContext.requireFullDevicePool();
  const device = await input.transportAttempt(() =>
    requestedPoolDevice(pool, args.deviceId, args.platform),
  );
  // A device another request is still preparing is refused before anything touches it (#11651).
  pool.assertNotPreparedForOtherRequest(args.deviceId);
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
  // Refused before the resume: resuming re-arms the device's CtrlProxy restart budget and drops
  // its admitted attempt, which a caller that does not hold the device must not do (#11651).
  pool.assertNotPreparedForOtherRequest(args.deviceId);
  assertDeviceOwner({ device, sessionUuid: args.sessionUuid, sessions, pool });
  if (device.platform !== "tvos") {
    await dependencies.resumeCtrlProxy(args.deviceId, device.platform);
  }
  // Checked again: another session may have bound the device while the resume listed devices.
  assertDeviceOwner({ device, sessionUuid: args.sessionUuid, sessions, pool });
  // A request cancelled before the bind changes nothing.
  signal?.throwIfAborted();
  await bindRequestedDevice({ args, device, pool, sessions, receipt, rememberPrior });
  if (displayPin !== undefined) {
    sessions.setDisplayPin(args.sessionUuid, displayPin);
  }
  logger.info(`[setActiveDevice] Bound device ${args.deviceId} to session ${args.sessionUuid}`);
  return args.display !== undefined || hadDisplayPin;
}

function sessionlessDaemonReads() {
  const pool = defaultDaemonContext.devicePool();
  const sessions = defaultDaemonContext.sessionManager();
  return pool && sessions ? { pool, sessions } : undefined;
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
  const daemon = args.sessionUuid ? undefined : sessionlessDaemonReads();
  if (!daemon) {
    return;
  }
  const { pool, sessions } = daemon;
  const boundHolder = sessions.getSessionForDevice(args.deviceId);
  const liveHolder =
    (boundHolder && sessions.getSession(boundHolder) ? boundHolder : undefined) ??
    pool.getDevice(args.deviceId)?.autolockSessionId;
  if (liveHolder) {
    const ownSession = pool.resolveOwnedDeviceSessionForMcpSession(
      internalMcpSessionId(args),
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
    throw heldDeviceBindRefusal(pool, args.deviceId, liveHolder);
  }
  // No session holds it yet, but another request is preparing it and will bind it (#11651).
  pool.assertNotPreparedForOtherRequest(args.deviceId);
  if (args.display === undefined) {
    markSessionlessDeviceUse(args.deviceId);
  }
}

/** The current call now uses the device with no session, so an acquiring session cancels it. */
function markSessionlessDeviceUse(deviceId: string): void {
  const execution = currentExecution();
  if (execution) {
    executionTracker.markSessionlessDeviceUse(execution.executionId, deviceId);
  }
}

function assertNotPreparedForOtherRequest(deviceId: string): void {
  defaultDaemonContext.devicePool()?.assertNotPreparedForOtherRequest(deviceId);
}

async function selectLegacyDevice(input: {
  args: HandlerArgs;
  resumeCtrlProxy: ResumeCtrlProxy;
  sessions: LegacyDeviceSelection;
  signal?: AbortSignal;
  transportAttempt: TransportAttempt;
}): Promise<void> {
  const { args, resumeCtrlProxy, sessions, signal } = input;
  const connectionId = deviceConnectionIdFor(args);
  const previousDevice = sessions.getExplicitDevicePin(connectionId);
  const previousPlatform = previousDevice?.platform;
  // #5870: "either" lets deviceId disambiguate when platform is omitted.
  const readyDevice = await input.transportAttempt(() =>
    sessions.ensureDeviceReady(args.platform ?? "either", args.deviceId, {
      signal,
      connectionId,
    }),
  );
  // A session that acquired the device during readiness cancelled this call: never pin its device.
  signal?.throwIfAborted();
  assertNotPreparedForOtherRequest(readyDevice.deviceId);
  const resolvedPlatform = args.platform ?? readyDevice.platform;
  if ((readyDevice.platform === "tvos") !== (args.platform === "tvos")) {
    throw new ActionableError('Pass platform "tvos" to select an Apple TV');
  }
  if (resolvedPlatform !== "tvos") {
    await resumeCtrlProxy(readyDevice.deviceId, resolvedPlatform);
  }
  signal?.throwIfAborted();
  assertNotPreparedForOtherRequest(readyDevice.deviceId);
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
  sessions.setExplicitDevicePin(readyDevice, connectionId);
}

function currentDisplayPinResult(
  input: { sessionUuid?: string; reportClearedPin: boolean },
  daemon: DaemonContext = defaultDaemonContext,
): {
  displayPin?: string | null;
} {
  const sessions = input.sessionUuid ? daemon.sessionManager() : undefined;
  if (!input.sessionUuid || !sessions) {
    return {};
  }
  const pin = sessions.getDisplayPin(input.sessionUuid);
  return pin !== undefined || input.reportClearedPin ? { displayPin: pin ?? null } : {};
}

/** Existing device selection with a session-only, side-effect-free display selection slot. */
export function createSetActiveDeviceHandler(dependencies: SetActiveDeviceDependencies) {
  const legacyDeviceSelection =
    dependencies.legacyDeviceSelection ??
    (() => {
      throw new ActionableError("Inject device readiness before selecting a legacy device.");
    });
  return async (args: HandlerArgs, _progress?: unknown, signal?: AbortSignal) => {
    const mcpSessionId = internalMcpSessionId(args);
    const transportAttempt = transitionalTransportAttempt(args, dependencies, signal);
    let prior: PriorSelection | undefined;
    try {
      const selectedAutolockSession = resolveAutolockSelection(args);
      refuseForeignOwnedSession(args);
      admitSessionlessSelection(args);
      const sessionUuid = args.sessionUuid;
      const sessionScoped =
        Boolean(sessionUuid) && defaultDaemonContext.sessionManager() !== undefined;
      if (sessionUuid && !sessionScoped && !resolveDirectSessionDevice(sessionUuid)) {
        throw new DirectSessionNotActiveError(sessionUuid);
      }
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
            transportAttempt,
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
            transportAttempt,
          });
        }
        if (selectedAutolockSession) {
          await defaultDaemonContext
            .requireDevicePoolWrites()
            .attachAutolockSessionToMcpSession(selectedAutolockSession, mcpSessionId, true, true);
        }
        const payload = {
          message: `Active device set to '${args.deviceId}'`,
          deviceId: args.deviceId,
          ...(args.sessionUuid ? { sessionUuid: args.sessionUuid } : {}),
          ...currentDisplayPinResult({ sessionUuid: args.sessionUuid, reportClearedPin }),
        };
        return createStructuredToolResponse(payload);
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
