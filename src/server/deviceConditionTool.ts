import type { BootedDevice } from "../models";
import { createStructuredToolResponse } from "../utils/toolUtils";
import type { FeatureFlagReader } from "../features/featureFlags/FeatureFlagService";
import {
  DeviceConditionRegistry,
  defaultDeviceConditionRegistry,
} from "../features/deviceCondition/DeviceConditionRegistry";
import {
  DEVICE_CONDITION_SCHEMA_VERSION,
  type DeviceConditionInput,
} from "../features/deviceCondition/DeviceConditionTypes";
import { attestationCeilingRefusal } from "../features/deviceCondition/attestationCeiling";
import { parseDeviceConditionInput } from "./deviceConditionSchema";

/**
 * The slice of a `setDeviceState` request this handler reads. Typed structurally
 * rather than importing `SetDeviceStateArgs` from `utilityTools`, which would form
 * a type-level import cycle (utilityTools imports this handler as a value).
 */
export interface DeviceConditionCallFields {
  /** Validated at the setDeviceState boundary as `unknown`; parsed here into the typed request. */
  deviceCondition?: unknown;
  sessionUuid?: string;
  doNotDisturb?: unknown;
  biometrics?: unknown;
  connectivity?: unknown;
  networkCondition?: unknown;
  clock?: unknown;
  location?: unknown;
  cameraPoster?: unknown;
  screenLock?: unknown;
  power?: unknown;
}

export interface DeviceConditionToolDeps {
  registry?: DeviceConditionRegistry;
  featureFlags?: FeatureFlagReader;
}

/** The non-deviceCondition setDeviceState fields; mixing them with deviceCondition is refused here. */
const OTHER_DEVICE_STATE_FIELDS: readonly (keyof DeviceConditionCallFields)[] = [
  "doNotDisturb",
  "biometrics",
  "connectivity",
  "networkCondition",
  "clock",
  "location",
  "cameraPoster",
  "screenLock",
  "power",
];

/** Fail closed until the composition root registers the process's feature flags. */
const FLAGS_UNREGISTERED: FeatureFlagReader = { isEnabled: () => false };
let registeredFeatureFlags: FeatureFlagReader = FLAGS_UNREGISTERED;

/**
 * Composition-root seam (#11806): `createMcpServer` registers the process
 * `FeatureFlagService` here instead of this handler calling `getInstance()`.
 * Until then the `device-condition` flag reads as disabled, its default.
 */
export function registerDeviceConditionFeatureFlags(featureFlags: FeatureFlagReader): void {
  registeredFeatureFlags = featureFlags;
}

function refuse(device: BootedDevice, error: string) {
  return createStructuredToolResponse({
    message: error,
    success: false,
    deviceId: device.deviceId,
    platform: device.platform,
    error,
  });
}

/**
 * Handle a setDeviceState call that carries `deviceCondition` (#14050). The surface
 * is gated behind the `device-condition` feature flag, applied through the
 * session-scoped registry, and — in this foundational drop — not combinable with
 * the other setDeviceState fields, so its distinct restore lifecycle stays clean.
 */
/**
 * Every reason to reject a deviceCondition call before it reaches the registry,
 * as a single string or undefined when the request is admissible. Split out so
 * {@link handleDeviceConditionCall} stays within the complexity budget.
 */
function deviceConditionRefusal(
  args: DeviceConditionCallFields,
  input: DeviceConditionInput,
  featureFlags: FeatureFlagReader,
): string | undefined {
  if (!featureFlags.isEnabled("device-condition")) {
    return "deviceCondition is behind the 'device-condition' feature flag, which is disabled.";
  }
  if (OTHER_DEVICE_STATE_FIELDS.some((field) => args[field] !== undefined)) {
    return "deviceCondition cannot be combined with other setDeviceState fields; send it in its own call.";
  }
  if (!DeviceConditionRegistry.isMeaningful(input)) {
    return "deviceCondition requires a reset or at least one condition field.";
  }
  if (input.expiresInSeconds !== undefined && !args.sessionUuid) {
    return "deviceCondition.expiresInSeconds needs a session to enforce the lease; there is no lifecycle owner in direct mode.";
  }
  return undefined;
}

export async function handleDeviceConditionCall(
  device: BootedDevice,
  args: DeviceConditionCallFields,
  deps: DeviceConditionToolDeps = {},
) {
  if (args.deviceCondition === undefined) {
    return refuse(device, "deviceCondition was not provided.");
  }
  const ceiling = attestationCeilingRefusal(args.deviceCondition);
  if (ceiling !== undefined) {
    return refuse(device, ceiling);
  }
  const parsed = parseDeviceConditionInput(args.deviceCondition);
  if (!parsed.ok) {
    return refuse(device, `Invalid deviceCondition: ${parsed.error}`);
  }
  const input: DeviceConditionInput = parsed.value;
  const featureFlags = deps.featureFlags ?? registeredFeatureFlags;
  const refusal = deviceConditionRefusal(args, input, featureFlags);
  if (refusal !== undefined) {
    return refuse(device, refusal);
  }
  const registry = deps.registry ?? defaultDeviceConditionRegistry;
  const result = await registry.apply(
    { deviceId: device.deviceId, sessionUuid: args.sessionUuid, device },
    input,
  );
  return createStructuredToolResponse({
    message: result.success
      ? "Applied device condition"
      : (result.error ?? "Failed to apply device condition"),
    success: result.success,
    deviceId: device.deviceId,
    platform: device.platform,
    version: DEVICE_CONDITION_SCHEMA_VERSION,
    deviceCondition: result,
    ...(result.error ? { error: result.error } : {}),
  });
}

/**
 * Route a `setDeviceState` call that carries `deviceCondition` to
 * {@link handleDeviceConditionCall}; every other call goes to `handler`.
 */
export function withDeviceConditionDispatch<Args extends DeviceConditionCallFields, Result>(
  handler: (device: BootedDevice, args: Args) => Promise<Result>,
) {
  return async (device: BootedDevice, args: Args) =>
    args.deviceCondition !== undefined
      ? handleDeviceConditionCall(device, args)
      : handler(device, args);
}
