import { DaemonState } from "../daemon/daemonState";
import type { DevicePool, PooledDevice } from "../daemon/devicePool";
import type { SessionManager } from "../daemon/sessionManager";
import type { DisplayInventoryProvider } from "../devices/DisplayInventoryProvider";
import type { Platform } from "../models";
import { ActionableError, toActionableError } from "../models/ActionableError";
import { DisplayPinNeedsSessionError } from "../models/PinnedDisplayError";
import { RealObserveScreen } from "../features/observe/ObserveScreen";
import { DeviceSessionManager } from "../devices/DeviceSessionManager";
import { logger } from "../utils/logger";
import { truncateBodyText } from "../utils/truncateBodyText";
import { createJSONToolResponse } from "../utils/toolUtils";
import {
  registerDirectSessionDevice,
  resolveDirectSessionDevice,
} from "./directSessionDeviceRegistry";
import { prepareSessionDisplayPin } from "./sessionDisplayPin";

export interface SetActiveDeviceArgs {
  deviceId: string;
  platform?: Platform;
  display?: string | null;
}

interface HandlerArgs extends SetActiveDeviceArgs {
  sessionUuid?: string;
  __mcpSessionId?: string;
}

type ResumeCtrlProxy = (deviceId: string, platform: Platform) => Promise<void>;

interface SetActiveDeviceDependencies {
  displayInventory?: DisplayInventoryProvider;
  resumeCtrlProxy: ResumeCtrlProxy;
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
  const targetSession = ownedSession ?? pool.resolveAutolockSessionForMcpSession(mcpSessionId);
  args.sessionUuid ??= targetSession;
  return targetSession === args.sessionUuid ? targetSession : undefined;
}

async function requestedPoolDevice(pool: DevicePool, deviceId: string): Promise<PooledDevice> {
  let device = pool.getDevice(deviceId);
  if (!device) {
    const outcome = await pool.refreshDevicesWithOutcome();
    device = pool.getDevice(deviceId);
    if (!device && outcome.failure !== undefined) {
      throw new ActionableError(
        `Could not refresh device list: ${truncateBodyText(outcome.failure.split(/[\r\n\u2028\u2029]/, 1)[0], 256)}. Resolve the cause and retry.`,
      );
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
    throw new ActionableError(
      `Device '${device.id}' is already assigned to session ${device.sessionId}`,
    );
  }
}

async function bindRequestedDevice(input: {
  args: HandlerArgs & { sessionUuid: string };
  device: PooledDevice;
  pool: DevicePool;
  sessions: SessionManager;
}): Promise<void> {
  const { args, device, pool, sessions } = input;
  const existing = sessions.getSession(args.sessionUuid);
  if (existing?.assignedDevice === args.deviceId) {
    return;
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
  );
  if (boundSession !== args.sessionUuid) {
    throw new ActionableError(
      `Device '${args.deviceId}' is already assigned to session ${boundSession}`,
    );
  }
  sessions.setDeviceReadiness(args.sessionUuid, "booted");
}

async function selectSessionDevice(input: {
  args: HandlerArgs & { sessionUuid: string };
  dependencies: SetActiveDeviceDependencies;
}): Promise<boolean> {
  const { args, dependencies } = input;
  const sessions = DaemonState.getInstance().getSessionManager();
  const pool = DaemonState.getInstance().getDevicePool();
  const device = await requestedPoolDevice(pool, args.deviceId);
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
  await bindRequestedDevice({ args, device, pool, sessions });
  if (displayPin !== undefined) {
    sessions.setDisplayPin(args.sessionUuid, displayPin);
  }
  logger.info(`[setActiveDevice] Bound device ${args.deviceId} to session ${args.sessionUuid}`);
  return args.display !== undefined || hadDisplayPin;
}

async function selectLegacyDevice(input: {
  args: HandlerArgs;
  resumeCtrlProxy: ResumeCtrlProxy;
}): Promise<void> {
  const { args, resumeCtrlProxy } = input;
  const sessions = DeviceSessionManager.getInstance();
  const previousDevice = sessions.getCurrentDevice();
  const previousPlatform = sessions.getCurrentPlatform();
  // #5870: "either" lets deviceId disambiguate when platform is omitted.
  const readyDevice = await sessions.ensureDeviceReady(args.platform ?? "either", args.deviceId);
  const resolvedPlatform = args.platform ?? readyDevice.platform;
  await resumeCtrlProxy(readyDevice.deviceId, resolvedPlatform);
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
  return async (args: HandlerArgs) => {
    const mcpSessionId = args.__mcpSessionId;
    try {
      const selectedAutolockSession = resolveAutolockSelection(args);
      const sessionUuid = args.sessionUuid;
      const sessionScoped = Boolean(sessionUuid) && DaemonState.getInstance().isInitialized();
      if (args.display !== undefined && !sessionScoped) {
        throw new DisplayPinNeedsSessionError();
      }
      let reportClearedPin = false;
      if (sessionScoped && sessionUuid) {
        reportClearedPin = await selectSessionDevice({
          args: { ...args, sessionUuid },
          dependencies,
        });
      } else {
        await selectLegacyDevice({ args, resumeCtrlProxy: dependencies.resumeCtrlProxy });
      }
      if (selectedAutolockSession) {
        await DaemonState.getInstance()
          .getDevicePool()
          .attachAutolockSessionToMcpSession(selectedAutolockSession, mcpSessionId);
      }
      const payload = {
        message: `Active device set to '${args.deviceId}'`,
        deviceId: args.deviceId,
        ...(args.sessionUuid ? { sessionUuid: args.sessionUuid } : {}),
        ...currentDisplayPinResult({ sessionUuid: args.sessionUuid, reportClearedPin }),
      };
      return createJSONToolResponse(payload);
    } catch (error) {
      logger.error("Failed to set active device:", error);
      throw toActionableError(error, "Failed to set active device");
    }
  };
}
