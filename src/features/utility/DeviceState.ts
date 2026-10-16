import {
  MAX_NETWORK_CONDITION_TTL_SECONDS,
  networkConditionInputError,
  wifiToggleCommand,
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
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
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
import {
  defaultLocationRouteRegistry,
  LocationRouteRegistry,
  routeDistanceMeters,
  type LocationWaypoint,
  type EndedLocationRoute,
} from "./LocationRoutePlayer";
import type { Timer } from "../../utils/SystemTimer";
import { defaultTimer } from "../../utils/SystemTimer";
import {
  IOS_NOTIFYUTIL_REGISTERED_SET_TIMEOUT_MS,
  iosNotifyutilGetCommand,
  iosNotifyutilRegisteredSetReadPostCommand,
  parseNotifyutilState,
} from "../../utils/ios-cmdline-tools/notifyutil";
import { shellQuote } from "../../utils/shellQuote";
import { z } from "zod/v4";
import {
  ExecNetworkFilterBridge,
  type NetworkFilterBridge,
} from "../network-filter/NetworkFilterBridge";
import type { IosAppNetworkRuleCommandContext } from "../network-filter/IosAppNetworkRuleClient";
import {
  consolePortFromSerial,
  type EmulatorConsoleClient,
} from "../../utils/android-cmdline-tools/EmulatorConsoleClient";
import {
  defaultEmulatorConsoleClientFactory,
  type EmulatorConsoleClientFactory,
} from "../action/Telephony";
import { NetworkConditionOperations } from "./device-state/NetworkConditionOperations";

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

/**
 * Device-level connectivity toggles (issue #6872). Each field is
 * `boolean | undefined`: `undefined` means "could not be read" — the key is
 * absent on this API level, the value did not parse, or the read failed — and is
 * never conflated with `false`. A single unreadable key never throws and never
 * fails its siblings; it is recorded in `rawValues`/`warning` instead.
 */
export interface DeviceConnectivityState {
  supported: boolean;
  /** `settings get global airplane_mode_on`. */
  airplaneMode?: boolean;
  /** `settings get global wifi_on` (1/2 on, 0/3 off — 2 and 3 are airplane-mode states). */
  wifiEnabled?: boolean;
  /** `settings get global bluetooth_on` (1 on — 0 and 2 off, 2 being disabled BY airplane mode). */
  bluetoothEnabled?: boolean;
  /** `settings --user current get secure location_mode` != 0. */
  locationEnabled?: boolean;
  method?: "android_settings_batch";
  /** Verbatim per-field values, so an unparsed key stays diagnosable. */
  rawValues?: Partial<Record<DeviceConnectivityField, string>>;
  /** Names the keys that could not be read, when at least one other could. */
  warning?: string;
  /** Whether every requested connectivity toggle read back at its desired state. */
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
  connectivity?: {
    airplaneMode?: boolean;
    wifiEnabled?: boolean;
    bluetoothEnabled?: boolean;
    locationEnabled?: boolean;
  };
  networkCondition?: SetNetworkConditionInput;
  location?: SetDeviceLocationInput;
  clock?: SetDeviceClockInput;
  cameraPoster?: SetDeviceCameraPosterInput;
}

export type SetDeviceLocationInput =
  | { mode: "static"; latitude: number; longitude: number }
  | {
      mode: "route";
      waypoints: LocationWaypoint[];
      speedMetersPerSecond?: number;
      durationMs?: number;
      loop?: boolean;
      updateIntervalMs?: number;
    }
  | { mode: "stop" };

export interface DeviceLocationState {
  supported: boolean;
  mode?: "static" | "route" | "stop";
  latitude?: number;
  longitude?: number;
  method?: "android_emulator_console" | "ios_simctl";
  stopped?: boolean;
  previousRoute?: EndedLocationRoute;
  waypointCount?: number;
  totalDistanceMeters?: number;
  expectedDurationMs?: number;
  loop?: boolean;
  updateIntervalMs?: number;
  /** A successful command is an applied fix, not a device location read-back. */
  verified?: boolean;
  error?: string;
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

export type DeviceConnectivityField =
  | "airplaneMode"
  | "wifiEnabled"
  | "bluetoothEnabled"
  | "locationEnabled";

interface ConnectivityReadSpec {
  field: DeviceConnectivityField;
  /**
   * `global` is device-wide; `secure` is PER-USER, so its read must name the
   * user or it answers user 0 while the app under test runs as another
   * (see the `settings --user` reads in `src/doctor/checks/automobile.ts`).
   */
  namespace: "global" | "secure";
  key: string;
  /**
   * `boolean`: 1/0. `nonZero`: any non-zero integer is "on" (location_mode).
   * `wifi`: the four-state `wifi_on` encoding, including its airplane-mode states.
   * `bluetooth`: the three-state `bluetooth_on` encoding, likewise.
   */
  shape: "boolean" | "nonZero" | "wifi" | "bluetooth";
}

/**
 * The four device-level toggles read back for issue #6872, in report order.
 *
 * `location_mode` is deprecated as a WRITE target since API 31 but is still
 * readable on every supported API level (the platform derives it from the
 * enabled location providers), and it is the only single key that answers
 * "is location on at all" — `0` is off, `1`/`2`/`3` are the sensors/battery-saving/
 * high-accuracy tiers, all of which mean on.
 */
const ANDROID_CONNECTIVITY_READS: readonly ConnectivityReadSpec[] = [
  { field: "airplaneMode", namespace: "global", key: "airplane_mode_on", shape: "boolean" },
  { field: "wifiEnabled", namespace: "global", key: "wifi_on", shape: "wifi" },
  { field: "bluetoothEnabled", namespace: "global", key: "bluetooth_on", shape: "bluetooth" },
  { field: "locationEnabled", namespace: "secure", key: "location_mode", shape: "nonZero" },
];

/**
 * ONE adb invocation for all four toggles instead of four round-trips: the
 * device shell runs every `settings get` and labels each answer `<field>=<raw>`,
 * so the response is positionally independent — a key that errors simply yields
 * an empty value rather than shifting every later line onto the wrong field.
 *
 * `2>/dev/null` keeps a per-key failure off the combined stream, so one missing
 * key cannot trip the shared shell-failure heuristic and fail the whole read.
 * Every interpolated value is a compile-time constant from
 * {@link ANDROID_CONNECTIVITY_READS} — no caller input reaches the device shell.
 *
 * Exported so tests script the exact command rather than re-deriving it.
 */
/**
 * `settings` resolves `current` to the foreground user at read time, so the
 * command stays a compile-time constant while still following user switches —
 * no extra `am get-current-user` round-trip, and no stale user id.
 * Device-wide `global` keys are deliberately left unscoped.
 */
const settingsCommand = (read: ConnectivityReadSpec): string =>
  read.namespace === "global"
    ? `settings get global ${read.key}`
    : `settings --user current get ${read.namespace} ${read.key}`;

export const ANDROID_CONNECTIVITY_READ_COMMAND = `shell sh -c ${shellQuote(
  ANDROID_CONNECTIVITY_READS.map(
    (read) => `echo "${read.field}=$(${settingsCommand(read)} 2>/dev/null)"`,
  ).join("; "),
)}`;

/**
 * Airplane mode is not settable — nor readable — on an iOS simulator: there is
 * no simctl verb for the radios, and `simctl status_bar override` only paints
 * the status bar without touching any real connectivity state. Wi-Fi and
 * Bluetooth on a simulator are the HOST's, not the device's, so reporting them
 * would be a confident falsehood about the device under test. Physical iOS
 * exposes no public API for any of the four either.
 */
const IOS_CONNECTIVITY_UNSUPPORTED_ERROR =
  "Device connectivity toggles cannot be read on iOS: Airplane mode, Wi-Fi, Bluetooth and " +
  "Location have no simctl or devicectl read verb. A simulator shares the host's network stack " +
  "(so its Wi-Fi/Bluetooth state is the Mac's, not the device's), and `simctl status_bar " +
  "override` only paints the status bar without changing real connectivity. Read these from " +
  "Settings on the device instead.";

const IOS_CONNECTIVITY_WRITE_UNSUPPORTED_ERROR =
  "Device connectivity toggles cannot be set on iOS: Airplane mode, Wi-Fi, Bluetooth and " +
  "Location have no simctl or devicectl write verb. A simulator shares the host's network stack " +
  "(so changing its Wi-Fi/Bluetooth state would change the Mac, not the device under test), and " +
  "`simctl status_bar override` only paints the status bar without changing real connectivity.";

/**
 * `settings get` prints the literal `null` for an absent key, and the batched
 * script prints an empty value for a key whose read failed. Anything that is not
 * exactly `1` or `0` is unreadable — never coerced — so `undefined` always means
 * "unknown" and `false` always means "the device said 0".
 */
function parseAndroidBooleanSetting(raw: string | undefined): boolean | undefined {
  switch (raw?.trim()) {
    case "1":
      return true;
    case "0":
      return false;
    default:
      return undefined;
  }
}

/**
 * `wifi_on` is NOT a flag: AOSP's `WifiSettingsStore` persists four states, and
 * two of them are the normal ones while airplane mode is on —
 * `2` (WIFI_ENABLED_AIRPLANE_OVERRIDE: Wi-Fi re-enabled on top of airplane mode)
 * and `3` (WIFI_DISABLED_AIRPLANE_ON: Wi-Fi turned off BY airplane mode, to be
 * restored when it is turned off again). Reading this key with the strict 0/1
 * parser would blank `wifiEnabled` exactly during those transitions (#6872).
 * Anything outside the four known states stays unreadable rather than coerced.
 */
function parseAndroidWifiSetting(raw: string | undefined): boolean | undefined {
  switch (raw?.trim()) {
    case "1":
    case "2":
      return true;
    case "0":
    case "3":
      return false;
    default:
      return undefined;
  }
}

/**
 * `bluetooth_on` is NOT a flag either: AOSP's `BluetoothManagerService` persists
 * three states — `0` (BLUETOOTH_OFF), `1` (BLUETOOTH_ON_BLUETOOTH) and `2`
 * (BLUETOOTH_ON_AIRPLANE: the adapter was on, airplane mode turned it off, and
 * it is to be restored when airplane mode ends). The adapter is OFF in state
 * `2`, which is the common persisted state while airplane mode is on, so the
 * strict 0/1 parser would blank `bluetoothEnabled` exactly then (#6872).
 * Anything outside the three known states stays unreadable rather than coerced.
 */
function parseAndroidBluetoothSetting(raw: string | undefined): boolean | undefined {
  switch (raw?.trim()) {
    case "1":
      return true;
    case "0":
    case "2":
      return false;
    default:
      return undefined;
  }
}

/**
 * `location_mode` is an integer tier, not a flag: `0` is off and every other
 * valid tier is on. A non-integer (`null`, empty, `3abc`) is unreadable.
 */
function parseAndroidNonZeroSetting(raw: string | undefined): boolean | undefined {
  const value = raw?.trim();
  if (value === undefined || !/^-?\d+$/.test(value)) {
    return undefined;
  }
  return Number.parseInt(value, 10) !== 0;
}

/** Decode one raw `settings get` answer per its spec's encoding. */
function decodeAndroidConnectivityValue(
  shape: ConnectivityReadSpec["shape"],
  raw: string | undefined,
): boolean | undefined {
  switch (shape) {
    case "boolean":
      return parseAndroidBooleanSetting(raw);
    case "wifi":
      return parseAndroidWifiSetting(raw);
    case "bluetooth":
      return parseAndroidBluetoothSetting(raw);
    case "nonZero":
      return parseAndroidNonZeroSetting(raw);
  }
}

/**
 * Split the batched `<field>=<raw>` output into raw values keyed by field.
 * Unknown labels and unlabeled lines are ignored, so a device that prepends
 * noise (a warning banner) cannot misalign the parse.
 */
export function parseAndroidConnectivityOutput(
  stdout: string,
): Partial<Record<DeviceConnectivityField, string>> {
  const known = new Set<string>(ANDROID_CONNECTIVITY_READS.map((read) => read.field));
  const raw: Partial<Record<DeviceConnectivityField, string>> = {};
  for (const line of stdout.split("\n")) {
    const separator = line.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const field = line.slice(0, separator).trim();
    if (known.has(field)) {
      raw[field as DeviceConnectivityField] = line.slice(separator + 1).trim();
    }
  }
  return raw;
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

function waypointCoordinateError(point: LocationWaypoint): string | undefined {
  if (!Number.isFinite(point.latitude) || point.latitude < -90 || point.latitude > 90) {
    return "location.waypoints latitude must be finite and in [-90, 90]";
  }
  if (!Number.isFinite(point.longitude) || point.longitude < -180 || point.longitude > 180) {
    return "location.waypoints longitude must be finite and in [-180, 180]";
  }
  if (point.altitude !== undefined && !Number.isFinite(point.altitude)) {
    return "location.waypoints altitude must be finite";
  }
  return undefined;
}

function routeWaypointError(waypoints: LocationWaypoint[]): string | undefined {
  if (!Array.isArray(waypoints) || waypoints.length < 2) {
    return "location.waypoints must contain at least two points";
  }
  for (const point of waypoints) {
    const invalid = waypointCoordinateError(point);
    if (invalid) {
      return invalid;
    }
  }
  for (let index = 1; index < waypoints.length; index++) {
    const legDistance = routeDistanceMeters(waypoints.slice(index - 1, index + 1));
    if (legDistance === 0) {
      return "location.waypoints must contain distinct consecutive points";
    }
    if (Math.abs(legDistance - Math.PI * 6_371_000) < 0.001) {
      return "location.waypoints cannot contain antipodal consecutive points";
    }
  }
  return undefined;
}

function routeTimingError(
  input: Extract<SetDeviceLocationInput, { mode: "route" }>,
): string | undefined {
  if ((input.speedMetersPerSecond === undefined) === (input.durationMs === undefined)) {
    return "location.route requires exactly one of speedMetersPerSecond or durationMs";
  }
  if (
    input.speedMetersPerSecond !== undefined &&
    (!Number.isFinite(input.speedMetersPerSecond) || input.speedMetersPerSecond <= 0)
  ) {
    return "location.speedMetersPerSecond must be finite and positive";
  }
  if (
    input.durationMs !== undefined &&
    (!Number.isFinite(input.durationMs) || input.durationMs <= 0)
  ) {
    return "location.durationMs must be finite and positive";
  }
  const interval = input.updateIntervalMs ?? 1000;
  if (!Number.isInteger(interval) || interval < 200 || interval > 60000) {
    return "location.updateIntervalMs must be an integer in [200, 60000]";
  }
  return undefined;
}

function locationInputError(input: SetDeviceLocationInput | undefined): string | undefined {
  if (!input || input.mode === "stop") {
    return undefined;
  }
  if (input.mode === "route") {
    return routeWaypointError(input.waypoints) ?? routeTimingError(input);
  }
  if (!Number.isFinite(input.latitude) || input.latitude < -90 || input.latitude > 90) {
    return "location.latitude must be a finite number in [-90, 90]";
  }
  if (!Number.isFinite(input.longitude) || input.longitude < -180 || input.longitude > 180) {
    return "location.longitude must be a finite number in [-180, 180]";
  }
  return undefined;
}

function routeDurationMs(
  input: Extract<SetDeviceLocationInput, { mode: "route" }>,
  distance: number,
): number {
  const duration = input.durationMs ?? (distance / input.speedMetersPerSecond!) * 1000;
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new ActionableError("location route duration must be finite and positive");
  }
  return duration;
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

function connectivityInputError(input: SetDeviceStateInput["connectivity"]): string | undefined {
  if (
    input &&
    input.airplaneMode === undefined &&
    input.wifiEnabled === undefined &&
    input.bluetoothEnabled === undefined &&
    input.locationEnabled === undefined
  ) {
    return "Provide at least one connectivity field to set";
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

class LocationWriteAdmissionError extends ActionableError {}

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

  private async writeLocation(input: SetDeviceLocationInput): Promise<DeviceLocationState> {
    if (input.mode === "stop") {
      const stopped = await this.routeRegistry.stopAndSettle(this.device.deviceId);
      return {
        supported: true,
        mode: "stop",
        ...stopped,
      };
    }
    const invalid = locationInputError(input);
    if (invalid) {
      return { supported: true, error: invalid };
    }
    if (input.mode === "route") {
      return this.startLocationRoute(input);
    }
    return this.writeStaticLocation(input);
  }

  private assertLocationWriteAdmitted(): void {
    if (!this.canWriteLocation()) {
      throw new LocationWriteAdmissionError(
        "Cannot change location: session is released, releasing, rebound, or replaced.",
      );
    }
  }

  private async writeStaticLocation(
    input: Extract<SetDeviceLocationInput, { mode: "static" }>,
  ): Promise<DeviceLocationState> {
    if (this.device.platform === "ios") {
      if (!isIosSimulatorDevice(this.device)) {
        return {
          supported: false,
          error:
            "Location simulation is unsupported on physical iOS devices. Use an iOS Simulator.",
        };
      }
      const simctl = this.simctl ?? new SimCtlClient(this.device);
      let previousRoute: EndedLocationRoute | undefined;
      try {
        if (!simctl.executeCommandArgs) {
          throw new Error("Injected simctl client does not support argv commands");
        }
        ({ previousRoute } = await this.routeRegistry.stopAndSettle(
          this.device.deviceId,
          "replaced",
        ));
        this.assertLocationWriteAdmitted();
        await simctl.executeCommandArgs([
          "location",
          this.device.deviceId,
          "set",
          `${input.latitude},${input.longitude}`,
        ]);
        this.onLocationApplied?.();
        return {
          supported: true,
          mode: "static",
          latitude: input.latitude,
          longitude: input.longitude,
          method: "ios_simctl",
          previousRoute,
        };
      } catch (error) {
        if (error instanceof LocationWriteAdmissionError) {
          throw error;
        }
        logger.warn(
          `Failed to set iOS Simulator location for ${this.device.deviceId}: ${errorMessage(error)}`,
          error,
        );
        return {
          supported: true,
          method: "ios_simctl",
          error: `Failed to set iOS Simulator location: ${errorMessage(error)}`,
          previousRoute,
        };
      }
    }
    const port = consolePortFromSerial(this.device.deviceId);
    if (port === null) {
      return {
        supported: false,
        error:
          "Location simulation is unsupported on physical Android devices. Use an Android emulator.",
      };
    }
    let previousRoute: EndedLocationRoute | undefined;
    try {
      const adb = this.adbFactory.create(this.device);
      const probe = await adb.executeCommand("shell getprop ro.kernel.qemu");
      if (probe.stdout.trim() !== "1") {
        return {
          supported: false,
          error: "Location simulation requires an Android emulator (ro.kernel.qemu=1).",
        };
      }
      ({ previousRoute } = await this.routeRegistry.stopAndSettle(
        this.device.deviceId,
        "replaced",
      ));
      const consoleClient: EmulatorConsoleClient = this.consoleFactory(port);
      this.assertLocationWriteAdmitted();
      await consoleClient.geoFix(input.longitude, input.latitude);
      return {
        supported: true,
        mode: "static",
        latitude: input.latitude,
        longitude: input.longitude,
        method: "android_emulator_console",
        previousRoute,
      };
    } catch (error) {
      if (error instanceof LocationWriteAdmissionError) {
        throw error;
      }
      logger.warn(
        `Failed to set Android emulator location for ${this.device.deviceId}: ${errorMessage(error)}`,
        error,
      );
      return {
        supported: true,
        method: "android_emulator_console",
        error: `Failed to set Android emulator location: ${errorMessage(error)}`,
        previousRoute,
      };
    }
  }

  private async startLocationRoute(
    input: Extract<SetDeviceLocationInput, { mode: "route" }>,
  ): Promise<DeviceLocationState> {
    const distance = routeDistanceMeters(input.waypoints);
    const duration = routeDurationMs(input, distance);
    const interval = input.updateIntervalMs ?? 1000;
    const loop = input.loop ?? false;
    let emit: (
      point: LocationWaypoint,
      options: { signal: AbortSignal; timeoutMs: number },
    ) => Promise<void>;
    let method: DeviceLocationState["method"];
    let onStarted: (() => void) | undefined;
    if (this.device.platform === "ios") {
      if (!isIosSimulatorDevice(this.device)) {
        return {
          supported: false,
          error:
            "Location simulation is unsupported on physical iOS devices. Use an iOS Simulator.",
        };
      }
      const simctl = this.simctl ?? new SimCtlClient(this.device);
      if (!simctl.executeCommandArgs) {
        throw new ActionableError("simctl client does not support argv commands");
      }
      emit = async (point, options) => {
        this.assertLocationWriteAdmitted();
        await simctl.executeCommandArgs!(
          ["location", this.device.deviceId, "set", `${point.latitude},${point.longitude}`],
          options.timeoutMs,
          options.signal,
        );
      };
      method = "ios_simctl";
      onStarted = this.onLocationApplied;
    } else {
      const port = consolePortFromSerial(this.device.deviceId);
      if (port === null) {
        return {
          supported: false,
          error:
            "Location simulation is unsupported on physical Android devices. Use an Android emulator.",
        };
      }
      try {
        const probe = await this.adbFactory
          .create(this.device)
          .executeCommand("shell getprop ro.kernel.qemu");
        if (probe.stdout.trim() !== "1") {
          return {
            supported: false,
            error: "Location simulation requires an Android emulator (ro.kernel.qemu=1).",
          };
        }
      } catch (error) {
        logger.warn(
          `Failed to probe Android emulator for location route: ${errorMessage(error)}`,
          error,
        );
        return {
          supported: true,
          error: `Failed to probe Android emulator: ${errorMessage(error)}`,
        };
      }
      const client = this.consoleFactory(port);
      emit = async (point, options) => {
        this.assertLocationWriteAdmitted();
        await client.geoFix(point.longitude, point.latitude, point.altitude, options.signal);
      };
      method = "android_emulator_console";
    }
    const { previousRoute } = await this.routeRegistry.stopAndSettle(
      this.device.deviceId,
      "replaced",
    );
    // Setup drain is bounded; re-check ownership immediately before starting playback.
    this.assertLocationWriteAdmitted();
    this.routeRegistry.start(this.device.deviceId, input.waypoints, duration, interval, loop, emit);
    // Mark at start: a release can precede the first scheduled simulator fix.
    // Android's console has no unset command, so Android never acquires a marker.
    onStarted?.();
    return {
      supported: true,
      mode: "route",
      waypointCount: input.waypoints.length,
      totalDistanceMeters: distance,
      expectedDurationMs: duration,
      loop,
      updateIntervalMs: interval,
      method,
      ...(previousRoute ? { previousRoute } : {}),
    };
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
  private async readConnectivity(): Promise<DeviceConnectivityState> {
    return this.device.platform === "android"
      ? this.getAndroidConnectivity()
      : { supported: false, error: IOS_CONNECTIVITY_UNSUPPORTED_ERROR };
  }

  /** Platform dispatch for writing device-level connectivity toggles. */
  private writeConnectivity(
    input: NonNullable<SetDeviceStateInput["connectivity"]>,
  ): Promise<DeviceConnectivityState> {
    return this.device.platform === "android"
      ? this.setAndroidConnectivity(input)
      : Promise.resolve({
          supported: false,
          verified: false,
          error: IOS_CONNECTIVITY_WRITE_UNSUPPORTED_ERROR,
        });
  }

  /**
   * Read airplane/Wi-Fi/Bluetooth/location in a single adb round-trip
   * (issue #6872). Failure policy, per field:
   * - one key absent or malformed -> that field is `undefined`, siblings keep
   *   their values, and the unreadable names go into `warning`;
   * - NOTHING parsed -> an `error`, because the device answered nothing usable
   *   and silently reporting four `undefined`s would look like a clean read;
   * - the command threw -> an `error` carrying the underlying message.
   */
  private async getAndroidConnectivity(): Promise<DeviceConnectivityState> {
    let stdout: string;
    try {
      const adb = this.adbFactory.create(this.device);
      const result = await adb.executeCommand(
        ANDROID_CONNECTIVITY_READ_COMMAND,
        undefined,
        undefined,
        true,
      );
      stdout = result.stdout;
    } catch (error) {
      // Strategy 2: log, then return a typed failure — the tool reports the
      // error to the client instead of throwing out of a read-only state dump.
      logger.warn(`[DeviceState] connectivity read failed: ${errorMessage(error)}`, error);
      return {
        supported: true,
        method: "android_settings_batch",
        error: errorMessage(error),
      };
    }

    const rawValues = parseAndroidConnectivityOutput(stdout);
    const parsed: Partial<Record<DeviceConnectivityField, boolean>> = {};
    const unreadable: DeviceConnectivityField[] = [];
    for (const read of ANDROID_CONNECTIVITY_READS) {
      const value = decodeAndroidConnectivityValue(read.shape, rawValues[read.field]);
      if (value === undefined) {
        unreadable.push(read.field);
      } else {
        parsed[read.field] = value;
      }
    }

    const base = {
      supported: true as const,
      method: "android_settings_batch" as const,
      ...parsed,
      ...(Object.keys(rawValues).length > 0 ? { rawValues } : {}),
    };
    if (unreadable.length === ANDROID_CONNECTIVITY_READS.length) {
      return {
        ...base,
        error: `Could not read any Android connectivity toggles (${unreadable.join(", ")}).`,
      };
    }
    if (unreadable.length > 0) {
      return {
        ...base,
        warning: `Could not read: ${unreadable.join(", ")}. Absent or unparsable on this device.`,
      };
    }
    return base;
  }

  /**
   * Set requested Android connectivity toggles to their desired end states.
   * The initial batched read makes already-achieved requests no-ops; a fresh
   * read after writes is the source of the returned state and verification.
   */
  private async setAndroidConnectivity(
    input: NonNullable<SetDeviceStateInput["connectivity"]>,
  ): Promise<DeviceConnectivityState> {
    const requestedFields = ANDROID_CONNECTIVITY_READS.map((read) => read.field).filter(
      (field) => input[field] !== undefined,
    );
    const before = await this.getAndroidConnectivity();
    const fieldsToWrite = requestedFields.filter((field) => before[field] !== input[field]);

    if (fieldsToWrite.length === 0) {
      return { ...before, verified: true };
    }

    const writes = await this.applyAndroidConnectivityWrites(fieldsToWrite, input);
    return this.withConnectivityVerification(
      writes.wrote ? await this.getAndroidConnectivity() : before,
      input,
      requestedFields,
      writes.failedFields,
    );
  }

  /** Apply every needed connectivity write without letting one failed radio block its siblings. */
  private async applyAndroidConnectivityWrites(
    fieldsToWrite: readonly DeviceConnectivityField[],
    input: NonNullable<SetDeviceStateInput["connectivity"]>,
  ): Promise<{ wrote: boolean; failedFields: Set<DeviceConnectivityField> }> {
    let adb: AdbExecutor;
    try {
      adb = this.adbFactory.create(this.device);
    } catch (error) {
      logger.warn(
        `[DeviceState] connectivity writer creation failed: ${errorMessage(error)}`,
        error,
      );
      return { wrote: false, failedFields: new Set() };
    }

    const failedFields = new Set<DeviceConnectivityField>();
    for (const field of fieldsToWrite) {
      if (await this.applyAndroidConnectivityField(adb, field, input[field]!)) {
        failedFields.add(field);
      }
    }
    return { wrote: true, failedFields };
  }

  /** Log a typed, best-effort failure and continue with the other requested toggles. */
  private async applyAndroidConnectivityField(
    adb: AdbExecutor,
    field: DeviceConnectivityField,
    enabled: boolean,
  ): Promise<boolean> {
    try {
      const commandError = await this.setAndroidConnectivityField(adb, field, enabled);
      if (commandError) {
        logger.warn(`[DeviceState] connectivity write for ${field} failed: ${commandError}`);
        return true;
      }
      return false;
    } catch (error) {
      // A failed toggle must not prevent the other requested desired states from applying.
      logger.warn(
        `[DeviceState] connectivity write for ${field} failed: ${errorMessage(error)}`,
        error,
      );
      return true;
    }
  }

  /** Build a verified write result from the state freshly read from Android. */
  private withConnectivityVerification(
    state: DeviceConnectivityState,
    input: NonNullable<SetDeviceStateInput["connectivity"]>,
    requestedFields: readonly DeviceConnectivityField[],
    failedFields: ReadonlySet<DeviceConnectivityField>,
  ): DeviceConnectivityState {
    const unverified = requestedFields.filter(
      (field) => failedFields.has(field) || state[field] !== input[field],
    );
    if (unverified.length === 0) {
      return { ...state, verified: true };
    }
    const verificationWarning = `Could not verify requested connectivity state: ${unverified.join(
      ", ",
    )}.`;
    return {
      ...state,
      verified: false,
      warning: [state.warning, verificationWarning].filter(Boolean).join(" "),
    };
  }

  /** Execute the Android commands for one connectivity field, returning a shell failure message. */
  private async setAndroidConnectivityField(
    adb: AdbExecutor,
    field: DeviceConnectivityField,
    enabled: boolean,
  ): Promise<string | undefined> {
    switch (field) {
      case "wifiEnabled":
        return this.runAndroidConnectivityCommand(adb, wifiToggleCommand(!enabled));
      case "bluetoothEnabled":
        return this.runAndroidConnectivityCommand(
          adb,
          `shell svc bluetooth ${enabled ? "enable" : "disable"}`,
        );
      case "airplaneMode":
        return this.runAndroidConnectivityCommand(
          adb,
          `shell cmd connectivity airplane-mode ${enabled ? "enable" : "disable"}`,
        );
      case "locationEnabled":
        return this.setAndroidLocationEnabled(adb, enabled);
    }
  }

  /** Prefer the API-31 location command, then fall back to the legacy secure setting. */
  private async setAndroidLocationEnabled(
    adb: AdbExecutor,
    enabled: boolean,
  ): Promise<string | undefined> {
    const primaryCommand = `shell cmd location set-location-enabled ${enabled}`;
    try {
      const primaryError = await this.runAndroidConnectivityCommand(adb, primaryCommand);
      if (!primaryError) {
        return undefined;
      }
      logger.debug(
        `[DeviceState] location command '${primaryCommand}' reported '${primaryError}'; falling back`,
      );
    } catch (error) {
      logger.debug(
        `[DeviceState] location command '${primaryCommand}' failed: ${errorMessage(error)}; falling back`,
      );
    }
    return this.runAndroidConnectivityCommand(
      adb,
      `shell settings put secure location_mode ${enabled ? "3" : "0"}`,
    );
  }

  /** Return a shell-reported failure without turning an expected writer failure into a throw. */
  private async runAndroidConnectivityCommand(
    adb: AdbExecutor,
    command: string,
  ): Promise<string | undefined> {
    const result = await adb.executeCommand(command, undefined, undefined, true);
    const stdout = result.stdout;
    const stderr = result.stderr ?? "";
    return outputLooksLikeShellFailure(stdout, stderr)
      ? `${stdout}\n${stderr}`.trim() || `${command} reported an error`
      : undefined;
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
