import { DeviceCriteriaMatcher, type DeviceAllocationCriteria } from "../DeviceCriteriaMatcher";
import type { PooledDevice } from "../devicePool";
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
 * any other device, a call naming any other session, and the tools that acquire, start, stop,
 * provision or delete devices are refused with `device_outside_managed_slots`. Reads stay open everywhere (owner
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

  /**
   * The binding that was granted `sessionUuid` as one of its slot sessions. Internal calls (plan
   * steps, nested tools) carry no socket session id, only the session they run on (#11397).
   */
  forSlotSession(sessionUuid: string | undefined): ManagedConnectionBinding | undefined {
    if (sessionUuid === undefined) {
      return undefined;
    }
    for (const binding of this.bindings.values()) {
      if (binding.sessionUuids.has(sessionUuid)) {
        return binding;
      }
    }
    return undefined;
  }

  clear(): void {
    this.bindings.clear();
  }
}

/**
 * Tools a managed connection may not call at all: they acquire, boot, stop, provision or delete
 * devices, which for a managed execution only slot acquisition and release do (design section 5).
 * `killDevice` is refused even on the connection's own slot device (#11271): the connection cannot
 * boot it again (`getAndroid`/`getApple`/`startDevice` are refused), so a stop would strand the
 * execution; the next acquisition on the slot boots and reuses the device.
 */
export const MANAGED_CONNECTION_REFUSED_TOOLS: ReadonlySet<string> = new Set([
  "getAndroid",
  "getApple",
  "startDevice",
  "provisionDevice",
  "killDevice",
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
 * The refusal for a plan's device labels on a bound managed connection (#11397), or undefined when
 * every label is served by one of the connection's own slot sessions. A label mapped to any other
 * session (a derived `${base}:${label}` session) would be handed a device by the generic pool, so
 * it is refused before anything is allocated or booted. `labelSessions` is label -> session.
 */
export function managedConnectionPlanLabelRefusal(input: {
  binding: ManagedConnectionBinding | undefined;
  action: string;
  labelSessions: Readonly<Record<string, string>>;
}): DeviceOutsideManagedSlotsError | undefined {
  const { binding } = input;
  if (!binding) {
    return undefined;
  }
  const outside = Object.entries(input.labelSessions).find(
    ([, sessionUuid]) => !binding.sessionUuids.has(sessionUuid),
  );
  return outside
    ? new DeviceOutsideManagedSlotsError(input.action, "tool", binding.scopeKey, {
        deviceLabel: outside[0],
      })
    : undefined;
}

/**
 * Whether a slot device demonstrably fails the criteria a plan label declares (#11421). A slot
 * serves a label only with its own device, so a declared criterion it does not meet is a refusal,
 * never a silent substitution. The pool's own matcher decides, as for generic allocation.
 * A criterion is evaluated only when the device's fact is known: `platform` always, `simulatorType`
 * and `iosVersion` when the pool recorded them (iOS simulators). An undeclared criterion, or one
 * whose device fact is unknown, is not a reason to refuse.
 */
export function slotDeviceFailsLabelCriteria(input: {
  declared: DeviceAllocationCriteria | undefined;
  slotPlatform: PooledDevice["platform"];
  device: PooledDevice | null;
}): boolean {
  const { declared, device } = input;
  if (!declared) {
    return false;
  }
  if (declared.platform && declared.platform !== input.slotPlatform) {
    return true;
  }
  if (!device) {
    return false;
  }
  const evaluable: DeviceAllocationCriteria = {
    simulatorType: device.simulatorType ? declared.simulatorType : undefined,
    iosVersion: device.iosVersion ? declared.iosVersion : undefined,
  };
  return new DeviceCriteriaMatcher().filterDevices([device], evaluable).length === 0;
}

/**
 * The refusal for a plain (not device-aware) tool from a bound managed connection: the slot
 * lifecycle tools always, `setActiveDevice` off-slot. Other plain tools (reads,
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
  return undefined;
}

function stringArg(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
