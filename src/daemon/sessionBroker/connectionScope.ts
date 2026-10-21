import { BROKER_LIFECYCLE_TOOLS } from "./lifecycleTools";
import { DeviceCriteriaMatcher, type DeviceAllocationCriteria } from "../DeviceCriteriaMatcher";
import type { PooledDevice } from "../devicePool";
import { DeviceOutsideBrokerGrantError } from "./connectionRefusal";

/** Per-socket broker grants. Only the returned ready session and its device may be controlled; reads stay open. Empty grants remain confined. Nested plan calls resolve the grant through their base session. */

export interface BrokerConnectionBinding {
  scopeKey: string;
  /** The live binding sessions this connection was granted; at most one per binding. */
  sessionUuids: ReadonlySet<string>;
}

export class BrokerConnectionScopes {
  private readonly bindings = new Map<string, BrokerConnectionBinding>();

  /** Bind (or rebind, after a re-acquisition) a socket session to its binding sessions. */
  bind(mcpSessionId: string, binding: { scopeKey: string; sessionUuids: Iterable<string> }): void {
    this.bindings.set(mcpSessionId, {
      scopeKey: binding.scopeKey,
      sessionUuids: new Set(binding.sessionUuids),
    });
  }

  unbind(mcpSessionId: string): void {
    this.bindings.delete(mcpSessionId);
  }

  get(mcpSessionId: string | undefined): BrokerConnectionBinding | undefined {
    return mcpSessionId === undefined ? undefined : this.bindings.get(mcpSessionId);
  }

  /**
   * The binding that was granted `sessionUuid` as one of its binding sessions. Internal calls (plan
   * steps, nested tools) carry no socket session id, only the session they run on (#11397).
   */
  forGrantedSession(sessionUuid: string | undefined): BrokerConnectionBinding | undefined {
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
 * devices, which for a managed execution only binding acquisition and release do (design section 5).
 * `killDevice` is refused even on the connection's own binding device (#11271): the connection cannot
 * boot it again (`getAndroid`/`getApple`/`startDevice` are refused), so a stop would strand the
 * execution; the next acquisition on the binding boots and reuses the device.
 */

/** Resolves the device a binding session currently holds (its transport id), if any. */
export type GrantedSessionDeviceLookup = (sessionUuid: string) => string | undefined;

/**
 * The refusal for a control call from a bound managed connection, or undefined when it may proceed
 * (unbound connection, or a call confined to the connection's bindings). `requesterSessionUuid` is the
 * call's base session; `deviceId` the device it would act on.
 */
export function brokerConnectionControlRefusal(input: {
  binding: BrokerConnectionBinding | undefined;
  action: string;
  deviceId?: string;
  requesterSessionUuid?: string;
  grantedDeviceOf: GrantedSessionDeviceLookup;
}): DeviceOutsideBrokerGrantError | undefined {
  const { binding, action, deviceId, requesterSessionUuid } = input;
  if (!binding) {
    return undefined;
  }
  if (requesterSessionUuid !== undefined && !binding.sessionUuids.has(requesterSessionUuid)) {
    return new DeviceOutsideBrokerGrantError(action, "session", binding.scopeKey, {
      sessionUuid: requesterSessionUuid,
    });
  }
  if (deviceId === undefined) {
    return undefined;
  }
  for (const sessionUuid of binding.sessionUuids) {
    if (input.grantedDeviceOf(sessionUuid) === deviceId) {
      return undefined;
    }
  }
  return new DeviceOutsideBrokerGrantError(action, "device", binding.scopeKey, { deviceId });
}

/** Refuse a platform-only selector only when every binding's known platform differs. */
export function brokerConnectionPlatformRefusal(input: {
  binding: BrokerConnectionBinding | undefined;
  action: string;
  platform?: string;
  grantedPlatformOf: (sessionUuid: string) => string | undefined;
}): DeviceOutsideBrokerGrantError | undefined {
  const { binding, action, platform } = input;
  if (!binding || platform === undefined || binding.sessionUuids.size === 0) {
    return undefined;
  }
  for (const sessionUuid of binding.sessionUuids) {
    const grantedPlatform = input.grantedPlatformOf(sessionUuid);
    if (grantedPlatform === undefined || grantedPlatform === platform) {
      return undefined;
    }
  }
  return new DeviceOutsideBrokerGrantError(action, "device", binding.scopeKey, { platform });
}

/** Host-wide mutations cannot be confined to a bound connection's bindings. */
export function brokerConnectionHostMutationRefusal(input: {
  binding: BrokerConnectionBinding | undefined;
  action: string;
}): DeviceOutsideBrokerGrantError | undefined {
  return input.binding
    ? new DeviceOutsideBrokerGrantError(input.action, "host", input.binding.scopeKey)
    : undefined;
}

/**
 * The refusal for a plan's device labels on a bound managed connection (#11397), or undefined when
 * every label is served by one of the connection's own binding sessions. A label mapped to any other
 * session (a derived `${base}:${label}` session) would be handed a device by the generic pool, so
 * it is refused before anything is allocated or booted. `labelSessions` is label -> session.
 */
export function brokerConnectionPlanLabelRefusal(input: {
  binding: BrokerConnectionBinding | undefined;
  action: string;
  labelSessions: Readonly<Record<string, string>>;
}): DeviceOutsideBrokerGrantError | undefined {
  const { binding } = input;
  if (!binding) {
    return undefined;
  }
  const outside = Object.entries(input.labelSessions).find(
    ([, sessionUuid]) => !binding.sessionUuids.has(sessionUuid),
  );
  return outside
    ? new DeviceOutsideBrokerGrantError(input.action, "tool", binding.scopeKey, {
        deviceLabel: outside[0],
      })
    : undefined;
}

/**
 * Whether a binding device demonstrably fails the criteria a plan label declares (#11421). A binding
 * serves a label only with its own device, so a declared criterion it does not meet is a refusal,
 * never a silent substitution. The pool's own matcher decides, as for generic allocation.
 * A criterion is evaluated only when the device's fact is known: `platform` always, `simulatorType`
 * and `iosVersion` when the pool recorded them (iOS simulators). An undeclared criterion, or one
 * whose device fact is unknown, is not a reason to refuse.
 */
export function grantedDeviceFailsLabelCriteria(input: {
  declared: DeviceAllocationCriteria | undefined;
  grantedPlatform: PooledDevice["platform"];
  device: PooledDevice | null;
}): boolean {
  const { declared, device } = input;
  if (!declared) {
    return false;
  }
  if (declared.platform && declared.platform !== input.grantedPlatform) {
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
 * The refusal for a plain (not device-aware) tool from a bound managed connection: the binding
 * lifecycle tools always, `setActiveDevice` off-binding. Other plain tools (reads,
 * settings of the connection itself) pass.
 */
export function brokerConnectionPlainToolRefusal(input: {
  binding: BrokerConnectionBinding | undefined;
  toolName: string;
  args: Record<string, unknown>;
  requesterSessionUuid?: string;
  grantedDeviceOf: GrantedSessionDeviceLookup;
}): DeviceOutsideBrokerGrantError | undefined {
  const { binding, toolName, args } = input;
  if (!binding) {
    return undefined;
  }
  if (BROKER_LIFECYCLE_TOOLS.has(toolName)) {
    return new DeviceOutsideBrokerGrantError(toolName, "tool", binding.scopeKey);
  }
  if (toolName === "setActiveDevice") {
    return brokerConnectionControlRefusal({
      binding,
      action: toolName,
      deviceId: stringArg(args.deviceId),
      requesterSessionUuid: input.requesterSessionUuid,
      grantedDeviceOf: input.grantedDeviceOf,
    });
  }
  return undefined;
}

function stringArg(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
