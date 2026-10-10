import { DeviceOutsideManagedSlotsError } from "./managedSlotRefusal";

/**
 * Managed-connection scope (#11178 part b, epic #11172).
 *
 * A managed connection is one daemon socket session (the `__mcpSessionId` the daemon stamps on
 * every forwarded call) whose proxy acquired managed slots. Slot acquisition (`daemon/acquire
 * ManagedSlots`) binds the socket session to its scope and slot sessions with
 * {@link ManagedConnectionScopes.bind}; the binding ends with the socket.
 *
 * For a bound connection, control and lifecycle are confined to the slot devices: a control call on
 * any other device, a call naming any other session, and the tools that acquire, start, provision or
 * delete devices are refused with `device_outside_managed_slots`. Reads stay open everywhere (owner
 * decision Q6). Unbound (generic) connections are unaffected; their protection against slot devices
 * is the generic `device_assigned_to_managed_slot` exclusion.
 */

export interface ManagedConnectionBinding {
  scopeKey: string;
  /** The live slot sessions this connection was granted; at most one per slot. */
  sessionUuids: ReadonlySet<string>;
}

export class ManagedConnectionScopes {
  private readonly bindings = new Map<string, ManagedConnectionBinding>();

  /** Bind (or rebind, after a re-acquisition) a socket session to its slot sessions. */
  bind(mcpSessionId: string, binding: { scopeKey: string; sessionUuids: Iterable<string> }): void {
    this.bindings.set(mcpSessionId, {
      scopeKey: binding.scopeKey,
      sessionUuids: new Set(binding.sessionUuids),
    });
  }

  unbind(mcpSessionId: string): void {
    this.bindings.delete(mcpSessionId);
  }

  get(mcpSessionId: string | undefined): ManagedConnectionBinding | undefined {
    return mcpSessionId === undefined ? undefined : this.bindings.get(mcpSessionId);
  }

  clear(): void {
    this.bindings.clear();
  }
}

/**
 * Tools a managed connection may not call at all: they acquire, boot, provision or delete devices,
 * which for a managed execution only slot acquisition does (design section 5).
 */
export const MANAGED_CONNECTION_REFUSED_TOOLS: ReadonlySet<string> = new Set([
  "getAndroid",
  "getApple",
  "startDevice",
  "provisionDevice",
  "deleteDevice",
]);

/** Resolves the device a slot session currently holds (its transport id), if any. */
export type SlotSessionDeviceLookup = (sessionUuid: string) => string | undefined;

/**
 * The refusal for a control call from a bound managed connection, or undefined when it may proceed
 * (unbound connection, or a call confined to the connection's slots). `requesterSessionUuid` is the
 * call's base session; `deviceId` the device it would act on.
 */
export function managedConnectionControlRefusal(input: {
  binding: ManagedConnectionBinding | undefined;
  action: string;
  deviceId?: string;
  requesterSessionUuid?: string;
  slotDeviceOf: SlotSessionDeviceLookup;
}): DeviceOutsideManagedSlotsError | undefined {
  const { binding, action, deviceId, requesterSessionUuid } = input;
  if (!binding) {
    return undefined;
  }
  if (requesterSessionUuid !== undefined && !binding.sessionUuids.has(requesterSessionUuid)) {
    return new DeviceOutsideManagedSlotsError(action, "session", binding.scopeKey, {
      sessionUuid: requesterSessionUuid,
    });
  }
  if (deviceId === undefined) {
    return undefined;
  }
  for (const sessionUuid of binding.sessionUuids) {
    if (input.slotDeviceOf(sessionUuid) === deviceId) {
      return undefined;
    }
  }
  return new DeviceOutsideManagedSlotsError(action, "device", binding.scopeKey, { deviceId });
}

/**
 * The refusal for a plain (not device-aware) tool from a bound managed connection: the slot
 * lifecycle tools always, `setActiveDevice` and `killDevice` off-slot. Other plain tools (reads,
 * settings of the connection itself) pass.
 */
export function managedConnectionPlainToolRefusal(input: {
  binding: ManagedConnectionBinding | undefined;
  toolName: string;
  args: Record<string, unknown>;
  requesterSessionUuid?: string;
  slotDeviceOf: SlotSessionDeviceLookup;
}): DeviceOutsideManagedSlotsError | undefined {
  const { binding, toolName, args } = input;
  if (!binding) {
    return undefined;
  }
  if (MANAGED_CONNECTION_REFUSED_TOOLS.has(toolName)) {
    return new DeviceOutsideManagedSlotsError(toolName, "tool", binding.scopeKey);
  }
  if (toolName === "setActiveDevice") {
    return managedConnectionControlRefusal({
      binding,
      action: toolName,
      deviceId: stringArg(args.deviceId),
      requesterSessionUuid: input.requesterSessionUuid,
      slotDeviceOf: input.slotDeviceOf,
    });
  }
  if (toolName === "killDevice") {
    const device = args.device;
    const deviceId =
      device && typeof device === "object"
        ? stringArg((device as Record<string, unknown>).deviceId)
        : undefined;
    return managedConnectionControlRefusal({
      binding,
      action: toolName,
      // A kill names its target; one that names none cannot be proven to be a slot device.
      deviceId: deviceId ?? "",
      requesterSessionUuid: input.requesterSessionUuid,
      slotDeviceOf: input.slotDeviceOf,
    });
  }
  return undefined;
}

function stringArg(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
