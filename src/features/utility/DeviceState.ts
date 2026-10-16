import {
  LocationOperations,
  LocationWriteAdmissionError,
  locationInputError,
  type DeviceLocationState,
  type SetDeviceLocationInput,
} from "./device-state/LocationOperations";
import { ConnectivityOperations } from "./device-state/ConnectivityOperations";
import {
  connectivityInputError,
  type DeviceConnectivityState,
  type SetDeviceConnectivityInput,
} from "./device-state/ConnectivityState";
import {
  MAX_NETWORK_CONDITION_TTL_SECONDS,
  networkConditionInputError,
  type NetworkConditionState,
  type SetNetworkConditionInput,
} from "./device-state/NetworkConditionState";
import { invalidateDisplayCaches } from "../observe/DisplayTransition";
import {
  AndroidDeviceClockAdapter,
  cancellableDeviceClockAdapter,
  defaultDeviceClockRestoreRegistry,
  readDeviceClock,
  writeDeviceClock,
  validateDeviceClockInput,
  preflightDeviceClock,
  clockFailure,
  DeviceClockValidationError,
  type DeviceClockRestoreSlot,
  type DeviceClockRestoreRegistry,
  type PreparedDeviceClock,
  type DeviceClockAdapter,
  type DeviceClockState,
  type SetDeviceClockInput,
} from "./DeviceClock";
import { errorMessage } from "../../utils/describeUnknownError";
import {
  defaultAdbClientFactory,
  type AdbClientFactory,
} from "../../utils/android-cmdline-tools/AdbClientFactory";
import type { BootedDevice, ExecResult } from "../../models";
import { SimCtlClient } from "../../utils/ios-cmdline-tools/SimCtlClient";
import { isIosSimulatorDevice } from "../action/IosSimulatorPermissions";
import { outputLooksLikeShellFailure } from "../../utils/android-cmdline-tools/shellOutputHeuristics";
import {
  writeDeviceCameraPoster,
  type DeviceCameraPosterState,
  type SetDeviceCameraPosterInput,
} from "./DeviceCameraPoster";
import type { QrPosterWriter } from "../../utils/qr/QrPosterWriter";
import {
  emulatorConsoleFailureReason,
  emulatorConsoleReportsFailure,
} from "../../utils/android-cmdline-tools/emulatorConsoleReply";
import { AndroidCtrlProxyClient } from "../observe/android/AndroidCtrlProxyClient";
import { logger } from "../../utils/logger";
import { ActionableError } from "../../models/ActionableError";
import { defaultLocationRouteRegistry, LocationRouteRegistry } from "./LocationRoutePlayer";
import type { Timer } from "../../utils/SystemTimer";
import { defaultTimer } from "../../utils/SystemTimer";
import {
  IOS_NOTIFYUTIL_REGISTERED_SET_TIMEOUT_MS,
  iosNotifyutilGetCommand,
  iosNotifyutilRegisteredSetReadPostCommand,
  parseNotifyutilState,
} from "../../utils/ios-cmdline-tools/notifyutil";
import { z } from "zod/v4";
import {
  ExecNetworkFilterBridge,
  type NetworkFilterBridge,
} from "../network-filter/NetworkFilterBridge";
import type { IosAppNetworkRuleCommandContext } from "../network-filter/IosAppNetworkRuleClient";
import {
  defaultEmulatorConsoleClientFactory,
  type EmulatorConsoleClientFactory,
} from "../action/Telephony";
import { NetworkConditionOperations } from "./device-state/NetworkConditionOperations";

export type {
  DeviceLocationState,
  SetDeviceLocationInput,
} from "./device-state/LocationOperations";
export type {
  DeviceConnectivityField,
  DeviceConnectivityState,
} from "./device-state/ConnectivityState";
export {
  ANDROID_CONNECTIVITY_READ_COMMAND,
  parseAndroidConnectivityOutput,
} from "./device-state/ConnectivityState";

export {
  networkConditionProfileSchema,
  NETWORK_CONDITION_PROFILES,
  MAX_NETWORK_CONDITION_TTL_SECONDS,
  IOS_APP_NETWORK_CONDITION_LIMITATIONS,
  iosAppNetworkRuleOutcome,
  parseEmulatorNetworkStatus,
  classifyNetworkConditionRequest,
  networkConditionInputIsRequest,
  networkConditionInputError,
  networkConditionInputDegrades,
} from "./device-state/NetworkConditionState";
export type {
  NetworkConditionProfile,
  NetworkConditionCapability,
  NetworkConditionValues,
  NetworkConditionBackendState,
  IosAppNetworkRuleState,
  NetworkConditionState,
  SetNetworkConditionInput,
  NetworkConditionRequestKind,
} from "./device-state/NetworkConditionState";

export type { DeviceClockState, SetDeviceClockInput } from "./DeviceClock";
export type { DeviceCameraPosterState, SetDeviceCameraPosterInput };

export const doNotDisturbModeSchema = z.enum(["off", "none", "priority", "alarms"]);
export type DoNotDisturbMode = z.infer<typeof doNotDisturbModeSchema>;

/**
 * Machine-readable description of how faithfully a platform can apply a
 * requested Do Not Disturb mode:
 * - `full`: every mode (`off`/`none`/`priority`/`alarms`) is distinct, persisted
 *   and verifiable (Android via `zen_mode`).
 * - `binary`: only on/off is available; `priority`/`alarms` cannot be honored as
 *   distinct tiers (iOS simulator via the `com.apple.donotdisturb.enabled`
 *   Darwin notification — there is no public per-mode Focus API).
 * - `unsupported`: DND cannot be set at all (physical iOS device — iOS exposes no
 *   public API to enable/disable Focus or Do Not Disturb).
 */
export type DoNotDisturbCapability = "full" | "binary" | "unsupported";

export interface DoNotDisturbState {
  supported: boolean;
  enabled?: boolean;
  mode?: DoNotDisturbMode;
  rawValue?: string;
  method?: "android_settings_zen_mode" | "android_cmd_notification" | "ios_simulator_notifyutil";
  bestEffort?: boolean;
  verified?: boolean;
  warning?: string;
  error?: string;
  /** How faithfully the platform can apply the requested mode. */
  capability?: DoNotDisturbCapability;
  /** What the caller asked for (set on writes). */
  requestedMode?: DoNotDisturbMode;
  /** What the platform could actually apply (set on writes). */
  appliedMode?: DoNotDisturbMode;
}

export const biometricEnrollmentSchema = z.enum(["enrolled", "not_enrolled"]);
export type BiometricEnrollment = z.infer<typeof biometricEnrollmentSchema>;

export interface BiometricEnrollmentState {
  supported: boolean;
  enrollment?: BiometricEnrollment;
  method?: "ios_simulator_notifyutil";
  verified?: boolean;
  error?: string;
}

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
  doNotDisturb?: {
    enabled?: boolean;
    mode?: DoNotDisturbMode;
  };
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
interface SelectedDeviceStates {
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
type SelectedDeviceState = NonNullable<SelectedDeviceStates[keyof SelectedDeviceStates]>;

interface IosSimulatorClient {
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

type RequestedDeviceStates = Pick<
  DeviceStateResult,
  | "doNotDisturb"
  | "biometrics"
  | "connectivity"
  | "networkCondition"
  | "location"
  | "clock"
  | "cameraPoster"
>;

const IOS_BIOMETRIC_ENROLLMENT_NOTIFICATION = "com.apple.BiometricKit.enrollmentChanged";
const IOS_BIOMETRICS_UNSUPPORTED_ERROR =
  "Biometric enrollment state can only be read or set on an iOS Simulator.";

/**
 * Physical iOS devices expose no public API to enable/disable Focus or Do Not
 * Disturb. The only sanctioned app-side hook is the read-only Focus Filter API
 * (apps react to an active Focus, they cannot set one), and Apple's device
 * tooling (devicectl, XCUITest) ships no DND/Focus setter. Simulators are no
 * better off (see IOS_SIM_DND_UNSUPPORTED_ERROR) — DND automation is
 * unavailable on iOS entirely — but the two carry distinct errors so callers
 * can tell a device limitation from a daemon-owned key.
 */
const IOS_PHYSICAL_DND_UNSUPPORTED_ERROR =
  "Do Not Disturb cannot be set on a physical iOS device: iOS exposes no public API to " +
  "enable/disable Focus or Do Not Disturb (only the read-only Focus Filter API), and Apple's " +
  "device tooling (devicectl, XCUITest) ships no DND/Focus setter. Trigger DND manually or via a " +
  "Shortcuts automation on device.";

/**
 * Do Not Disturb is unsupported on **every** iOS simulator runtime, not just
 * iOS 18+. DND/Focus is owned by the private `com.apple.donotdisturbd` daemon,
 * which shipped with Focus in iOS 15 and reclaims the legacy
 * `com.apple.donotdisturb.enabled` Darwin notification: a value posted with the
 * `notifyutil -1 -s -g -p` shape reads back as `0` from a fresh process, while
 * an unmanaged notify key (BiometricKit's) set the very same way persists as
 * `1`. So the legacy key neither reflects nor controls real Focus state — a
 * write is an unverifiable no-op and a read is a confident falsehood.
 *
 * Empirically verified (issue #2862) on booted simulators, `donotdisturbd`
 * running in each: **iOS 16.4 (20E247)** and **iOS 17.5 (21F79)** both revert
 * the key while the control key persists, matching the previously-recorded
 * iOS 18.x and 26.x behavior. iOS 15 could not be tested because Xcode 26.3
 * offers no iOS 15 simulator runtime for download — which also means no iOS 15
 * simulator can be created with current tooling, so the old `<= 17` legacy
 * fast-path was unreachable in practice as well as wrong.
 */
const IOS_SIM_DND_UNSUPPORTED_ERROR =
  "Do Not Disturb cannot be read or set on an iOS simulator: Do Not Disturb is owned by the " +
  "private donotdisturbd Focus daemon, which holds the state in its own store and resets the " +
  "legacy com.apple.donotdisturb.enabled notification — so that notification neither reflects " +
  "nor controls the real Focus state. iOS exposes no public API to read or set Focus / Do Not " +
  "Disturb. Set it manually in the simulator, or via a Shortcuts automation.";

export { emulatorConsoleReportsFailure, emulatorConsoleFailureReason };

function parseAndroidZenMode(raw: string): DoNotDisturbState {
  const value = raw.trim();
  switch (value) {
    case "0":
      return {
        supported: true,
        capability: "full",
        enabled: false,
        mode: "off",
        rawValue: value,
        method: "android_settings_zen_mode",
      };
    case "1":
      return {
        supported: true,
        capability: "full",
        enabled: true,
        mode: "priority",
        rawValue: value,
        method: "android_settings_zen_mode",
      };
    case "2":
      return {
        supported: true,
        capability: "full",
        enabled: true,
        mode: "none",
        rawValue: value,
        method: "android_settings_zen_mode",
      };
    case "3":
      return {
        supported: true,
        capability: "full",
        enabled: true,
        mode: "alarms",
        rawValue: value,
        method: "android_settings_zen_mode",
      };
    default:
      return {
        supported: true,
        capability: "full",
        rawValue: value,
        method: "android_settings_zen_mode",
        warning: `Unknown Android zen_mode value: ${value}`,
      };
  }
}

function modeForInput(input: SetDeviceStateInput["doNotDisturb"]): DoNotDisturbMode {
  if (input?.mode) {
    return input.mode;
  }
  return input?.enabled === false ? "off" : "none";
}

export const EMPTY_STATE_SELECTION_ERROR = "At least one device state field must be included";

/** True when a `setState` call carries no device-state field to apply. */
function setDeviceStateInputIsEmpty(input: SetDeviceStateInput): boolean {
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

function doNotDisturbInputError(input: SetDeviceStateInput["doNotDisturb"]): string | undefined {
  if (!input || input.enabled === undefined || input.mode === undefined) {
    return undefined;
  }
  if ((input.enabled === false) !== (input.mode === "off")) {
    return `doNotDisturb.enabled=${input.enabled} conflicts with doNotDisturb.mode="${input.mode}"`;
  }
  return undefined;
}

function setDeviceStateInputError(input: SetDeviceStateInput): string | undefined {
  return (
    doNotDisturbInputError(input.doNotDisturb) ??
    connectivityInputError(input.connectivity) ??
    locationInputError(input.location)
  );
}

/** Validate every combined input before a clock or any other field can mutate. */
function validateClockCombinedInputs(input: SetDeviceStateInput): void {
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

export class DeviceState {
  private device: BootedDevice;

  private adbFactory: AdbClientFactory;

  private simctl: IosSimulatorClient | null;

  private timer: Timer;
  private consoleFactory: EmulatorConsoleClientFactory;
  private routeRegistry: LocationRouteRegistry;
  private readonly canWriteLocation: () => boolean;
  private readonly onLocationApplied?: () => void;
  private readonly clockAdapter: DeviceClockAdapter;
  private readonly clockRestoreRegistry: DeviceClockRestoreRegistry;
  private readonly clockSignal: AbortSignal;
  private readonly clockMutation: NonNullable<DeviceStateDependencies["clockMutation"]>;
  private readonly invalidateClockCaches: (deviceId: string) => void;
  private readonly cameraPosterQrWriter?: QrPosterWriter;
  private readonly cameraPosterFileExists?: (path: string) => boolean;
  private injectedNetworkFilterBridge?: NetworkFilterBridge;
  private readonly iosAppNetworkRule?: () => IosAppNetworkRuleCommandContext | undefined;

  private readonly networkCondition = new NetworkConditionOperations({
    device: () => this.device,
    adbFactory: () => this.adbFactory,
    timer: () => this.timer,
    networkFilterBridge: () => this.networkFilterBridge,
    iosAppNetworkRule: () => this.iosAppNetworkRule?.(),
  });

  private readonly location = new LocationOperations({
    device: () => this.device,
    adbFactory: () => this.adbFactory,
    simctl: () => this.simctl,
    routeRegistry: () => this.routeRegistry,
    consoleFactory: () => this.consoleFactory,
    canWriteLocation: () => this.canWriteLocation(),
    onLocationApplied: () => this.onLocationApplied,
  });

  private readonly connectivity = new ConnectivityOperations({
    device: () => this.device,
    adbFactory: () => this.adbFactory,
  });

  constructor(device: BootedDevice, dependencies: DeviceStateDependencies = {}) {
    this.device = device;
    this.clockRestoreRegistry =
      dependencies.clockRestoreRegistry ?? defaultDeviceClockRestoreRegistry;
    this.clockSignal = this.clockRestoreRegistry.signal(device.deviceId);
    this.adbFactory = dependencies.adbFactory ?? defaultAdbClientFactory;
    this.clockAdapter = cancellableDeviceClockAdapter(
      dependencies.clockAdapter ??
        new AndroidDeviceClockAdapter(
          {
            executeCommand: (...args) =>
              this.adbFactory.create(this.device).executeCommand(...args),
          },
          this.clockSignal,
        ),
      this.clockSignal,
    );
    this.timer = dependencies.timer ?? defaultTimer;
    this.clockMutation = dependencies.clockMutation ?? ((mutation) => mutation());
    this.invalidateClockCaches =
      dependencies.invalidateClockCaches ??
      ((deviceId) => invalidateDisplayCaches(deviceId, "Device clock changed"));
    this.cameraPosterQrWriter = dependencies.cameraPosterQrWriter;
    this.cameraPosterFileExists = dependencies.cameraPosterFileExists;
    this.simctl = dependencies.simctl ?? null;
    this.consoleFactory = dependencies.consoleFactory ?? defaultEmulatorConsoleClientFactory;
    this.routeRegistry = dependencies.routeRegistry ?? defaultLocationRouteRegistry;
    this.canWriteLocation = dependencies.canWriteLocation ?? (() => true);
    this.onLocationApplied = dependencies.onLocationApplied;
    this.injectedNetworkFilterBridge = dependencies.networkFilterBridge;
    this.iosAppNetworkRule = dependencies.iosAppNetworkRule;
  }

  /** Created on first iOS Simulator network read so other paths never touch it. */
  private get networkFilterBridge(): NetworkFilterBridge {
    this.injectedNetworkFilterBridge ??= new ExecNetworkFilterBridge();
    return this.injectedNetworkFilterBridge;
  }

  async getState(
    include: readonly DeviceStateField[] = DEFAULT_DEVICE_STATE_FIELDS,
  ): Promise<DeviceStateResult> {
    // An empty selection would otherwise read nothing and report success.
    if (include.length === 0) {
      return {
        success: false,
        deviceId: this.device.deviceId,
        platform: this.device.platform,
        error: EMPTY_STATE_SELECTION_ERROR,
      };
    }
    const selected = await this.readSelectedStates(include);
    const requestedStates = Object.values(selected).filter(
      (state): state is SelectedDeviceState => state !== undefined,
    );
    // Every read path uses supported:false only for a static platform limitation;
    // supported reads carry errors for genuine probe failures.
    const unsupported = Object.entries(selected)
      .filter(([, state]) => state !== undefined && !state.supported)
      .map(([field]) => field as DeviceStateField);
    const failedState = requestedStates.find((state) => state.supported && state.error);

    return {
      success: !failedState,
      deviceId: this.device.deviceId,
      platform: this.device.platform,
      ...(this.device.displays ? { displays: this.device.displays } : {}),
      ...selected,
      ...(unsupported.length > 0 ? { unsupported } : {}),
      ...(failedState?.error ? { error: failedState.error } : {}),
    };
  }

  /**
   * Read exactly the selected fields, in report order. Kept separate from
   * `getState` so the selection branching does not compound with the
   * success/error aggregation in one function.
   */
  private async readSelectedStates(
    include: readonly DeviceStateField[],
  ): Promise<SelectedDeviceStates> {
    return {
      ...(include.includes("clock")
        ? { clock: await readDeviceClock(this.device, this.clockAdapter) }
        : {}),
      ...(include.includes("doNotDisturb") ? { doNotDisturb: await this.readDoNotDisturb() } : {}),
      ...(include.includes("connectivity") ? { connectivity: await this.readConnectivity() } : {}),
      ...(include.includes("biometrics")
        ? { biometrics: await this.getBiometricEnrollmentState() }
        : {}),
      ...(include.includes("networkCondition")
        ? { networkCondition: await this.readNetworkCondition() }
        : {}),
    };
  }

  async setState(input: SetDeviceStateInput): Promise<DeviceStateResult> {
    if (input.clock !== undefined) {
      validateDeviceClockInput(input.clock);
      validateClockCombinedInputs(input);
    }
    if (setDeviceStateInputIsEmpty(input)) {
      return {
        success: false,
        deviceId: this.device.deviceId,
        platform: this.device.platform,
        error: "At least one device state field must be provided",
      };
    }

    const inputError = setDeviceStateInputError(input);
    if (inputError) {
      if (input.clock || input.location?.mode === "route" || input.location?.mode === "stop") {
        throw new ActionableError(inputError);
      }
      return {
        success: false,
        deviceId: this.device.deviceId,
        platform: this.device.platform,
        error: inputError,
      };
    }

    const states = input.clock
      ? await this.writeClockCombinedStates(input)
      : await this.writeRequestedStates(input);
    const requestedStates = Object.values(states).filter(
      (
        state,
      ): state is
        | DoNotDisturbState
        | BiometricEnrollmentState
        | DeviceConnectivityState
        | NetworkConditionState
        | DeviceLocationState
        | DeviceClockState
        | DeviceCameraPosterState => state !== undefined,
    );
    const error = requestedStates.find((state) => state.error)?.error;

    return {
      success: requestedStates.every(
        (state) => state.supported && !state.error && state.verified !== false,
      ),
      deviceId: this.device.deviceId,
      platform: this.device.platform,
      ...states,
      ...(error ? { error } : {}),
    };
  }

  private async writeClockCombinedStates(
    input: SetDeviceStateInput,
  ): Promise<RequestedDeviceStates> {
    try {
      // Track session setup before taking the device lock. Release drains those
      // setups first, then takes this same lock for restoration.
      return await this.clockMutation((sessionSlot) =>
        this.clockRestoreRegistry.runExclusive(
          this.device.deviceId,
          async (slot) => {
            const preflight = await this.preflightClock(input.clock);
            this.clockSignal.throwIfAborted();
            return this.writeRequestedStates(input, preflight.prepared, preflight.failure, slot);
          },
          sessionSlot,
          this.clockSignal,
        ),
      );
    } catch (error) {
      if (
        error instanceof DeviceClockValidationError ||
        error instanceof LocationWriteAdmissionError
      ) {
        throw error;
      }
      logger.warn(`Clock mutation failed for ${this.device.deviceId}`, error);
      return { clock: clockFailure(error) };
    }
  }

  private async preflightClock(
    input: SetDeviceClockInput | undefined,
  ): Promise<{ prepared?: PreparedDeviceClock; failure?: DeviceClockState }> {
    return input?.mode === "advance"
      ? preflightDeviceClock(this.device, this.clockAdapter, input)
      : {};
  }

  /** Write exactly the mutation fields supplied by the caller. */
  private async writeRequestedStates(
    input: SetDeviceStateInput,
    preparedClock?: PreparedDeviceClock,
    failedClock?: DeviceClockState,
    slot?: DeviceClockRestoreSlot,
  ): Promise<RequestedDeviceStates> {
    return {
      ...(input.doNotDisturb
        ? { doNotDisturb: await this.writeDoNotDisturb(input.doNotDisturb) }
        : {}),
      ...(input.biometrics
        ? { biometrics: await this.setBiometricEnrollmentState(input.biometrics.enrollment) }
        : {}),
      ...(input.connectivity
        ? { connectivity: await this.writeConnectivity(input.connectivity) }
        : {}),
      ...(input.networkCondition
        ? { networkCondition: await this.writeNetworkCondition(input.networkCondition) }
        : {}),
      ...(input.location ? { location: await this.writeLocation(input.location) } : {}),
      ...(input.clock
        ? { clock: failedClock ?? (await this.writeClock(input.clock, preparedClock, slot)) }
        : {}),
      ...(input.cameraPoster
        ? {
            cameraPoster: await writeDeviceCameraPoster(this.device, input.cameraPoster, {
              adbFactory: this.adbFactory,
              qrWriter: this.cameraPosterQrWriter,
              fileExists: this.cameraPosterFileExists,
            }),
          }
        : {}),
    };
  }

  private async writeClock(
    input: SetDeviceClockInput,
    prepared?: PreparedDeviceClock,
    slot?: DeviceClockRestoreSlot,
  ): Promise<DeviceClockState> {
    try {
      return await writeDeviceClock(
        this.device,
        this.clockAdapter,
        input,
        slot,
        {
          hostClock: this.timer,
          invalidate: this.invalidateClockCaches,
          restoreRegistry: this.clockRestoreRegistry,
          mutationSignal: this.clockSignal,
        },
        prepared,
      );
    } catch (error) {
      logger.warn(`Clock mutation failed for ${this.device.deviceId}`, error);
      return clockFailure(error);
    }
  }

  private writeLocation(input: SetDeviceLocationInput): Promise<DeviceLocationState> {
    return this.location.writeLocation(input);
  }

  async getBiometricEnrollmentState(): Promise<BiometricEnrollmentState> {
    if (this.device.platform !== "ios" || !isIosSimulatorDevice(this.device)) {
      return { supported: false, error: IOS_BIOMETRICS_UNSUPPORTED_ERROR };
    }
    const simctl = this.simctl ?? new SimCtlClient(this.device);
    try {
      const result = await simctl.executeCommand(
        iosNotifyutilGetCommand(this.device.deviceId, IOS_BIOMETRIC_ENROLLMENT_NOTIFICATION),
      );
      const stderr = result.stderr?.trim();
      if (stderr) {
        return {
          supported: true,
          method: "ios_simulator_notifyutil",
          error: `notifyutil failed: ${stderr}`,
        };
      }
      const enrolled = parseNotifyutilState(result.stdout);
      if (enrolled === null) {
        return {
          supported: true,
          method: "ios_simulator_notifyutil",
          error: "Could not parse iOS Simulator biometric enrollment state from notifyutil.",
        };
      }
      return {
        supported: true,
        enrollment: enrolled ? "enrolled" : "not_enrolled",
        method: "ios_simulator_notifyutil",
        verified: true,
      };
    } catch (error) {
      return {
        supported: true,
        method: "ios_simulator_notifyutil",
        error: errorMessage(error),
      };
    }
  }

  async setBiometricEnrollmentState(
    enrollment: BiometricEnrollment,
  ): Promise<BiometricEnrollmentState> {
    if (this.device.platform !== "ios" || !isIosSimulatorDevice(this.device)) {
      return {
        supported: false,
        enrollment,
        verified: false,
        error: IOS_BIOMETRICS_UNSUPPORTED_ERROR,
      };
    }
    const simctl = this.simctl ?? new SimCtlClient(this.device);
    try {
      const result = await simctl.executeCommand(
        iosNotifyutilRegisteredSetReadPostCommand(
          this.device.deviceId,
          IOS_BIOMETRIC_ENROLLMENT_NOTIFICATION,
          enrollment === "enrolled" ? "1" : "0",
        ),
        IOS_NOTIFYUTIL_REGISTERED_SET_TIMEOUT_MS,
      );
      const stderr = result.stderr?.trim();
      if (stderr) {
        return {
          supported: true,
          enrollment,
          method: "ios_simulator_notifyutil",
          verified: false,
          error: `notifyutil failed: ${stderr}`,
        };
      }
      const enrolled = parseNotifyutilState(result.stdout);
      const verified = enrolled === (enrollment === "enrolled");
      return {
        supported: true,
        ...(enrolled === null ? {} : { enrollment: enrolled ? "enrolled" : "not_enrolled" }),
        method: "ios_simulator_notifyutil",
        verified,
        ...(verified
          ? {}
          : {
              error: `iOS Simulator biometric enrollment did not verify: expected ${enrollment}.`,
            }),
      };
    } catch (error) {
      return {
        supported: true,
        enrollment,
        method: "ios_simulator_notifyutil",
        verified: false,
        error: errorMessage(error),
      };
    }
  }

  /** Platform dispatch for reading Do Not Disturb, kept off the getState hot path. */
  private readDoNotDisturb(): Promise<DoNotDisturbState> {
    return this.device.platform === "android"
      ? this.getAndroidDoNotDisturb()
      : this.getIosDoNotDisturb();
  }

  /** Platform dispatch for reading the device-level connectivity toggles. */
  private readConnectivity(): Promise<DeviceConnectivityState> {
    return this.connectivity.readConnectivity();
  }

  /** Platform dispatch for writing device-level connectivity toggles. */
  private writeConnectivity(input: SetDeviceConnectivityInput): Promise<DeviceConnectivityState> {
    return this.connectivity.writeConnectivity(input);
  }

  /** Platform dispatch for writing Do Not Disturb. */
  private writeDoNotDisturb(
    input: SetDeviceStateInput["doNotDisturb"],
  ): Promise<DoNotDisturbState> {
    return this.device.platform === "android"
      ? this.setAndroidDoNotDisturb(input)
      : this.setIosDoNotDisturb(input);
  }

  /** Platform dispatch for reading the device-wide network condition. */
  private readNetworkCondition(): Promise<NetworkConditionState> {
    return this.networkCondition.read();
  }

  /** Platform dispatch for writing the device-wide network condition. */
  private writeNetworkCondition(input: SetNetworkConditionInput): Promise<NetworkConditionState> {
    return this.networkCondition.write(input);
  }

  private async getAndroidDoNotDisturb(): Promise<DoNotDisturbState> {
    try {
      const a11y = AndroidCtrlProxyClient.getInstance(this.device);
      const a11yResult = await a11y.requestSettingsGet("global", "zen_mode");
      if (a11yResult.success) {
        return parseAndroidZenMode(a11yResult.value ?? "");
      }
    } catch (error) {
      logger.debug(`[DeviceState] a11y zen_mode get failed: ${error}`);
    }
    try {
      const adb = this.adbFactory.create(this.device);
      const result = await adb.executeCommand(
        "shell settings get global zen_mode",
        undefined,
        undefined,
        true,
      );
      return parseAndroidZenMode(result.stdout);
    } catch (error) {
      return {
        supported: true,
        capability: "full",
        error: errorMessage(error),
      };
    }
  }

  private async setAndroidDoNotDisturb(
    input: SetDeviceStateInput["doNotDisturb"],
  ): Promise<DoNotDisturbState> {
    const mode = modeForInput(input);
    try {
      const adb = this.adbFactory.create(this.device);
      const setResult = await adb.executeCommand(
        `shell cmd notification set_dnd ${mode}`,
        undefined,
        undefined,
        true,
      );
      const stdout = setResult.stdout;
      const stderr = setResult.stderr ?? "";
      if (outputLooksLikeShellFailure(stdout, stderr)) {
        return {
          supported: true,
          capability: "full",
          mode,
          method: "android_cmd_notification",
          error: `${stdout}\n${stderr}`.trim() || "cmd notification set_dnd reported an error",
        };
      }
      const state = await this.getAndroidDoNotDisturb();
      const verified = mode === "off" ? state.enabled === false : state.mode === mode;
      return {
        ...state,
        capability: "full",
        method: "android_cmd_notification",
        verified,
        ...(verified
          ? {}
          : {
              warning: `Requested DND mode ${mode}, read back ${state.mode ?? state.rawValue ?? "unknown"}`,
            }),
      };
    } catch (error) {
      return {
        supported: true,
        capability: "full",
        mode,
        method: "android_cmd_notification",
        error: errorMessage(error),
      };
    }
  }

  private async getIosDoNotDisturb(): Promise<DoNotDisturbState> {
    // No iOS target — simulator or physical — can report DND. Simulators are
    // covered by IOS_SIM_DND_UNSUPPORTED_ERROR (donotdisturbd owns the legacy
    // key on every obtainable runtime); physical devices have no public API at
    // all. Neither issues a notifyutil read, because a read would return a
    // confident falsehood (always `0`) rather than the real Focus state.
    return {
      supported: false,
      capability: "unsupported",
      error: isIosSimulatorDevice(this.device)
        ? IOS_SIM_DND_UNSUPPORTED_ERROR
        : IOS_PHYSICAL_DND_UNSUPPORTED_ERROR,
    };
  }

  private async setIosDoNotDisturb(
    input: SetDeviceStateInput["doNotDisturb"],
  ): Promise<DoNotDisturbState> {
    const requestedMode = modeForInput(input);

    // Neither iOS simulators nor physical devices can have DND set. The legacy
    // com.apple.donotdisturb.enabled notification is owned and reset by the
    // donotdisturbd Focus daemon on every runtime we can obtain, so writing it
    // would post a notification that changes nothing and cannot be verified.
    // Return without issuing any notifyutil write rather than reporting a
    // best-effort success that is really a no-op.
    return {
      supported: false,
      capability: "unsupported",
      requestedMode,
      verified: false,
      error: isIosSimulatorDevice(this.device)
        ? IOS_SIM_DND_UNSUPPORTED_ERROR
        : IOS_PHYSICAL_DND_UNSUPPORTED_ERROR,
    };
  }
}
