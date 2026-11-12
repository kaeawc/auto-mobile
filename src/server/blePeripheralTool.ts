import { defaultDaemonContext } from "../daemon/daemonContext";
import { getToolSelectionContext } from "../features/toolSelection/toolSelectionContext";
import { defaultBlePeripheralManager } from "../features/blePeripheral/defaultBlePeripheralManager";
import type { BlePeripheralManager } from "../features/blePeripheral/BlePeripheralManager";
import {
  blePeripheralSchema,
  blePeripheralOutputSchema,
  type BlePeripheralArgs,
} from "../features/blePeripheral/blePeripheralSchema";
import { ActionableError } from "../models/ActionableError";
import { createStructuredToolResponse } from "../utils/toolUtils";
import { ToolRegistry } from "./toolRegistry";

export { blePeripheralSchema };

export interface BlePeripheralToolDependencies {
  manager: Pick<BlePeripheralManager, "run">;
  session(requested?: string): { sessionUuid: string; deviceId: string } | undefined;
}

function callingSession(requested?: string) {
  const routed = getToolSelectionContext()?.routingSessionUuid;
  if (routed && requested && routed !== requested) {
    throw new ActionableError(
      "BLE handle belongs to the calling session; sessionUuid cannot override it.",
    );
  }
  const sessionUuid = routed ?? requested;
  const session = sessionUuid
    ? defaultDaemonContext.sessionManager()?.peekSession(sessionUuid)
    : undefined;
  return session && sessionUuid ? { sessionUuid, deviceId: session.assignedDevice } : undefined;
}

export function createBlePeripheralHandler(deps: BlePeripheralToolDependencies) {
  return async (args: BlePeripheralArgs, _progress?: unknown, signal?: AbortSignal) => {
    const session = deps.session(args.sessionUuid);
    if (!session) {
      throw new ActionableError(
        "blePeripheral requires a live daemon device session. Acquire one and pass sessionUuid.",
      );
    }
    if (args.deviceId && args.deviceId !== session.deviceId) {
      throw new ActionableError(
        "BLE deviceId must match the calling session's device. Acquire a session for that device first.",
      );
    }
    const result = await deps.manager.run(
      session.sessionUuid,
      { ...args, deviceId: args.deviceId ?? session.deviceId },
      signal,
    );
    return createStructuredToolResponse(result);
  };
}

export function registerBlePeripheralTool(
  deps: BlePeripheralToolDependencies = {
    manager: defaultBlePeripheralManager,
    session: callingSession,
  },
): void {
  ToolRegistry.register(
    "blePeripheral",
    "Manage a session-owned virtual BLE peripheral on Android netsim. start advertises battery, heartRate and/or custom GATT services; notify sends values to subscribed centrals; status reports readiness, connections and subscriptions; stop kills the sidecar. Requires python3; first start provisions Bumble. A connection pauses advertising until disconnect. Handles end with the session.",
    blePeripheralSchema,
    {
      handler: createBlePeripheralHandler(deps),
      defaultEnabled: false,
      outputSchema: blePeripheralOutputSchema,
    },
  );
}
