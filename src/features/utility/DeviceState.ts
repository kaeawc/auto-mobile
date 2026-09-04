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
import { AndroidCtrlProxyClient } from "../observe/android/AndroidCtrlProxyClient";
import { logger } from "../../utils/logger";
import type { Timer } from "../../utils/SystemTimer";
import { defaultTimer } from "../../utils/SystemTimer";
import {
  IOS_NOTIFYUTIL_REGISTERED_SET_TIMEOUT_MS,
  iosNotifyutilGetCommand,
  iosNotifyutilRegisteredSetReadPostCommand,
  parseNotifyutilState,
} from "../../utils/ios-cmdline-tools/notifyutil";

export type DoNotDisturbMode = "off" | "none" | "priority" | "alarms";

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

export type BiometricEnrollment = "enrolled" | "not_enrolled";

export interface BiometricEnrollmentState {
  supported: boolean;
  enrollment?: BiometricEnrollment;
  method?: "ios_simulator_notifyutil";
  verified?: boolean;
  error?: string;
}

/**
 * Documented device-wide network-condition profiles. Distinct from the in-app
 * request mocking of `mockNetwork`/`network` (src/server/networkTools.ts): these
 * condition *all* traffic on the selected device via the OS/emulator, so a
 * non-instrumented app is affected. `none` is the unshaped baseline; `offline`
 * cuts data entirely; the remaining tiers approximate real-world connectivity.
 * (There is deliberately no `5g` profile — an unlimited/unshaped tier would be
 * identical to `none` and would only be a no-op that confusingly disabled Wi-Fi;
 * use `none` for a clean/fast link — issue #6012 review.)
 */
export type NetworkConditionProfile = "none" | "offline" | "veryBad" | "2g" | "3g" | "4g";

/**
 * How faithfully a platform can apply a requested network condition:
 * - `full`: fully applied and safe — used for the reset to `none`, which removes
 *   all shaping and re-enables both radios (the restore direction, which cannot
 *   leave a device impaired).
 * - `partial`: the shaping/cut commands were accepted, but effectiveness is not
 *   guaranteed. The emulator console (`network delay|speed`, `gsm data`) shapes
 *   only the emulated **cellular** interface; a Wi-Fi-connected emulator would
 *   bypass it, and Wi-Fi cannot be disabled by any single automatable command
 *   across API levels (`svc wifi disable` is best-effort and a no-op on newer
 *   images). So a degrading profile (including `offline`) is applied best-effort
 *   and reported `partial` with a warning, never a false `verified: true`.
 * - `unsupported`: no automatable per-device shaper exists (physical Android,
 *   and every iOS target — see the *_UNSUPPORTED_ERROR constants below).
 */
export type NetworkConditionCapability = "full" | "partial" | "unsupported";

/**
 * The explicit, documented condition values a profile maps to. `delayMs` is the
 * added round-trip latency, `downloadKbps`/`uploadKbps` the bandwidth caps
 * (`0` = unlimited, matching the emulator's `full` speed), and
 * `packetLossPercent` the intended loss.
 *
 * NOTE: the Android emulator console (`adb emu network delay|speed`) applies
 * latency and bandwidth only — it has no packet-loss verb. `packetLossPercent`
 * therefore documents the *target* condition for each profile; the emulator
 * enforces total loss only through `offline` (`gsm data off`). Callers that need
 * exact loss shaping should use a host-side proxy.
 */
export interface NetworkConditionValues {
  delayMs: number;
  downloadKbps: number;
  uploadKbps: number;
  packetLossPercent: number;
}

/**
 * Profile → explicit documented values, plus the emulator console named specs
 * used to apply latency and bandwidth.
 *
 * IMPORTANT: `network delay` and `network speed` have DIFFERENT vocabularies per
 * the Android Emulator console reference:
 * - `network delay <latency>` accepts ONLY `gprs` (150-550ms), `edge`
 *   (80-400ms), `umts` (35-200ms), `none` (0), or a numeric ms / `min:max`.
 * - `network speed <speed>` accepts `gsm`, `hscsd`, `gprs`, `edge`, `umts`,
 *   `hsdpa`, `lte`, `evdo`, `full`, or a numeric `up:down` in kbps.
 *
 * So `gsm`/`lte`/`full`/`hsdpa` are speed-only presets and MUST NOT be sent to
 * `network delay` — doing so is rejected by the console (issue #6012 review).
 * Each profile therefore carries an independently-valid delay spec and speed
 * spec, and its documented `delayMs` reflects the chosen delay preset's max
 * latency while `download/uploadKbps` reflect the chosen speed preset.
 */
interface NetworkConditionProfileDefinition {
  values: NetworkConditionValues;
  /** Emulator `network delay` spec (gprs/edge/umts/none), or null when offline. */
  emulatorDelaySpec: string | null;
  /** Emulator `network speed` spec (gsm/edge/umts/lte/full/...), or null offline. */
  emulatorSpeedSpec: string | null;
  /** Whether the mobile data radio should be on for this profile. */
  dataEnabled: boolean;
}

const NETWORK_CONDITION_PROFILE_DEFINITIONS: Record<
  NetworkConditionProfile,
  NetworkConditionProfileDefinition
> = {
  none: {
    values: { delayMs: 0, downloadKbps: 0, uploadKbps: 0, packetLossPercent: 0 },
    emulatorDelaySpec: "none",
    emulatorSpeedSpec: "full",
    dataEnabled: true,
  },
  offline: {
    values: { delayMs: 0, downloadKbps: 0, uploadKbps: 0, packetLossPercent: 100 },
    emulatorDelaySpec: null,
    emulatorSpeedSpec: null,
    dataEnabled: false,
  },
  veryBad: {
    // delay `gprs` (150-550ms, max 550); speed `gsm` (14.4 kbps up/down).
    values: { delayMs: 550, downloadKbps: 14, uploadKbps: 14, packetLossPercent: 10 },
    emulatorDelaySpec: "gprs",
    emulatorSpeedSpec: "gsm",
    dataEnabled: true,
  },
  "2g": {
    // delay `edge` (80-400ms, max 400); speed `edge` (236.8/118.4 kbps).
    values: { delayMs: 400, downloadKbps: 237, uploadKbps: 118, packetLossPercent: 5 },
    emulatorDelaySpec: "edge",
    emulatorSpeedSpec: "edge",
    dataEnabled: true,
  },
  "3g": {
    // delay `umts` (35-200ms, max 200); speed `umts` (1920/128 kbps).
    values: { delayMs: 200, downloadKbps: 1920, uploadKbps: 128, packetLossPercent: 2 },
    emulatorDelaySpec: "umts",
    emulatorSpeedSpec: "umts",
    dataEnabled: true,
  },
  "4g": {
    // LTE latency is negligible, so delay `none`; speed `lte` (173000/58000 kbps).
    values: { delayMs: 0, downloadKbps: 173000, uploadKbps: 58000, packetLossPercent: 0 },
    emulatorDelaySpec: "none",
    emulatorSpeedSpec: "lte",
    dataEnabled: true,
  },
};

/** Public, documented profile → values contract (used by tools and tests). */
export const NETWORK_CONDITION_PROFILES: Record<NetworkConditionProfile, NetworkConditionValues> =
  Object.fromEntries(
    (Object.keys(NETWORK_CONDITION_PROFILE_DEFINITIONS) as NetworkConditionProfile[]).map(
      (profile) => [profile, NETWORK_CONDITION_PROFILE_DEFINITIONS[profile].values],
    ),
  ) as Record<NetworkConditionProfile, NetworkConditionValues>;

export interface NetworkConditionState {
  supported: boolean;
  capability?: NetworkConditionCapability;
  method?: "android_emulator_console";
  /** The profile the platform actually applied (writes) or the baseline (reads). */
  profile?: NetworkConditionProfile;
  requestedProfile?: NetworkConditionProfile;
  appliedProfile?: NetworkConditionProfile;
  /** Explicit documented values applied (may reflect caller overrides). */
  values?: NetworkConditionValues;
  verified?: boolean;
  /** Advisory TTL echoed back; enforced by the session layer on release/expiry. */
  expiresInSeconds?: number;
  /** Best-effort emulator `network status` readback (reads only). */
  rawStatus?: string;
  warning?: string;
  error?: string;
}

/** Shared fields every Android network-condition result carries. */
interface NetworkConditionResultBase {
  method: "android_emulator_console";
  requestedProfile: NetworkConditionProfile;
  values: NetworkConditionValues;
  expiresInSeconds?: number;
}

export interface SetNetworkConditionInput {
  profile?: NetworkConditionProfile;
  /** Reset to normal connectivity (equivalent to `profile: "none"`). */
  cancel?: boolean;
  /** Alias of `cancel`. */
  reset?: boolean;
  /** Optional explicit overrides that supersede the profile's named specs. */
  delayMs?: number;
  downloadKbps?: number;
  uploadKbps?: number;
  packetLossPercent?: number;
  /** Advisory TTL; session release/expiry restores normal connectivity. */
  expiresInSeconds?: number;
}

export interface DeviceStateResult {
  success: boolean;
  deviceId: string;
  platform: "android" | "ios";
  doNotDisturb?: DoNotDisturbState;
  biometrics?: BiometricEnrollmentState;
  networkCondition?: NetworkConditionState;
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
  networkCondition?: SetNetworkConditionInput;
}

interface IosSimulatorClient {
  executeCommand(command: string, timeoutMs?: number): Promise<ExecResult>;
}

export interface DeviceStateDependencies {
  adbFactory?: AdbClientFactory;
  simctl?: IosSimulatorClient | null;
  timer?: Timer;
}

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

/**
 * Network-condition simulation is unavailable on every iOS target. simctl
 * exposes no network verb, and the only host mechanism — Network Link
 * Conditioner — is a system-wide, sudo-gated setting rather than a per-simulator
 * or per-device control, so it cannot be driven per device from automation.
 */
const IOS_NETWORK_CONDITION_UNSUPPORTED_ERROR =
  "Network-condition simulation is unavailable on iOS: simctl exposes no network verb, and the " +
  "only host mechanism (Network Link Conditioner) is a system-wide, sudo-gated setting rather " +
  "than a per-simulator or per-device control. Shape traffic with a host-side proxy instead.";

/**
 * Physical Android devices expose no unprivileged, OS-wide traffic shaper. The
 * emulator console (`adb emu network ...`) does not exist off-emulator, and
 * `svc data`/`svc wifi` only toggle radios fully on/off (and need privileged
 * permissions), so degraded-connectivity profiles cannot be applied.
 */
const ANDROID_PHYSICAL_NETWORK_CONDITION_UNSUPPORTED_ERROR =
  "Network-condition simulation is only available on Android emulators: it uses the emulator " +
  "console (`adb emu network ...`), which physical devices do not expose. On a physical device " +
  "the radios can only be toggled fully on/off (svc data/wifi, privileged). Use an emulator or a " +
  "host-side proxy for degraded-network testing.";

/** Android emulators report an `emulator-<port>` serial; everything else is physical. */
function isAndroidEmulatorSerial(deviceId: string): boolean {
  return deviceId.startsWith("emulator-");
}

/**
 * The emulator console answers `OK` on success and `KO: <reason>` on failure —
 * a convention the generic adb-shell heuristic (`exception`/`error:`) does not
 * cover, so check for the `KO` sentinel as well.
 */
function emulatorConsoleReportsFailure(stdout: string, stderr: string): boolean {
  const combined = `${stdout}\n${stderr}`.trim();
  if (!combined) {
    return false;
  }
  if (/(^|\n)\s*KO\b/.test(combined)) {
    return true;
  }
  return outputLooksLikeShellFailure(stdout, stderr);
}

/**
 * Resolve the requested profile: `cancel`/`reset` (or an absent profile) map to
 * `none`, the unshaped baseline.
 */
function resolveNetworkProfile(input: SetNetworkConditionInput): NetworkConditionProfile {
  if (input.cancel || input.reset) {
    return "none";
  }
  return input.profile ?? "none";
}

/** Merge caller overrides onto the profile's documented values. */
function resolveNetworkValues(
  profile: NetworkConditionProfile,
  input: SetNetworkConditionInput,
): NetworkConditionValues {
  const base = NETWORK_CONDITION_PROFILE_DEFINITIONS[profile].values;
  return {
    delayMs: input.delayMs ?? base.delayMs,
    downloadKbps: input.downloadKbps ?? base.downloadKbps,
    uploadKbps: input.uploadKbps ?? base.uploadKbps,
    packetLossPercent: input.packetLossPercent ?? base.packetLossPercent,
  };
}

/**
 * How a `networkCondition` request is interpreted. This is the SINGLE SOURCE OF
 * TRUTH shared by the zod schema refinement (a request must not be `empty`), the
 * session-slot decision (only a `degrade` registers a restore baseline), and the
 * Android setter (capability/verified/wifi all follow the kind) — so those three
 * can never disagree (issue #6012 convergence audit).
 *
 * - `empty`:     no actionable field — `{}`, `{cancel:false}`, `{reset:false}`,
 *                `{expiresInSeconds}`, or any falsy-only combination. Rejected.
 * - `invalid`:   a self-contradictory combination — `offline` (a disabled link)
 *                with a `delayMs`/`downloadKbps`/`uploadKbps` shaping override
 *                that cannot apply. Rejected (issue #6012 review P2).
 * - `reset`:     `cancel===true`, `reset===true`, or an explicit `profile:"none"`
 *                with no shaping override. Restores normal connectivity.
 * - `degrade`:   a real profile, or a bandwidth/latency override over `none`.
 * - `loss-only`: ONLY `packetLossPercent` (which the emulator console cannot
 *                enforce) — an unsupported no-op, never reported verified.
 */
export type NetworkConditionRequestKind = "empty" | "invalid" | "reset" | "degrade" | "loss-only";

export function classifyNetworkConditionRequest(
  input: SetNetworkConditionInput,
): NetworkConditionRequestKind {
  // cancel/reset are reset signals only when strictly true; `{cancel:false}` is
  // not a request (issue #6012 review P2). cancel/reset wins over everything else
  // (it means "make it clean"), so extra fields are harmlessly discarded.
  if (input.cancel === true || input.reset === true) {
    return "reset";
  }
  // `offline` cuts the link, so a shaping override on the same request cannot be
  // applied — reject it rather than silently echo an unapplied value. (Unlike
  // cancel/reset, this is a shaping INTENT on a link that will be down — a
  // genuine contradiction worth surfacing, not a harmlessly-ignorable extra.)
  if (input.profile === "offline" && hasShapingOverride(input)) {
    return "invalid";
  }
  if (input.profile !== undefined && input.profile !== "none") {
    return "degrade";
  }
  if (hasShapingOverride(input)) {
    return "degrade";
  }
  if (input.packetLossPercent !== undefined) {
    return "loss-only";
  }
  if (input.profile === "none") {
    return "reset";
  }
  return "empty";
}

/**
 * A request that carries an actionable, non-contradictory change. Both `empty`
 * (nothing to do) and `invalid` (offline + shaping override) fail the schema
 * refinement; `invalid` carries its own message via `networkConditionInputError`.
 */
export function networkConditionInputIsRequest(input: SetNetworkConditionInput): boolean {
  const kind = classifyNetworkConditionRequest(input);
  return kind !== "empty" && kind !== "invalid";
}

/** Human-readable rejection reason for a non-actionable request, or null. */
export function networkConditionInputError(input: SetNetworkConditionInput): string | null {
  switch (classifyNetworkConditionRequest(input)) {
    case "invalid":
      return NETWORK_CONDITION_OFFLINE_OVERRIDE_ERROR;
    case "empty":
      return NETWORK_CONDITION_EMPTY_REQUEST_ERROR;
    default:
      return null;
  }
}

/**
 * True when the request degrades the link (a real profile or a shaping override
 * over `none`). The session layer uses this to decide whether to record a restore
 * baseline, so an override-only request cannot leave a device shaped with no
 * restore slot (issue #6012). Derived from the shared classifier so it cannot
 * disagree with the setter's capability/verified decisions.
 */
export function networkConditionInputDegrades(input: SetNetworkConditionInput): boolean {
  return classifyNetworkConditionRequest(input) === "degrade";
}

/**
 * Whether the request carries a bandwidth/latency override that the emulator
 * console can apply (`packetLossPercent` is excluded — the console has no loss
 * verb, so a loss-only override applies nothing).
 */
function hasShapingOverride(input: SetNetworkConditionInput): boolean {
  return (
    input.delayMs !== undefined ||
    input.downloadKbps !== undefined ||
    input.uploadKbps !== undefined
  );
}

/**
 * A shaping condition (delay/speed) only reaches traffic that uses the emulated
 * cellular interface, so Wi-Fi is toggled to route traffic through it. This is
 * best-effort: `svc wifi disable`/`enable` is broadly available but restricted /
 * a no-op on newer API levels, and there is no automatable command that reliably
 * disables Wi-Fi on every emulator image. Its failure never aborts the request —
 * it only downgrades the reported capability (see the `partial` warning).
 *
 * Keyed on whether the request degrades the link (`networkConditionInputDegrades`),
 * NOT the profile name: an override-only request (e.g. `{delayMs:500}`) resolves
 * to profile `none` yet still shapes traffic, so it must disable Wi-Fi like any
 * other degrade — while a genuine reset re-enables it (issue #6012 review).
 */
function wifiToggleCommand(degrades: boolean): string {
  return degrades ? "shell svc wifi disable" : "shell svc wifi enable";
}

const NETWORK_CONDITION_PARTIAL_WARNING =
  "Applied best-effort. The emulator console (`network delay|speed`, `gsm data`) shapes only the " +
  "emulated cellular interface, and Wi-Fi was toggled with `svc wifi` — which is best-effort and " +
  "a no-op on newer API levels. If the emulator stays on an unshaped Wi-Fi transport the " +
  "condition may not take effect, so it is reported `partial`, not verified. Confirm connectivity " +
  "from within the app under test, or use a host-side proxy for guaranteed shaping.";

const NETWORK_CONDITION_LOSS_ONLY_UNSUPPORTED_ERROR =
  "Packet loss is not enforceable via the Android emulator console (it has no loss verb), so a " +
  "networkCondition request whose only signal is packetLossPercent applies nothing and cannot be " +
  "reported as applied. Use a documented profile (which bundles latency and bandwidth) or a " +
  "host-side proxy for loss shaping.";

const NETWORK_CONDITION_EMPTY_REQUEST_ERROR =
  "networkCondition specified no change to apply. Provide a profile, cancel/reset, or a " +
  "latency/bandwidth override.";

const NETWORK_CONDITION_OFFLINE_OVERRIDE_ERROR =
  "networkCondition profile 'offline' cannot be combined with a latency/bandwidth override " +
  "(delayMs/downloadKbps/uploadKbps): offline disables the link, so there is nothing to shape. " +
  "Use 'offline' alone, or a connected profile with the override.";

/** Best-effort reset that undoes any shaping — used to roll back a failed degrade. */
const NETWORK_CONDITION_ROLLBACK_COMMANDS = [
  "emu network delay none",
  "emu network speed full",
  "emu gsm data on",
  "shell svc wifi enable",
];

/**
 * Build the emulator console commands (in dispatch order) that apply a profile.
 * Only the emulated-cellular shaping commands (`emu ...`) — Wi-Fi is handled
 * separately as a best-effort step. Explicit numeric overrides replace the
 * profile's named specs with `<min>:<max>` delay and `<up>:<down>` speed specs
 * the emulator also accepts. Callers pass a reset-normalized input, so overrides
 * are already dropped for `none`.
 */
function buildEmulatorNetworkCommands(
  profile: NetworkConditionProfile,
  input: SetNetworkConditionInput,
  values: NetworkConditionValues,
): string[] {
  const def = NETWORK_CONDITION_PROFILE_DEFINITIONS[profile];
  if (!def.dataEnabled) {
    // Offline: cut the data radio; delay/speed are irrelevant with no link.
    return ["emu gsm data off"];
  }
  const hasOverride =
    input.delayMs !== undefined ||
    input.downloadKbps !== undefined ||
    input.uploadKbps !== undefined;
  const delaySpec = hasOverride ? `${values.delayMs}:${values.delayMs}` : def.emulatorDelaySpec;
  const speedSpec = hasOverride
    ? `${values.uploadKbps}:${values.downloadKbps}`
    : def.emulatorSpeedSpec;
  if (profile === "none") {
    // Reset: clear shaping first, then re-enable the radio a prior `offline` cut.
    return [`emu network delay ${delaySpec}`, `emu network speed ${speedSpec}`, "emu gsm data on"];
  }
  // Degrade: ensure the radio is on before shaping, so a prior `offline` cannot
  // leave the link down under the new profile.
  return ["emu gsm data on", `emu network delay ${delaySpec}`, `emu network speed ${speedSpec}`];
}

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
  return !input.doNotDisturb && !input.biometrics && !input.networkCondition;
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

export class DeviceState {
  private device: BootedDevice;

  private adbFactory: AdbClientFactory;

  private simctl: IosSimulatorClient | null;

  private timer: Timer;

  constructor(device: BootedDevice, dependencies: DeviceStateDependencies = {}) {
    this.device = device;
    this.adbFactory = dependencies.adbFactory ?? defaultAdbClientFactory;
    this.simctl = dependencies.simctl ?? null;
    this.timer = dependencies.timer ?? defaultTimer;
  }

  async getState(
    include: ("doNotDisturb" | "biometrics" | "networkCondition")[] = ["doNotDisturb"],
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
    const doNotDisturb = include.includes("doNotDisturb")
      ? await this.readDoNotDisturb()
      : undefined;
    const biometrics = include.includes("biometrics")
      ? await this.getBiometricEnrollmentState()
      : undefined;
    const networkCondition = include.includes("networkCondition")
      ? await this.readNetworkCondition()
      : undefined;
    const requestedStates = [doNotDisturb, biometrics, networkCondition].filter(
      (state): state is DoNotDisturbState | BiometricEnrollmentState | NetworkConditionState =>
        state !== undefined,
    );
    const error = requestedStates.find((state) => state.error)?.error;

    return {
      success: requestedStates.every((state) => state.supported && !state.error),
      deviceId: this.device.deviceId,
      platform: this.device.platform,
      ...(doNotDisturb ? { doNotDisturb } : {}),
      ...(biometrics ? { biometrics } : {}),
      ...(networkCondition ? { networkCondition } : {}),
      ...(error ? { error } : {}),
    };
  }

  async setState(input: SetDeviceStateInput): Promise<DeviceStateResult> {
    if (setDeviceStateInputIsEmpty(input)) {
      return {
        success: false,
        deviceId: this.device.deviceId,
        platform: this.device.platform,
        error: "At least one device state field must be provided",
      };
    }

    const inputError = doNotDisturbInputError(input.doNotDisturb);
    if (inputError) {
      return {
        success: false,
        deviceId: this.device.deviceId,
        platform: this.device.platform,
        error: inputError,
      };
    }

    const doNotDisturb = input.doNotDisturb
      ? await this.writeDoNotDisturb(input.doNotDisturb)
      : undefined;
    const biometrics = input.biometrics
      ? await this.setBiometricEnrollmentState(input.biometrics.enrollment)
      : undefined;
    const networkCondition = input.networkCondition
      ? await this.writeNetworkCondition(input.networkCondition)
      : undefined;
    const requestedStates = [doNotDisturb, biometrics, networkCondition].filter(
      (state): state is DoNotDisturbState | BiometricEnrollmentState | NetworkConditionState =>
        state !== undefined,
    );
    const error = requestedStates.find((state) => state.error)?.error;

    return {
      success: requestedStates.every(
        (state) => state.supported && !state.error && state.verified !== false,
      ),
      deviceId: this.device.deviceId,
      platform: this.device.platform,
      ...(doNotDisturb ? { doNotDisturb } : {}),
      ...(biometrics ? { biometrics } : {}),
      ...(networkCondition ? { networkCondition } : {}),
      ...(error ? { error } : {}),
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
      const enrolled = parseNotifyutilState(result.stdout ?? "");
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
      const enrolled = parseNotifyutilState(result.stdout ?? "");
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

  /** Platform dispatch for writing Do Not Disturb. */
  private writeDoNotDisturb(
    input: SetDeviceStateInput["doNotDisturb"],
  ): Promise<DoNotDisturbState> {
    return this.device.platform === "android"
      ? this.setAndroidDoNotDisturb(input)
      : this.setIosDoNotDisturb(input);
  }

  /** Platform dispatch for reading the device-wide network condition. */
  private async readNetworkCondition(): Promise<NetworkConditionState> {
    return this.device.platform === "android"
      ? this.getAndroidNetworkCondition()
      : this.getIosNetworkCondition();
  }

  /** Platform dispatch for writing the device-wide network condition. */
  private async writeNetworkCondition(
    input: SetNetworkConditionInput,
  ): Promise<NetworkConditionState> {
    return this.device.platform === "android"
      ? this.setAndroidNetworkCondition(input)
      : this.setIosNetworkCondition(input);
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
      return parseAndroidZenMode(result.stdout ?? "");
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
      const stdout = setResult.stdout ?? "";
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

  private async getAndroidNetworkCondition(): Promise<NetworkConditionState> {
    if (!isAndroidEmulatorSerial(this.device.deviceId)) {
      return {
        supported: false,
        capability: "unsupported",
        error: ANDROID_PHYSICAL_NETWORK_CONDITION_UNSUPPORTED_ERROR,
      };
    }
    // The emulator console has no structured "get" for the applied delay/speed,
    // so readback is best-effort: `network status` prints the current shaping as
    // free text. We surface it verbatim (rawStatus). A clean response only proves
    // the console is REACHABLE — it does not verify any specific condition (no
    // profile/values are reconstructed), so the read deliberately does NOT set
    // `verified: true` (issue #6012 review): `verified` is reserved for an applied
    // condition that was actually achieved. The applied profile is tracked at the
    // session layer, not re-derived here.
    try {
      const adb = this.adbFactory.create(this.device);
      const result = await adb.executeCommand("emu network status", undefined, undefined, true);
      const stdout = result.stdout ?? "";
      const stderr = result.stderr ?? "";
      if (emulatorConsoleReportsFailure(stdout, stderr)) {
        return {
          supported: true,
          capability: "full",
          method: "android_emulator_console",
          verified: false,
          error: `${stdout}\n${stderr}`.trim() || "emu network status reported an error",
        };
      }
      return {
        supported: true,
        capability: "full",
        method: "android_emulator_console",
        ...(stdout.trim() ? { rawStatus: stdout.trim() } : {}),
      };
    } catch (error) {
      return {
        supported: true,
        capability: "full",
        method: "android_emulator_console",
        verified: false,
        error: errorMessage(error),
      };
    }
  }

  private getIosNetworkCondition(): NetworkConditionState {
    return {
      supported: false,
      capability: "unsupported",
      error: IOS_NETWORK_CONDITION_UNSUPPORTED_ERROR,
    };
  }

  private async setAndroidNetworkCondition(
    input: SetNetworkConditionInput,
  ): Promise<NetworkConditionState> {
    const kind = classifyNetworkConditionRequest(input);
    // A reset restores normal connectivity, so shaping overrides on the same
    // request are contradictory — drop them rather than apply latency while
    // reporting `none` (issue #6012 review). `resolveNetworkProfile` still reads
    // the original input to detect the cancel/reset intent.
    const isReset = kind === "reset";
    const effectiveInput: SetNetworkConditionInput = isReset
      ? { expiresInSeconds: input.expiresInSeconds }
      : input;
    const profile = resolveNetworkProfile(input);
    const values = resolveNetworkValues(profile, effectiveInput);
    const degrades = kind === "degrade";
    const expires =
      input.expiresInSeconds !== undefined ? { expiresInSeconds: input.expiresInSeconds } : {};
    const base = {
      method: "android_emulator_console" as const,
      requestedProfile: profile,
      values,
      ...expires,
    };
    // Non-applying kinds are answered before touching the device or the platform
    // guard: they issue no console command, so — like the physical-device branch —
    // they do NOT claim the emulator-console `method` (issue #6012 review). They
    // register no restore slot and are never reported verified.
    if (kind === "empty" || kind === "invalid" || kind === "loss-only") {
      const error =
        kind === "invalid"
          ? NETWORK_CONDITION_OFFLINE_OVERRIDE_ERROR
          : kind === "loss-only"
            ? NETWORK_CONDITION_LOSS_ONLY_UNSUPPORTED_ERROR
            : NETWORK_CONDITION_EMPTY_REQUEST_ERROR;
      // Echo the profile's documented baseline, NOT the caller's overrides —
      // nothing was applied, so an unapplied override must not appear in `values`
      // (issue #6012 review, the offline+override echo bug).
      return {
        supported: false,
        capability: "unsupported",
        requestedProfile: profile,
        values: NETWORK_CONDITION_PROFILES[profile],
        verified: false,
        ...expires,
        error,
      };
    }
    if (!isAndroidEmulatorSerial(this.device.deviceId)) {
      // Physical device: no emulator console, so do not claim its method.
      return {
        supported: false,
        capability: "unsupported",
        requestedProfile: profile,
        values,
        verified: false,
        ...expires,
        error: ANDROID_PHYSICAL_NETWORK_CONDITION_UNSUPPORTED_ERROR,
      };
    }
    return this.applyEmulatorNetworkCondition(
      profile,
      effectiveInput,
      values,
      degrades,
      isReset,
      input,
      base,
    );
  }

  /**
   * Issue the emulator shaping commands and assemble the result. Any failure —
   * a `KO` result OR a thrown command — rolls a degrade back to normal
   * connectivity (best-effort) so a partial application is never left on the
   * device (issue #6012 review P2).
   */
  private async applyEmulatorNetworkCondition(
    profile: NetworkConditionProfile,
    effectiveInput: SetNetworkConditionInput,
    values: NetworkConditionValues,
    degrades: boolean,
    isReset: boolean,
    input: SetNetworkConditionInput,
    base: NetworkConditionResultBase,
  ): Promise<NetworkConditionState> {
    const failure = (error: string): NetworkConditionState => ({
      supported: true,
      capability: degrades ? "partial" : "full",
      verified: false,
      ...base,
      error,
    });
    let adb: AdbExecutor;
    try {
      adb = this.adbFactory.create(this.device);
    } catch (error) {
      return failure(errorMessage(error));
    }
    try {
      const commandError = await this.runEmulatorNetworkCommands(
        adb,
        buildEmulatorNetworkCommands(profile, effectiveInput, values),
      );
      if (commandError) {
        if (degrades) {
          await this.rollbackNetworkConditionToNone(adb);
        }
        return failure(commandError);
      }
      // Toggle Wi-Fi so a shaping/cut condition reaches traffic (best-effort;
      // never aborts — a failure only feeds the `partial`/unverified report).
      const wifiWarning = await this.toggleWifiBestEffort(adb, wifiToggleCommand(degrades));
      return this.buildAppliedNetworkResult(base, profile, degrades, wifiWarning, isReset, input);
    } catch (error) {
      // A THROWN command can also leave a partial application, so roll back a
      // degrade here too — the `KO` path is not the only failure mode.
      if (degrades) {
        await this.rollbackNetworkConditionToNone(adb);
      }
      return failure(errorMessage(error));
    }
  }

  /** Best-effort rollback to normal connectivity after a failed degrade sequence. */
  private async rollbackNetworkConditionToNone(adb: AdbExecutor): Promise<void> {
    for (const command of NETWORK_CONDITION_ROLLBACK_COMMANDS) {
      try {
        await adb.executeCommand(command, undefined, undefined, true);
      } catch (error) {
        // Rollback is best-effort — the primary error is already being returned.
        logger.debug(`[DeviceState] network rollback '${command}' failed: ${error}`);
      }
    }
  }

  /**
   * Run the emulator shaping commands in order. Returns an error string on the
   * first command the console rejects (`KO`/shell failure), or null when all
   * succeeded.
   */
  private async runEmulatorNetworkCommands(
    adb: AdbExecutor,
    commands: string[],
  ): Promise<string | null> {
    for (const command of commands) {
      const result = await adb.executeCommand(command, undefined, undefined, true);
      const stdout = result.stdout ?? "";
      const stderr = result.stderr ?? "";
      if (emulatorConsoleReportsFailure(stdout, stderr)) {
        return `${stdout}\n${stderr}`.trim() || `${command} reported an error`;
      }
    }
    return null;
  }

  /** Assemble the success result for an applied (or reset) network condition. */
  private buildAppliedNetworkResult(
    base: NetworkConditionResultBase,
    profile: NetworkConditionProfile,
    degrades: boolean,
    wifiWarning: string | undefined,
    isReset: boolean,
    input: SetNetworkConditionInput,
  ): NetworkConditionState {
    const applied = { supported: true as const, profile, appliedProfile: profile, ...base };
    if (!degrades) {
      const overrideDiscarded = isReset && hasShapingOverride(input);
      const overrideNote = overrideDiscarded
        ? "Shaping overrides were ignored because cancel/reset was requested."
        : undefined;
      if (wifiWarning) {
        // Reset could not re-enable Wi-Fi, so connectivity is NOT fully restored.
        // Reporting verified success here would stop the session restorer from
        // retrying and leave the device with Wi-Fi off (issue #6012 review P1).
        // Report unverified + error so the restorer keeps retrying / quarantines.
        return {
          ...applied,
          capability: "partial",
          verified: false,
          error: overrideNote ? `${overrideNote} ${wifiWarning}` : wifiWarning,
        };
      }
      // Reset removes all shaping and re-enables both radios — the safe restore
      // direction, fully applied and verifiable-by-completion.
      return {
        ...applied,
        capability: "full",
        verified: true,
        ...(overrideNote ? { warning: overrideNote } : {}),
      };
    }
    // Degrading profile (including offline): the commands were accepted, but
    // effectiveness depends on the emulator's transport and the best-effort
    // Wi-Fi toggle, so report `partial` with a warning and NO `verified: true`.
    return {
      ...applied,
      capability: "partial",
      warning: wifiWarning
        ? `${NETWORK_CONDITION_PARTIAL_WARNING} (${wifiWarning})`
        : NETWORK_CONDITION_PARTIAL_WARNING,
    };
  }

  /**
   * Toggle Wi-Fi via `svc wifi`, swallowing failure. Returns a short warning
   * fragment when the toggle did not cleanly succeed (so the caller can fold it
   * into the `partial` report), or undefined on success. Never throws: Wi-Fi
   * toggling is best-effort and its failure must not fail the whole request.
   */
  private async toggleWifiBestEffort(
    adb: AdbExecutor,
    command: string,
  ): Promise<string | undefined> {
    try {
      const result = await adb.executeCommand(command, undefined, undefined, true);
      const stdout = result.stdout ?? "";
      const stderr = result.stderr ?? "";
      if (outputLooksLikeShellFailure(stdout, stderr)) {
        return `Wi-Fi toggle '${command}' reported: ${`${stdout} ${stderr}`.trim()}`;
      }
      return undefined;
    } catch (error) {
      // Connection/permission failures here are expected on some API levels and
      // must not abort the shaping request; surface them only as a warning.
      logger.debug(`[DeviceState] wifi toggle '${command}' failed: ${error}`);
      return `Wi-Fi toggle '${command}' failed: ${errorMessage(error)}`;
    }
  }

  private setIosNetworkCondition(input: SetNetworkConditionInput): NetworkConditionState {
    const profile = resolveNetworkProfile(input);
    return {
      supported: false,
      capability: "unsupported",
      requestedProfile: profile,
      values: resolveNetworkValues(profile, input),
      verified: false,
      error: IOS_NETWORK_CONDITION_UNSUPPORTED_ERROR,
    };
  }
}
