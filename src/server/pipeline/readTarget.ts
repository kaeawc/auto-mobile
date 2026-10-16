import { BootedDeviceDiscoveryIncompleteError } from "../../models/BootedDeviceDiscoveryIncompleteError";
import {
  explicitReadTargetPlatform,
  matchRunningReadTarget,
  isProvidedReadTargetNotFound,
} from "../../devices/runningReadTarget";
import { AmbiguousDeviceTargetError } from "../ambiguousDeviceTargetRefusal";
import {
  type ConnectedPlatformScan,
  type DeviceReadyOptions,
} from "../../devices/DeviceSessionManager";
import { ActionableError, BootedDevice, SomePlatform, type DeviceInfo } from "../../models";
import { logger } from "../../utils/logger";
import { errorMessage } from "../../utils/describeUnknownError";
import { UnissuedSessionError, type Session } from "../../daemon/sessionManager";
import { DaemonState } from "../../daemon/daemonState";
import { reconcileDiscoveryObservation } from "../../daemon/discoveryReconcile";
import { PlatformDeviceManagerFactory } from "../../utils/factories/PlatformDeviceManagerFactory";
import {
  resolveToolCallDeviceIds,
  toolCallNamesDeviceId,
} from "../../daemon/toolCallDeviceIdentity";
import {
  frameHeldSessionsFrom,
  heldDevicesUnidentifiedTransportCouldAlias,
} from "../../daemon/frameDeviceIdentity";
import { didSourceSucceedForDevice } from "../../utils/discoverySource";
import { bindingPoolGate } from "../../daemon/sessionBroker/provisioning/poolGate";
import { BINDING_INPUT_SNAPSHOT_MAX_AGE_MS } from "../../daemon/inputDeviceOwnership";
import { DeviceAssignedToBindingError } from "../../daemon/sessionBroker/provisioning/refusal";
import { DeviceOwnedByOtherDaemonError } from "../../daemon/deviceAcquisitionRefusals";
import {
  assertControlNotOnForeignDaemonDevice,
  deviceReservedForRestartRecoveryError,
} from "../../daemon/inputDeviceOwnership";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import { INTERNAL_NO_DIFF_PARAM } from "../internalToolCall";
import { getToolSelectionContext } from "../../features/toolSelection/toolSelectionContext";
import { nonBlankSessionUuid } from "../planCallerIdentity";
import { combineAbortSignals, runWithAbortSignal } from "../../utils/AbortContext";
import { executionTracker } from "../executionTracker";
import type {
  SessionlessDeviceRead,
  DeviceAwareToolOptions,
  RegisteredTool,
} from "../toolRegistry";
import type { ExecutionTargetInput, ExecutionTargetContext } from "./executionTarget";
import { unidentifiedToolTargetRow, bindingPlatformsFor } from "./deviceCallDispatch";

export async function resolveSessionlessDeviceRead(
  input: ExecutionTargetInput,
  read: SessionlessDeviceRead,
  deviceId: string,
  resolvedDevice?: BootedDevice,
): Promise<ExecutionTargetContext> {
  const { args, signal } = input;
  signal?.throwIfAborted();
  const device = resolvedDevice ?? (await resolveStoppedReservedRead(input, read, deviceId));
  if (resolvedDevice) {
    read.assertAuthorized(device);
  }
  if (args.platform && args.platform !== "either" && args.platform !== device.platform) {
    throw new ActionableError(
      `Device ${deviceId} is ${device.platform}, not requested platform ${args.platform}.`,
    );
  }
  return {
    args,
    baseSessionUuid: undefined,
    device,
    internalCall: args[INTERNAL_NO_DIFF_PARAM] === true,
    sessionUuid: undefined,
    shouldResolveDevice: true,
    deviceRead: read,
  };
}

/** A restart reservation forbids read booting even for the reservation's owner. */
function readRestartReservation(deviceIds: readonly string[], platform: unknown) {
  const state = DaemonState.getInstance();
  if (!state.isInitialized()) {
    return undefined;
  }
  const pool = state.getDevicePool();
  for (const p of bindingPlatformsFor(undefined, platform)) {
    const reservation = pool.restartReservationForStart?.(p, deviceIds, {});
    if (reservation) {
      return reservation;
    }
  }
  return undefined;
}

async function withReadRestartReservation<T>(
  input: ExecutionTargetInput,
  deviceId: string,
  resolve: () => Promise<T>,
): Promise<T> {
  try {
    return await resolve();
  } catch (error) {
    if (
      isProvidedReadTargetNotFound(error) ||
      error instanceof BootedDeviceDiscoveryIncompleteError
    ) {
      const reservation = readRestartReservation([deviceId], input.args.platform);
      if (reservation) {
        throw deviceReservedForRestartRecoveryError(
          reservation.deviceId,
          reservation.sessionUuid,
          reservation.retryAfterMs,
        );
      }
    }
    // Preserve discovery failure, cancellation and authorization errors without a reservation.
    throw error;
  }
}

async function resolveStoppedReservedRead(
  input: ExecutionTargetInput,
  read: SessionlessDeviceRead,
  deviceId: string,
): Promise<BootedDevice> {
  return withReadRestartReservation(input, deviceId, () =>
    read.resolve(deviceId, input.signal, input.args.platform || "either"),
  );
}

class ReadTargetBecameHeld extends Error {
  constructor(
    readonly deviceId: string,
    readonly device?: BootedDevice,
  ) {
    super("read target became held before readiness");
  }
}

export async function findHeldReadIdentity(
  input: ExecutionTargetInput,
  identities: readonly string[],
  platform: unknown,
): Promise<string | undefined> {
  for (const deviceId of new Set(identities)) {
    if (
      await isSessionlessReadTargetHeld(
        input.name,
        {
          deviceId,
          platform,
          now: (input.timer ?? defaultTimer).now(),
        },
        input.signal,
      )
    ) {
      return deviceId;
    }
  }
  return undefined;
}

async function recheckReadBootTarget(
  input: ExecutionTargetInput,
  image: DeviceInfo,
): Promise<void> {
  const identities = [input.args.deviceId, image.name, image.deviceId].filter(
    (id): id is string => typeof id === "string" && !!id,
  );
  const held = await findHeldReadIdentity(input, identities, image.platform);
  if (held) {
    throw new ReadTargetBecameHeld(held);
  }
  input.signal?.throwIfAborted();
}

/** A late acquisition cancels readiness, then the read watches the resolved device. */
export async function ensureReadTargetOrWatch(
  input: ExecutionTargetInput,
  platform: SomePlatform,
  providedDeviceId: string | undefined,
  options: DeviceReadyOptions,
  read: SessionlessDeviceRead,
  readinessTarget: string | undefined,
): Promise<
  | { device: BootedDevice; watched?: undefined }
  | { watched: ExecutionTargetContext; device?: undefined }
> {
  if (options.intent !== "read") {
    return {
      device: await input.deviceSessionManager.ensureDeviceReady(
        platform,
        providedDeviceId,
        options,
      ),
    };
  }
  const readiness = new AbortController();
  const executionId = input.args.__executionId;
  let markedTarget = readinessTarget;
  let resolvedDevice: BootedDevice | undefined;
  const mark = (deviceId: string) => {
    if (typeof executionId === "string") {
      executionTracker.markSessionlessReadReadiness(executionId, deviceId, readiness);
      if (markedTarget && markedTarget !== deviceId) {
        executionTracker.unmarkSessionlessReadReadiness(executionId, markedTarget, readiness);
      }
    }
    markedTarget = deviceId;
  };
  const unmark = () => {
    if (typeof executionId === "string" && markedTarget) {
      executionTracker.unmarkSessionlessReadReadiness(executionId, markedTarget, readiness);
    }
  };
  if (readinessTarget) {
    mark(readinessTarget);
  }
  const combinedSignal = combineAbortSignals(options.signal, readiness.signal);
  try {
    const device = await runWithAbortSignal(combinedSignal, () =>
      input.deviceSessionManager.ensureDeviceReady(platform, providedDeviceId, {
        ...options,
        signal: combinedSignal,
        beforeReadBoot: providedDeviceId
          ? (image) => recheckReadBootTarget(input, image)
          : undefined,
        beforeReadReadiness: async (device) => {
          resolvedDevice = device;
          mark(device.deviceId);
          const held = await findHeldReadIdentity(input, [device.deviceId], device.platform);
          if (held) {
            throw new ReadTargetBecameHeld(held, device);
          }
          input.signal?.throwIfAborted();
          readiness.signal.throwIfAborted();
        },
      }),
    );
    input.signal?.throwIfAborted();
    if (readiness.signal.aborted) {
      unmark();
      return { watched: await resolveSessionlessDeviceRead(input, read, device.deviceId, device) };
    }
    return { device };
  } catch (error) {
    input.signal?.throwIfAborted();
    if (error instanceof ReadTargetBecameHeld) {
      // Expected late ownership verdict: readiness becomes a read-only lookup.
      logger.debug("[ToolRegistry] Read target acquired before readiness", error);
      unmark();
      return {
        watched: await resolveSessionlessDeviceRead(input, read, error.deviceId, error.device),
      };
    }
    if (readiness.signal.aborted && markedTarget) {
      // Acquisition cancels only readiness; watching the holder remains authorized.
      logger.debug("[ToolRegistry] Read readiness cancelled by acquisition", error);
      unmark();
      return {
        watched: await resolveSessionlessDeviceRead(input, read, markedTarget, resolvedDevice),
      };
    }
    throw error;
  } finally {
    unmark();
  }
}

/** One verdict for every explicit read: running, proven absence/image, or incomplete discovery. */
export async function findExplicitReadTarget(
  input: ExecutionTargetInput,
  read: SessionlessDeviceRead,
  platform: SomePlatform,
  fallback?: () => Promise<BootedDevice | undefined>,
): Promise<BootedDevice | undefined> {
  return withReadRestartReservation(input, input.args.deviceId, () =>
    read.findRunning
      ? read.findRunning(input.args.deviceId, input.signal, platform, async (listing) => {
          // A bare name may identify a stopped image on the completed platform. Probe inventory
          // before backoff, without entering readiness or changing any device/session state.
          // Keep the bounded discovery verdict for a reserved target; reservation wins at
          // the outer error boundary, before readiness can start.
          if (readRestartReservation([input.args.deviceId], input.args.platform)) {
            return false;
          }
          const targetPlatform = explicitReadTargetPlatform(input.args.deviceId, platform);
          const healthy = (["android", "ios"] as const).filter(
            (p) => listing.scanned[p] && (targetPlatform === "either" || targetPlatform === p),
          );
          for (const p of healthy) {
            const image = await input.deviceSessionManager.findProvidedReadinessImage(
              p,
              input.args.deviceId,
              listing,
              { intent: "read", signal: input.signal },
            );
            input.signal?.throwIfAborted();
            if (image) {
              return true;
            }
          }
          return false;
        })
      : fallback
        ? fallback()
        : read.resolve(input.args.deviceId, input.signal, platform),
  );
}

/** Raw ids avoid name enrichment; names use the same fresh inventory as explicit observe. */
export async function findRunningExplicitReadTarget(
  input: ExecutionTargetInput,
  read: SessionlessDeviceRead,
  platform: SomePlatform,
  getConnectedPlatforms: (refresh?: boolean) => Promise<ConnectedPlatformScan>,
  alreadyChecked: boolean,
): Promise<{ device: BootedDevice; fromListing: boolean } | undefined> {
  const scan = await getConnectedPlatforms();
  const exact = scan.devices.find(
    (device) =>
      device.deviceId === input.args.deviceId &&
      (platform === "either" || device.platform === platform),
  );
  if (exact) {
    return { device: exact, fromListing: false };
  }
  if (alreadyChecked) {
    return undefined;
  }
  const running = await findExplicitReadTarget(input, read, platform, async () =>
    matchRunningReadTarget(scan.devices, input.args.deviceId, platform),
  );
  if (
    running &&
    !scan.devices.some(
      (device) => device.deviceId === running.deviceId && device.platform === running.platform,
    )
  ) {
    // Fresh Android bypass discovery publishes the ADB cache; discard only the stale call memo.
    await getConnectedPlatforms(true);
  }
  return running ? { device: running, fromListing: !!read.findRunning } : undefined;
}

export function isDeviceReadOnlyCall(options: DeviceAwareToolOptions, args: unknown): boolean {
  return isReadOnlyCall(options.deviceReadOnly, args);
}

export function isReadOnlyCall(
  classification: boolean | ((args: any) => boolean) | undefined,
  args: unknown,
): boolean {
  return typeof classification === "function" ? classification(args) : classification === true;
}

/** Reads never require a session (#10970): an ambiguous read is asked for its deviceId. */
export function multipleDevicesError(
  platform: BootedDevice["platform"],
  readOnly: boolean,
  candidates: readonly BootedDevice[],
): AmbiguousDeviceTargetError {
  const selector = readOnly ? "deviceId" : "sessionUuid";
  return new AmbiguousDeviceTargetError(
    platform === "ios"
      ? `Multiple iOS simulators detected. Provide ${selector} to target a specific simulator.`
      : `Multiple Android devices detected. Provide ${selector} to target a specific device.`,
    candidates,
  );
}

/**
 * Whether a sessionless READ's target is someone else's (#11641): a local session or autolock
 * holder, a broker binding (idle or not), a restart reservation, or a device another daemon claims.
 * Such a read watches the
 * device through the read-only path and is never refused; readiness (the current-device pin,
 * appearance and settings writes) on a held target is the holder's alone.
 * A read never writes settings on a device it does not hold, with one exception: readiness needed to answer the read.
 * (owner decision 2026-10-12, #11964)
 * The binding and foreign-daemon verdicts are the pool gates a control call is refused by,
 * with their one-second snapshots. An ownership state
 * that cannot be read counts as held: a read must not risk writing to someone else's device.
 * False outside daemon mode, where nothing can hold a device.
 */
export async function isSessionlessReadTargetHeld(
  toolName: string,
  input: { deviceId: string; platform: unknown; now: number },
  signal?: AbortSignal,
): Promise<boolean> {
  const { deviceId, platform: requestedPlatform, now } = input;
  const daemonState = DaemonState.getInstance();
  if (!daemonState.isInitialized()) {
    return false;
  }
  if (readRestartReservation([deviceId], requestedPlatform) || isDeviceHeld(deviceId)) {
    return true;
  }
  const pool = daemonState.getDevicePool();
  try {
    const unidentified = await unidentifiedToolTargetRow(
      { deviceId, platform: requestedPlatform, readOnly: true, now },
      signal,
    );
    if (
      unidentified &&
      (await heldDevicesUnidentifiedTransportCouldAlias(
        pool,
        unidentified,
        false,
        frameHeldSessionsFrom(daemonState.getSessionManager()),
      ))
    ) {
      return true;
    }
    for (const platform of bindingPlatformsFor(
      pool.getDevice(deviceId)?.platform,
      requestedPlatform,
    )) {
      await bindingPoolGate(pool).assertNotAssignedToBinding?.({
        action: toolName,
        deviceId,
        platform,
        maxAgeMs: BINDING_INPUT_SNAPSHOT_MAX_AGE_MS,
      });
      await assertControlNotOnForeignDaemonDevice({ deviceId, platform, gate: pool });
    }
    return false;
  } catch (error) {
    if (
      error instanceof DeviceAssignedToBindingError ||
      error instanceof DeviceOwnedByOtherDaemonError
    ) {
      // A broker binding or another daemon holds the device: an expected verdict, so the read watches it.
      logger.debug(
        `[ToolRegistry] ${toolName} on ${deviceId} is read-only: ${errorMessage(error)}`,
      );
    } else {
      logger.warn(
        `[ToolRegistry] ownership of ${deviceId} unreadable; ${toolName} is read-only: ${errorMessage(error)}`,
        error,
      );
    }
    return true;
  }
}

/**
 * The explicit deviceId of a call whose session holds a different device, in daemon mode
 * (#10970). Undefined when the call names no device, has no session, or names its own.
 */
export function foreignDeviceRead(
  sessionUuid: string | undefined,
  providedDeviceId: string | undefined,
): string | undefined {
  if (!sessionUuid || !providedDeviceId || !DaemonState.getInstance().isInitialized()) {
    return undefined;
  }
  const assignedDevice = DaemonState.getInstance()
    .getSessionManager()
    .findSession(sessionUuid)?.assignedDevice;
  return assignedDevice && assignedDevice !== providedDeviceId ? providedDeviceId : undefined;
}

/** A gated holder's read watches its assigned device without admission or readiness. */
export function gatedReadSessionDevice(sessionUuid: string | undefined): string | undefined {
  const state = DaemonState.getInstance();
  return sessionUuid &&
    state.isInitialized() &&
    state.getDevicePool().bindingOwnershipGate(sessionUuid)
    ? state.getSessionManager().findSession(sessionUuid)?.assignedDevice
    : undefined;
}

/**
 * Admit a read under its session without refreshing or claiming it (#10964): the live session, or
 * null when the id names no live device session this daemon can route the read to (never issued,
 * such as an IDE observer session (#10968), not live, or a row that expired while no daemon ran
 * (#11361)) so the read runs sessionless. A terminally released or suspect session keeps its
 * typed error. Undefined when there is no daemon session manager.
 */
export async function admitReadSession(
  sessionUuid: string,
  execution: { executionId: string; startTime: number } | undefined,
): Promise<Session | null | undefined> {
  if (!DaemonState.getInstance().isInitialized()) {
    return undefined;
  }
  try {
    const session = await DaemonState.getInstance()
      .getSessionManager()
      .admitIssuedSessionForAutomation(sessionUuid, execution, { access: "read-only" });
    return session?.assignedDevice ? session : null;
  } catch (error) {
    if (error instanceof UnissuedSessionError) {
      return null;
    }
    throw error;
  }
}

/**
 * The device of the session a read named but was too late to be admitted under (#11361): the
 * session is past its idle deadline and only earlier work still holds it. Undefined otherwise.
 */
export function lateReadSessionDevice(
  sessionUuid: string | undefined,
  execution: { executionId: string; startTime: number } | undefined,
): string | undefined {
  return sessionUuid
    ? DaemonState.getInstance().getSessionManager().deviceHeldForLateRead(sessionUuid, execution)
    : undefined;
}

/** A device another session holds: a live owner, or an autolock holder. */
function isDeviceHeld(deviceId: string): boolean {
  const daemonState = DaemonState.getInstance();
  return Boolean(
    daemonState.getSessionManager().getSessionForDevice(deviceId) ??
    daemonState.getDevicePool().getDevice(deviceId)?.autolockSessionId,
  );
}

/**
 * The registry's one entry point for the device ids a caller supplies (#11618), over
 * `resolveToolCallDeviceIds`: the MCP ingress (`ToolRegistryClass.resolveToolCallDeviceIds`), an
 * internal call (`callInternal`: a plan step, a nested tool) and the execution-target resolver all
 * come through here, so a device named by its other transport id is judged, queued and driven as
 * the one pooled device it is on every path. A handset on USB and wireless debugging is one
 * pooled device held under one id, and a call may name it by either.
 *
 * Reads and controls place a transport the pool has not seen yet, so a wireless id first named
 * here resolves to the canonical handset before either readiness or ownership is judged. An
 * incomplete listing refuses only controls (`discovery_incomplete`); reads keep the id as sent
 * and use the shared held-alias verdict to avoid readiness on a possible held device (#11596).
 * Synchronous, and `args` itself,
 * whenever nothing changes and nothing is probed.
 */
export function resolveCallerDeviceIds<T extends Record<string, unknown>>(
  args: T,
  request: { control: boolean; signal?: AbortSignal; timer?: Timer },
): T | Promise<T> {
  const daemonState = DaemonState.getInstance();
  if (!toolCallNamesDeviceId(args) || !daemonState.isInitialized()) {
    return args;
  }
  const pool = daemonState.getDevicePool();
  if (
    args.platform === "ios" ||
    (typeof args.device === "object" &&
      args.device !== null &&
      Reflect.get(args.device, "platform") === "ios")
  ) {
    return resolveToolCallDeviceIds(pool, args, undefined);
  }
  const { signal } = request;
  return resolveToolCallDeviceIds(pool, args, {
    refuseUnplaced: request.control,
    now: (request.timer ?? defaultTimer).now(),
    tracksAndroidDevice: () => pool.getAllDevices().some((device) => device.platform === "android"),
    // RAW adb rows, as the pool's own refresh folds them. The session manager's scan is already
    // mapped onto pooled ids and would record an alias's connection under the canonical serial.
    listRawAndroidDevices: async () => {
      const discovery = await PlatformDeviceManagerFactory.getInstance().getBootedDevicesDetailed(
        "android",
        { signal, bypassAndroidDeviceListCache: true },
      );
      return {
        devices: discovery.devices,
        complete: didSourceSucceedForDevice(discovery, "android", undefined),
        error: discovery.discoveryErrors?.android,
      };
    },
    reconcileDiscovery: (devices) =>
      reconcileDiscoveryObservation(devices, "tools/call:first-seen-transport", { signal }),
  });
}

/**
 * Whether a call's device ids are resolved as a control call's: anything but a read. An iOS id is
 * never an adb transport, so it is never probed.
 */
export function isDeviceIdControlCall(
  tool: Pick<RegisteredTool, "isDeviceReadOnlyCall">,
  args: Record<string, unknown>,
): boolean {
  return tool.isDeviceReadOnlyCall?.(args) !== true && args.platform !== "ios";
}

/**
 * A device-aware call's `deviceId` as the pool's canonical id, resolved ONCE before any holder,
 * broker binding, routing, admission or queue decision: everything after this line, the handler
 * included, sees only the canonical id. A call that resolves no device probes nothing.
 */
export function canonicalizeCallDeviceId(input: ExecutionTargetInput): Promise<void> | undefined {
  const { args, options } = input;
  if (typeof args?.deviceId !== "string") {
    return undefined;
  }
  const resolvesDevice = options.shouldEnsureDevice ? options.shouldEnsureDevice(args) : true;
  const resolved = resolveCallerDeviceIds(
    { deviceId: args.deviceId as string, platform: args.platform },
    {
      control: !isDeviceReadOnlyCall(options, args) && resolvesDevice && args.platform !== "ios",
      signal: input.signal,
      timer: input.timer,
    },
  );
  if (resolved instanceof Promise) {
    return resolved.then(({ deviceId }) => {
      args.deviceId = deviceId;
    });
  }
  args.deviceId = resolved.deviceId;
  return undefined;
}

/**
 * A deviceId-only call (no sessionUuid, no label) from the MCP connection that acquired the
 * session holding that device runs as that session (#10994): admitted, readied and counted as use
 * like a call naming it. The proxy omits the UUID for selector calls (#6807), so the daemon
 * recognizes its holder by the forwarded connection id (`__mcpSessionId`, set only by the
 * daemon's socket forward). Calls from any other connection keep the watcher/refusal paths.
 */
export function adoptHolderConnectionSession(args: Record<string, unknown>): void {
  if (
    typeof args.deviceId !== "string" ||
    nonBlankSessionUuid(args.sessionUuid) !== undefined ||
    args.device !== undefined ||
    !DaemonState.getInstance().isInitialized()
  ) {
    return;
  }
  // #11469: a plan step or nested call carries no socket identity of its own; it runs for the
  // connection of the call that started it.
  const mcpSessionId =
    typeof args.__mcpSessionId === "string"
      ? args.__mcpSessionId
      : getToolSelectionContext()?.callerMcpSessionId;
  if (!mcpSessionId) {
    return;
  }
  const holderSessionUuid = DaemonState.getInstance()
    .getDevicePool()
    .resolveOwnedDeviceSessionForMcpSession(mcpSessionId, args.deviceId);
  if (!holderSessionUuid) {
    return;
  }
  args.sessionUuid = holderSessionUuid;
  if (typeof args.__executionId === "string") {
    // Attribute the execution to the session: its end is use, and it vetoes release in flight.
    executionTracker.setResolvedAutolockSessionUuid(args.__executionId, holderSessionUuid);
  }
}
