import { z } from "zod/v4";
import { defaultDaemonContext } from "../daemon/daemonContext";
import {
  defaultStatusBarControllerFactory,
  type StatusBarControllerFactory,
} from "../features/utility/StatusBarControllerFactory";
import {
  requestedStatusBarFields,
  STATUS_BAR_BATTERY_STATES,
  STATUS_BAR_DATA_NETWORKS,
  type StatusBarController,
  type StatusBarField,
  type StatusBarOverrides,
  StatusBarRequestRejectedError,
} from "../features/utility/StatusBarOverride";
import {
  defaultStatusBarOverrideRegistry,
  type StatusBarOverrideRecord,
  type StatusBarOverrideStore,
} from "../features/utility/StatusBarOverrideRegistry";
import type { BootedDevice } from "../models";
import { createStructuredToolResponse } from "../utils/toolUtils";
import { defineDeviceTool, type DeviceToolSchema } from "./defineTool";
import { PLAN_RELEVANT } from "./toolRegistryTypes";
import { runSessionStatusBarMutation, type StatusBarSessionManager } from "./sessionStatusBar";
import { statusBarResultSchema } from "./statusBarToolOutputSchemas";

const statusBarInput = z.object({
  action: z
    .enum(["override", "clear", "get"])
    .describe("override: set the given fields; clear: restore the live status bar; get: read"),
  time: z
    .string()
    .min(1)
    .optional()
    .describe('Clock text, e.g. "9:41" (Android demo mode needs H:MM or HH:MM)'),
  batteryLevel: z.number().int().min(0).max(100).optional().describe("Battery percent 0-100"),
  batteryState: z.enum(STATUS_BAR_BATTERY_STATES).optional(),
  cellularBars: z.number().int().min(0).max(4).optional().describe("Cellular bars 0-4"),
  wifiBars: z.number().int().min(0).max(3).optional().describe("Wi-Fi bars 0-3"),
  dataNetwork: z.enum(STATUS_BAR_DATA_NETWORKS).optional(),
  operatorName: z.string().optional().describe("Carrier name (iOS Simulator only)"),
  hideNotifications: z.boolean().optional().describe("Hide notification icons (Android only)"),
});

export type StatusBarArgs = z.output<DeviceToolSchema<typeof statusBarInput>>;

export interface StatusBarToolDependencies {
  controllerFor?: StatusBarControllerFactory;
  registry?: StatusBarOverrideStore;
  sessionManager?: () => StatusBarSessionManager | undefined;
}

function overridesFrom(args: StatusBarArgs): StatusBarOverrides {
  return {
    time: args.time,
    batteryLevel: args.batteryLevel,
    batteryState: args.batteryState,
    cellularBars: args.cellularBars,
    wifiBars: args.wifiBars,
    dataNetwork: args.dataNetwork,
    operatorName: args.operatorName,
    hideNotifications: args.hideNotifications,
  };
}

function definedOverrides(overrides: StatusBarOverrides): StatusBarOverrides {
  return Object.fromEntries(
    Object.entries(overrides).filter(([, value]) => value !== undefined),
  ) as StatusBarOverrides;
}

function failure(device: BootedDevice, action: StatusBarArgs["action"], message: string) {
  return {
    ...createStructuredToolResponse({
      message,
      success: false,
      status: "failed" as const,
      action,
      deviceId: device.deviceId,
      platform: device.platform,
      error: message,
    }),
    isError: true as const,
  };
}

const UNSUPPORTED_MESSAGE =
  "Status bar overrides are unsupported on physical iOS devices; " +
  "only the iOS Simulator (simctl status_bar) and Android (SystemUI demo mode) support them.";

/** The argument error for this call, or null when the action and its fields agree. */
function argumentError(action: StatusBarArgs["action"], fields: readonly string[]): string | null {
  if (action === "override") {
    return fields.length === 0 ? "statusBar override needs at least one field to set." : null;
  }
  return fields.length > 0
    ? `statusBar ${action} takes no override fields (got ${fields.join(", ")}).`
    : null;
}

interface StatusBarCall {
  device: BootedDevice;
  args: StatusBarArgs;
  controller: StatusBarController;
  registry: StatusBarOverrideStore;
  sessionManager: StatusBarSessionManager | undefined;
  signal?: AbortSignal;
}

function callBase(call: StatusBarCall) {
  return {
    action: call.args.action,
    deviceId: call.device.deviceId,
    platform: call.device.platform,
  };
}

async function readStatusBar(call: StatusBarCall) {
  const raw = await call.controller.read(call.signal);
  const current = call.registry.get(call.device.deviceId);
  return createStructuredToolResponse({
    message: current ? "Status bar override is active" : "No status bar override recorded",
    success: true,
    status: "current" as const,
    ...callBase(call),
    override: current?.overrides ?? null,
    ownerSessionId: current?.sessionId ?? null,
    raw,
  });
}

async function clearStatusBar(call: StatusBarCall) {
  // Under the caller's session like an override, so a clear that waited in the device queue while
  // its session released or rebound is refused instead of clearing the next owner's override.
  await runSessionStatusBarMutation({
    sessionManager: call.sessionManager,
    sessionUuid: call.args.sessionUuid,
    deviceId: call.device.deviceId,
    // A clear records nothing, so a rejection has nothing to undo.
    record: () => () => undefined,
    mutation: () => call.controller.clear(call.signal),
  });
  call.registry.forget(call.device.deviceId);
  return createStructuredToolResponse({
    message: "Cleared the status bar override",
    success: true,
    status: "cleared" as const,
    ...callBase(call),
    override: null,
  });
}

/**
 * Puts the store back to `previous` (or nothing) for this device, but only while it still holds
 * `written`, the record this call wrote: a record another caller has since replaced or removed is
 * newer than this call's view, so it is left alone (#17079).
 */
function restoreRecord(
  registry: StatusBarOverrideStore,
  device: BootedDevice,
  written: StatusBarOverrideRecord | null,
  previous: StatusBarOverrideRecord | null,
): boolean {
  if (registry.get(device.deviceId) !== written) {
    return false;
  }
  registry.forget(device.deviceId);
  if (previous) {
    registry.record(previous.device, previous.sessionId, previous.overrides);
  }
  return true;
}

/**
 * Runs status-bar mutations one at a time per device, in call order (#17079). The daemon's
 * per-device queue already does this, but direct stdio mode runs tool calls concurrently, and an
 * override's finalization restores the record it saw before its device command, so a concurrent
 * override or clear on the same device must not interleave with it. Queued outside the session's
 * tracked setup, so a release drains only the running mutation, and a queued override or clear
 * re-checks its session's admission when it starts. A rejected mutation does not block the next.
 */
function createDeviceSerializer(): <T>(deviceId: string, task: () => Promise<T>) => Promise<T> {
  const tails = new Map<string, Promise<void>>();
  return <T>(deviceId: string, task: () => Promise<T>): Promise<T> => {
    const run = (tails.get(deviceId) ?? Promise.resolve()).then(task);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    tails.set(deviceId, tail);
    void tail.then(() => {
      if (tails.get(deviceId) === tail) {
        tails.delete(deviceId);
      }
    });
    return run;
  };
}

/** The requested values of the fields the platform applied. */
function appliedOverrides(
  requested: StatusBarOverrides,
  applied: readonly StatusBarField[],
): StatusBarOverrides {
  return Object.fromEntries(
    applied.map((field) => [field, requested[field]]),
  ) as StatusBarOverrides;
}

async function overrideStatusBar(call: StatusBarCall, requested: StatusBarOverrides) {
  const { device, registry } = call;
  // Recorded before the device command so a racing release still clears it (#14105). A request
  // refused before any device command is undone; any other rejection may have left part of the
  // override on the device, so the record stays as the release-time cleanup obligation. On
  // success the record narrows to the fields the platform applied (#17054).
  let previous: StatusBarOverrideRecord | null = null;
  let written: StatusBarOverrideRecord | null = null;
  let owner: string | null = null;
  const outcome = await runSessionStatusBarMutation({
    sessionManager: call.sessionManager,
    sessionUuid: call.args.sessionUuid,
    deviceId: device.deviceId,
    record: (sessionId) => {
      previous = registry.get(device.deviceId);
      owner = sessionId;
      registry.record(device, sessionId, requested);
      written = registry.get(device.deviceId);
      return (error) => {
        if (error instanceof StatusBarRequestRejectedError) {
          restoreRecord(registry, device, written, previous);
        }
      };
    },
    mutation: async () => {
      const result = await call.controller.override(requested, call.signal);
      if (restoreRecord(registry, device, written, previous) && result.applied.length > 0) {
        registry.record(device, owner, appliedOverrides(requested, result.applied));
      }
      return result;
    },
  });
  const partial = outcome.unsupported.length > 0;
  const applied = outcome.applied.join(", ") || "nothing";
  return createStructuredToolResponse({
    message: partial
      ? `Applied ${applied}; unsupported on ${device.platform}: ${outcome.unsupported.join(", ")}`
      : `Applied status bar override: ${applied}`,
    success: true,
    status: partial ? ("partial" as const) : ("applied" as const),
    ...callBase(call),
    applied: outcome.applied,
    unsupported: outcome.unsupported,
    override: registry.get(device.deviceId)?.overrides ?? null,
  });
}

export function createStatusBarHandler(deps: StatusBarToolDependencies = {}) {
  const controllerFor = deps.controllerFor ?? defaultStatusBarControllerFactory;
  const registry = deps.registry ?? defaultStatusBarOverrideRegistry;
  const sessionManager = deps.sessionManager ?? (() => defaultDaemonContext.sessionManager());
  const serializeOnDevice = createDeviceSerializer();
  return async (
    device: BootedDevice,
    args: StatusBarArgs,
    _progress?: unknown,
    signal?: AbortSignal,
  ) => {
    const requested = definedOverrides(overridesFrom(args));
    const error = argumentError(args.action, requestedStatusBarFields(requested));
    if (error) {
      return failure(device, args.action, error);
    }
    const controller = controllerFor(device);
    if (!controller) {
      return createStructuredToolResponse({
        message: UNSUPPORTED_MESSAGE,
        success: false,
        status: "unsupported" as const,
        action: args.action,
        deviceId: device.deviceId,
        platform: device.platform,
      });
    }
    const call = { device, args, controller, registry, sessionManager: sessionManager(), signal };
    if (args.action === "get") {
      return readStatusBar(call);
    }
    const queued = <T>(mutation: () => Promise<T>): Promise<T> =>
      serializeOnDevice(device.deviceId, () => {
        // A call aborted while it waited for the device must not start its device command.
        signal?.throwIfAborted();
        return mutation();
      });
    return args.action === "clear"
      ? queued(() => clearStatusBar(call))
      : queued(() => overrideStatusBar(call, requested));
  };
}

const statusBarTool = defineDeviceTool({
  name: "statusBar",
  description:
    "Deterministic status bar for screenshots and video: override time, battery, signal, data network and carrier (iOS Simulator simctl status_bar, Android SystemUI demo mode), clear it, or read it. A session's override is cleared when the session releases the device.",
  input: statusBarInput,
  options: {
    // A plan sets the status bar before the screenshots it compares.
    ...PLAN_RELEVANT,
    defaultEnabled: false,
    outputSchema: statusBarResultSchema,
    // `get` only reads; override and clear change visible UI (#10965).
    deviceReadOnly: (args: StatusBarArgs) => args.action === "get",
    deviceReadOnlyArgs: [{ argument: "action", values: ["get"] }],
  },
});

export function registerStatusBarTools(deps: StatusBarToolDependencies = {}): void {
  statusBarTool.register(undefined, createStatusBarHandler(deps));
}
