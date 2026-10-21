import { shellQuote } from "../../../utils/shellQuote";

export interface SetDeviceConnectivityInput {
  airplaneMode?: boolean;
  wifiEnabled?: boolean;
  bluetoothEnabled?: boolean;
  locationEnabled?: boolean;
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
export const ANDROID_CONNECTIVITY_READS: readonly ConnectivityReadSpec[] = [
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
export const IOS_CONNECTIVITY_UNSUPPORTED_ERROR =
  "Device connectivity toggles cannot be read on iOS: Airplane mode, Wi-Fi, Bluetooth and " +
  "Location have no simctl or devicectl read verb. A simulator shares the host's network stack " +
  "(so its Wi-Fi/Bluetooth state is the Mac's, not the device's), and `simctl status_bar " +
  "override` only paints the status bar without changing real connectivity. Read these from " +
  "Settings on the device instead.";

export const IOS_CONNECTIVITY_WRITE_UNSUPPORTED_ERROR =
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
export function decodeAndroidConnectivityValue(
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

export function connectivityInputError(
  input: SetDeviceConnectivityInput | undefined,
): string | undefined {
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
