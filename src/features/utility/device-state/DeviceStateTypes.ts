import type { BootedDevice, ExecResult } from "../../../models";
import { ActionableError } from "../../../models/ActionableError";
import type { AdbClientFactory } from "../../../utils/android-cmdline-tools/AdbClientFactory";
import type { Timer } from "../../../utils/SystemTimer";
import type { QrPosterWriter } from "../../../utils/qr/QrPosterWriter";
import type { EmulatorConsoleClientFactory } from "../../action/Telephony";
import type { NetworkFilterBridge } from "../../network-filter/NetworkFilterBridge";
import type { IosAppNetworkRuleCommandContext } from "../../network-filter/IosAppNetworkRuleClient";
import type { LocationRouteRegistry } from "../LocationRoutePlayer";
import type {
  DeviceClockAdapter,
  DeviceClockRestoreRegistry,
  DeviceClockRestoreSlot,
  DeviceClockState,
  SetDeviceClockInput,
} from "../DeviceClock";
import type { DeviceCameraPosterState, SetDeviceCameraPosterInput } from "../DeviceCameraPoster";
import {
  locationInputError,
  type DeviceLocationState,
  type SetDeviceLocationInput,
} from "./LocationOperations";
import {
  connectivityInputError,
  type DeviceConnectivityState,
  type SetDeviceConnectivityInput,
} from "./ConnectivityState";
import {
  MAX_NETWORK_CONDITION_TTL_SECONDS,
  networkConditionInputError,
  type NetworkConditionState,
  type SetNetworkConditionInput,
} from "./NetworkConditionState";
import {
  doNotDisturbInputError,
  type DoNotDisturbInput,
  type DoNotDisturbState,
} from "./DoNotDisturbState";
import {
  biometricEnrollmentSchema,
  type BiometricEnrollment,
  type BiometricEnrollmentState,
} from "./BiometricState";

export interface DeviceStateResult {
  success: boolean;
  deviceId: string;
  platform: "android" | "ios";
  displays?: BootedDevice["displays"];
  doNotDisturb?: DoNotDisturbState;
  connectivity?: DeviceConnectivityState;
  biometrics?: BiometricEnrollmentState;
  networkCondition?: NetworkConditionState;
  location?: DeviceLocationState;
  clock?: DeviceClockState;
  cameraPoster?: DeviceCameraPosterState;
  /** Requested fields skipped because the current platform cannot support them. */
  unsupported?: DeviceStateField[];
  error?: string;
}

export interface SetDeviceStateInput {
  doNotDisturb?: DoNotDisturbInput;
  biometrics?: {
    enrollment: BiometricEnrollment;
  };
  connectivity?: SetDeviceConnectivityInput;
  networkCondition?: SetNetworkConditionInput;
  location?: SetDeviceLocationInput;
  clock?: SetDeviceClockInput;
  cameraPoster?: SetDeviceCameraPosterInput;
}

/**
 * Every field `getState` can read back.
 *
 * `connectivity` is in the DEFAULT selection (see {@link DEFAULT_DEVICE_STATE_FIELDS}):
 * the whole point of issue #6872 is that a bare `getDeviceState {}` must be able
 * to answer "is Airplane mode already on?" before a client flips it.
 */
export const DEVICE_STATE_READABLE_FIELDS = [
  "doNotDisturb",
  "connectivity",
  "biometrics",
  "networkCondition",
  "clock",
] as const;

export type DeviceStateField = (typeof DEVICE_STATE_READABLE_FIELDS)[number];

/**
 * Presence table for the writable fields, keyed by {@link SetDeviceStateInput}
 * itself. Typing it as a total `Record` over `keyof SetDeviceStateInput` is what
 * makes the list below EXHAUSTIVE at build time: a new writable field is a type
 * error here until it is listed, and a key that is not a writable field is an
 * excess-property error.
 */
const DEVICE_STATE_WRITABLE_FIELD_PRESENCE: Record<keyof SetDeviceStateInput, true> = {
  doNotDisturb: true,
  biometrics: true,
  connectivity: true,
  networkCondition: true,
  location: true,
  clock: true,
  cameraPoster: true,
};

/**
 * Every field `setState` can write. The keys come from {@link SetDeviceStateInput},
 * and a unit test compares them with the advertised `setDeviceState` schema.
 * Location and cameraPoster are write-only because neither the applied coordinate nor
 * the camera frame can be read back.
 */
export const DEVICE_STATE_WRITABLE_FIELDS: readonly (keyof SetDeviceStateInput)[] = Object.freeze(
  Object.keys(DEVICE_STATE_WRITABLE_FIELD_PRESENCE) as (keyof SetDeviceStateInput)[],
);

/** What `getState()` reads when the caller names no fields. */
export const DEFAULT_DEVICE_STATE_FIELDS: readonly DeviceStateField[] = Object.freeze([
  "doNotDisturb",
  "connectivity",
]);

/** The per-field states a single `getState` call actually read. */
export interface SelectedDeviceStates {
  doNotDisturb?: DoNotDisturbState;
  connectivity?: DeviceConnectivityState;
  biometrics?: BiometricEnrollmentState;
  networkCondition?: NetworkConditionState;
  clock?: DeviceClockState;
}

/**
 * Any one of those. Every member carries `supported` and an optional `error`,
 * which is all the success/error aggregation in `getState` needs.
 */
export type SelectedDeviceState = NonNullable<SelectedDeviceStates[keyof SelectedDeviceStates]>;

export interface IosSimulatorClient {
  executeCommand(command: string, timeoutMs?: number): Promise<ExecResult>;
  executeCommandArgs?(
    args: string[],
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<ExecResult>;
}

export interface DeviceStateDependencies {
  adbFactory?: AdbClientFactory;
  simctl?: IosSimulatorClient | null;
  timer?: Timer;
  consoleFactory?: EmulatorConsoleClientFactory;
  routeRegistry?: LocationRouteRegistry;
  canWriteLocation?: () => boolean;
  /** Session attribution is supplied by the handler, never inferred from write admission. */
  onLocationApplied?: () => void;
  /** Renders `cameraPoster` QR payloads; defaults to the file-backed poster writer. */
  cameraPosterQrWriter?: QrPosterWriter;
  cameraPosterFileExists?: (path: string) => boolean;
  clockAdapter?: DeviceClockAdapter;
  clockRestoreRegistry?: DeviceClockRestoreRegistry;
  invalidateClockCaches?: (deviceId: string) => void;
  clockMutation?: (
    mutation: (slot?: DeviceClockRestoreSlot) => Promise<RequestedDeviceStates>,
  ) => Promise<RequestedDeviceStates>;
  /** iOS Simulator network-extension controller; defaults to the installed controller. */
  networkFilterBridge?: NetworkFilterBridge;
  /**
   * iOS Simulator per-app rules: the session ownership for the rule command in
   * flight. Absent (or returning `undefined`) outside a session, where iOS app
   * conditions are refused because nothing would renew or remove the rule.
   */
  iosAppNetworkRule?: () => IosAppNetworkRuleCommandContext | undefined;
}

export type RequestedDeviceStates = Pick<
  DeviceStateResult,
  | "doNotDisturb"
  | "biometrics"
  | "connectivity"
  | "networkCondition"
  | "location"
  | "clock"
  | "cameraPoster"
>;

export const EMPTY_STATE_SELECTION_ERROR = "At least one device state field must be included";

/** True when a `setState` call carries no device-state field to apply. */
export function setDeviceStateInputIsEmpty(input: SetDeviceStateInput): boolean {
  return (
    !input.doNotDisturb &&
    !input.biometrics &&
    !input.connectivity &&
    !input.networkCondition &&
    !input.location &&
    !input.clock &&
    !input.cameraPoster
  );
}

export function setDeviceStateInputError(input: SetDeviceStateInput): string | undefined {
  return (
    doNotDisturbInputError(input.doNotDisturb) ??
    connectivityInputError(input.connectivity) ??
    locationInputError(input.location)
  );
}

/** Validate every combined input before a clock or any other field can mutate. */
export function validateClockCombinedInputs(input: SetDeviceStateInput): void {
  if (
    input.biometrics &&
    !biometricEnrollmentSchema.safeParse(input.biometrics.enrollment).success
  ) {
    throw new ActionableError('biometrics.enrollment must be "enrolled" or "not_enrolled"');
  }
  if (!input.networkCondition) {
    return;
  }
  const network = input.networkCondition;
  const invalid = networkConditionInputError(network);
  if (invalid) {
    throw new ActionableError(invalid);
  }
  const ranges = [
    [network.delayMs, Infinity],
    [network.downloadKbps, Infinity],
    [network.uploadKbps, Infinity],
    [network.packetLossPercent, 100],
    [network.expiresInSeconds, MAX_NETWORK_CONDITION_TTL_SECONDS],
  ];
  if (
    ranges.some(
      ([value, max]) =>
        value !== undefined && (!Number.isFinite(value) || value < 0 || value > max!),
    )
  ) {
    throw new ActionableError(
      "Network condition values must be finite, non-negative and within their schema bounds",
    );
  }
}
