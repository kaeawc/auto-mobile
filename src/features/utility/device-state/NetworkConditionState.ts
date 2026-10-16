import { z } from "zod/v4";
import {
  networkFilterNextStep,
  type NetworkFilterState,
} from "../../network-filter/NetworkFilterBridge";
import { IOS_APP_NETWORK_RULE_LEASE_MS } from "../../network-filter/IosAppNetworkRuleClient";

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
export const networkConditionProfileSchema = z.enum([
  "none",
  "offline",
  "veryBad",
  "2g",
  "3g",
  "4g",
]);
export type NetworkConditionProfile = z.infer<typeof networkConditionProfileSchema>;

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

/**
 * Upper bound for `expiresInSeconds` (issue #6085 item 4). A single
 * `setTimeout(ms)` in Node/Bun truncates its delay to a signed 32-bit int, so any
 * value above `2_147_483_647` ms (~24.85 days) wraps to a tiny delay and would
 * reset the network almost immediately. Cap the accepted TTL at
 * `floor(2_147_483_647 / 1000)` seconds so the millisecond product always fits.
 */
export const MAX_NETWORK_CONDITION_TTL_SECONDS = Math.floor(2_147_483_647 / 1000);

/**
 * State of the iOS Simulator network-extension backend (#10590): whether the
 * controller is installed, approved and answering.
 */
export interface NetworkConditionBackendState {
  state: NetworkFilterState;
  /** Controller JSON contract version, when the controller gave a valid answer. */
  contractVersion?: number;
  /** The controller's detail, or why the bridge could not get an answer. */
  detail: string;
  /** What the caller does next from this state. */
  nextStep: string;
}

/** One leased per-app rule the iOS Simulator provider enforces (#10264). */
export interface IosAppNetworkRuleState {
  appId: string;
  profile: "offline";
  revision: number;
  ownerGeneration: number;
  /** The owning daemon session (reads only). */
  owner?: string;
  /** Milliseconds until the provider ends the rule unless the session renews it. */
  leaseExpiresInMs?: number;
  /** New flows of the app the provider refused under this revision (reads only). */
  droppedFlows?: number;
}

export interface NetworkConditionState {
  supported: boolean;
  capability?: NetworkConditionCapability;
  method?: "android_emulator_console";
  /** iOS Simulator only: the host backend that will shape traffic. */
  backend?: "network-extension";
  /** iOS Simulator only: the backend's install/approval state and next step. */
  controller?: NetworkConditionBackendState;
  /**
   * What the condition applies to. iOS Simulator is always `app` (one app on
   * one simulator); a request without `appId` is `device` and refused there.
   */
  scope?: "device" | "app";
  /** iOS Simulator writes: the targeted app's bundle id. */
  appId?: string;
  /** iOS Simulator writes: the rule the provider acknowledged. */
  rule?: IosAppNetworkRuleState;
  /** iOS Simulator reads: every rule the provider enforces on this simulator. */
  rules?: IosAppNetworkRuleState[];
  /**
   * The provider acknowledged the configuration. Acknowledgement is not proof
   * of traffic behaviour, so `verified` stays unset.
   */
  acknowledged?: boolean;
  /** `partial`: flows the filter cannot attribute to the app are allowed. */
  coverage?: "partial";
  /** What the applied condition does and does not cover. */
  limitations?: string[];
  /** The profile the platform actually applied (writes) or the baseline (reads). */
  profile?: NetworkConditionProfile;
  requestedProfile?: NetworkConditionProfile;
  appliedProfile?: NetworkConditionProfile;
  /** Explicit documented values applied (may reflect caller overrides). */
  values?: NetworkConditionValues;
  verified?: boolean;
  /**
   * TTL echoed back. Enforced by the session layer: a per-condition timer resets
   * the device to `none` when it elapses (issue #6085 item 2), and session
   * release/expiry also restores connectivity — whichever comes first.
   */
  expiresInSeconds?: number;
  /** Best-effort emulator `network status` readback (reads only). */
  rawStatus?: string;
  /**
   * Best-effort structured parse of the emulator `network status` readback (reads
   * only, issue #6085 item 3). Only the fields the free-text output could be
   * parsed into are present; an unparseable or absent field is omitted, and the
   * verbatim `rawStatus` is always kept alongside. It is deliberately NOT used to
   * claim `verified` at the read layer — the read carries no requested profile to
   * compare against — so it is a diagnostic signal, not a verification verdict.
   */
  observedValues?: Partial<NetworkConditionValues>;
  warning?: string;
  error?: string;
}

/** Shared fields every Android network-condition result carries. */
export interface NetworkConditionResultBase {
  method: "android_emulator_console";
  requestedProfile: NetworkConditionProfile;
  values: NetworkConditionValues;
  expiresInSeconds?: number;
}

export interface SetNetworkConditionInput {
  profile?: NetworkConditionProfile;
  /**
   * iOS Simulator only, and required there: the bundle id of the one app to take
   * offline (`profile: "offline"`) or restore (`profile: "none"`/reset) (#10264).
   */
  appId?: string;
  /** Reset to normal connectivity (equivalent to `profile: "none"`). */
  cancel?: boolean;
  /** Alias of `cancel`. */
  reset?: boolean;
  /** Optional explicit overrides that supersede the profile's named specs. */
  delayMs?: number;
  downloadKbps?: number;
  uploadKbps?: number;
  packetLossPercent?: number;
  /**
   * TTL in seconds. When set on a degrade, the session layer schedules a timer
   * that resets the device to `none` when it elapses (issue #6085 item 2);
   * session release/expiry also restores connectivity, whichever comes first.
   */
  expiresInSeconds?: number;
}

/**
 * Physical iOS devices expose no host-driven network shaping: Apple's device
 * tooling has no network verb, and the on-device Network Link Conditioner is a
 * manual Developer setting.
 */
export const IOS_PHYSICAL_NETWORK_CONDITION_UNSUPPORTED_ERROR =
  "Network-condition simulation is unavailable on a physical iOS device: Apple's device tooling " +
  "exposes no network-shaping verb, and the on-device Network Link Conditioner " +
  "(Settings > Developer) can only be set by hand.";

/**
 * iOS Simulator network conditions run through the opt-in macOS Network
 * Extension backend (#6298). Until it is installed, approved and answering,
 * every simulator read and write is unsupported with a message for its state.
 */
export function iosSimulatorNetworkConditionError(state: NetworkFilterState): string {
  const prefix =
    "Network-condition simulation on iOS Simulator uses AutoMobile's macOS network-extension " +
    "backend, which is not ready.";
  return `${prefix} ${networkFilterNextStep(state)}`;
}

/** A simulator shares the Mac's network stack, so only one app at a time is selectable (#10264). */
export const IOS_SIMULATOR_NETWORK_CONDITION_APP_REQUIRED_ERROR =
  "On iOS Simulator, networkCondition applies to one app, never the whole simulator: pass " +
  "networkCondition.appId (the app's bundle id) with profile `offline`, or `none` to restore it. " +
  "The simulator shares the Mac's network stack, so a device-wide condition is not supported.";

export const IOS_SIMULATOR_NETWORK_CONDITION_SESSION_REQUIRED_ERROR =
  "Taking an iOS Simulator app offline needs a daemon session: the session renews the network " +
  "filter's lease and removes the rule on release, rebind or expiry. Run this call within a session.";

/** What a per-app iOS offline rule does and does not cover (#10264). */
export const IOS_APP_NETWORK_CONDITION_LIMITATIONS: readonly string[] = Object.freeze([
  "Only new connections of the app are refused; connections already open keep working until they close.",
  "Flows the filter cannot attribute to this app on this simulator are allowed, so coverage is partial.",
  "The provider acknowledged the rule; AutoMobile does not verify traffic behaviour.",
  `The rule ends on its own unless the session renews it within ${IOS_APP_NETWORK_RULE_LEASE_MS / 1000}s.`,
  "Latency, bandwidth and packet-loss profiles are not supported on iOS Simulator (#10265).",
]);

export function iosUnsupportedNetworkConditionError(input: SetNetworkConditionInput): string {
  const named = [
    ...(input.profile !== undefined && input.profile !== "offline" && input.profile !== "none"
      ? [`profile \`${input.profile}\``]
      : []),
    ...(["delayMs", "downloadKbps", "uploadKbps", "packetLossPercent"] as const)
      .filter((field) => input[field] !== undefined && input[field] !== 0)
      .map((field) => `\`${field}\``),
  ];
  return (
    `iOS Simulator supports only profile \`offline\` and \`none\` for one app; ` +
    `${named.join(", ") || "this request"} cannot be applied (latency and bandwidth shaping is #10265).`
  );
}

/**
 * What an iOS per-app write did to the session's rule, for the session layer:
 * the provider installed it, removed it, or neither.
 */
export function iosAppNetworkRuleOutcome(result: {
  networkCondition?: NetworkConditionState;
}): "installed" | "removed" | "unchanged" {
  const state = result.networkCondition;
  if (!state || state.scope !== "app" || state.error || !state.acknowledged) {
    return "unchanged";
  }
  if (state.appliedProfile === "offline") {
    return "installed";
  }
  return state.appliedProfile === "none" ? "removed" : "unchanged";
}

/**
 * Physical Android devices expose no unprivileged, OS-wide traffic shaper. The
 * emulator console (`adb emu network ...`) does not exist off-emulator, and
 * `svc data`/`svc wifi` only toggle radios fully on/off (and need privileged
 * permissions), so degraded-connectivity profiles cannot be applied.
 */
export const ANDROID_PHYSICAL_NETWORK_CONDITION_UNSUPPORTED_ERROR =
  "Network-condition simulation is only available on Android emulators: it uses the emulator " +
  "console (`adb emu network ...`), which physical devices do not expose. On a physical device " +
  "the radios can only be toggled fully on/off (svc data/wifi, privileged). Use an emulator or a " +
  "host-side proxy for degraded-network testing.";

/**
 * Best-effort parse of the emulator console `network status` free text into the
 * structured applied values (issue #6085 item 3). The output — per the Android
 * emulator console — is roughly:
 *
 *   Current network status:
 *     download speed:   236800 bits/s (231.2 KB/s)
 *     upload speed:     118400 bits/s (115.6 KB/s)
 *     minimum latency:  80 ms
 *     maximum latency:  400 ms
 *
 * The exact shape varies by emulator version, so this is DELIBERATELY DEFENSIVE:
 * every field is optional, an absent or unparseable field is simply omitted, and
 * it never throws. It returns only the subset it could extract, or `null` when
 * nothing parsed — callers then fall back to surfacing `rawStatus` verbatim
 * without claiming any structured value they could not actually read.
 *
 * `download/uploadKbps` are converted from the reported bits/s to kbps (the
 * vocabulary the `network speed` setter uses); `delayMs` reflects the MAXIMUM
 * latency (a profile's documented delay is its max), falling back to the minimum
 * latency when only that is present. `packetLossPercent` is never derived — the
 * console has no loss verb, so the status output carries none.
 */
export function parseEmulatorNetworkStatus(raw: string): Partial<NetworkConditionValues> | null {
  if (!raw) {
    return null;
  }
  const parsed: Partial<NetworkConditionValues> = {};
  const bitsPerSecToKbps = (match: RegExpMatchArray | null): number | undefined => {
    if (!match) {
      return undefined;
    }
    const bits = Number.parseInt(match[1].replace(/,/g, ""), 10);
    return Number.isFinite(bits) ? Math.round(bits / 1000) : undefined;
  };
  const download = bitsPerSecToKbps(raw.match(/download speed:\s*([\d,]+)\s*bits\/s/i));
  if (download !== undefined) {
    parsed.downloadKbps = download;
  }
  const upload = bitsPerSecToKbps(raw.match(/upload speed:\s*([\d,]+)\s*bits\/s/i));
  if (upload !== undefined) {
    parsed.uploadKbps = upload;
  }
  // Prefer the max latency (matches a profile's documented delay); fall back to
  // the min when only that is reported.
  const latencyMatch =
    raw.match(/maximum latency:\s*(\d+)\s*ms/i) ?? raw.match(/minimum latency:\s*(\d+)\s*ms/i);
  if (latencyMatch) {
    const ms = Number.parseInt(latencyMatch[1], 10);
    if (Number.isFinite(ms)) {
      parsed.delayMs = ms;
    }
  }
  return Object.keys(parsed).length > 0 ? parsed : null;
}

/**
 * Resolve the requested profile: `cancel`/`reset` (or an absent profile) map to
 * `none`, the unshaped baseline.
 */
export function resolveNetworkProfile(input: SetNetworkConditionInput): NetworkConditionProfile {
  if (input.cancel || input.reset) {
    return "none";
  }
  return input.profile ?? "none";
}

/** Merge caller overrides onto the profile's documented values. */
export function resolveNetworkValues(
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
 *                with no EFFECTIVE (non-neutral) shaping override — `none` plus
 *                only zero/no-op overrides is a clean reset (issue #6090).
 * - `degrade`:   a real profile, or a NON-NEUTRAL bandwidth/latency override over
 *                `none` (a zero override is a documented no-op, not shaping).
 * - `loss-only`: ONLY a non-zero `packetLossPercent` (which the emulator console
 *                cannot enforce) — an unsupported no-op, never reported verified.
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
  // Only a NON-NEUTRAL override degrades: a zero (documented no-op) delay/speed is
  // not shaping, so `none` + all-neutral overrides falls through to `reset` rather
  // than needlessly disabling Wi-Fi (issue #6090). The offline-invalid check above
  // stays presence-based, matching the advertised schema's presence-based rule.
  if (hasEffectiveShapingOverride(input)) {
    return "degrade";
  }
  if (isEffectivePacketLoss(input.packetLossPercent)) {
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
export function hasShapingOverride(input: SetNetworkConditionInput): boolean {
  return (
    input.delayMs !== undefined ||
    input.downloadKbps !== undefined ||
    input.uploadKbps !== undefined
  );
}

/**
 * A neutral override value is the documented no-op: `0` (no added latency, and
 * `0` kbps means "unlimited" for the emulator `network speed` cap). `undefined`
 * is likewise neutral. Only a non-neutral value shapes traffic, so a request
 * carrying only neutral overrides is not a degrade (issue #6090).
 */
function isNeutralOverrideValue(value: number | undefined): boolean {
  return value === undefined || value === 0;
}

/**
 * True when the request carries a bandwidth/latency override that actually shapes
 * traffic (a non-neutral value). Unlike `hasShapingOverride` (which is
 * presence-based, used for the offline contradiction), this ignores neutral
 * (zero) values so `none` + all-neutral overrides classifies as a `reset`.
 */
function hasEffectiveShapingOverride(input: SetNetworkConditionInput): boolean {
  return (
    !isNeutralOverrideValue(input.delayMs) ||
    !isNeutralOverrideValue(input.downloadKbps) ||
    !isNeutralOverrideValue(input.uploadKbps)
  );
}

/** True only when a packet-loss request carries a non-neutral (non-zero) target. */
function isEffectivePacketLoss(packetLossPercent: number | undefined): boolean {
  return !isNeutralOverrideValue(packetLossPercent);
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
export function wifiToggleCommand(degrades: boolean): string {
  return degrades ? "shell svc wifi disable" : "shell svc wifi enable";
}

export const NETWORK_CONDITION_PARTIAL_WARNING =
  "Applied best-effort. The emulator console (`network delay|speed`, `gsm data`) shapes only the " +
  "emulated cellular interface, and Wi-Fi was toggled with `svc wifi` — which is best-effort and " +
  "a no-op on newer API levels. If the emulator stays on an unshaped Wi-Fi transport the " +
  "condition may not take effect, so it is reported `partial`, not verified. Confirm connectivity " +
  "from within the app under test, or use a host-side proxy for guaranteed shaping.";

export const NETWORK_CONDITION_LOSS_ONLY_UNSUPPORTED_ERROR =
  "Packet loss is not enforceable via the Android emulator console (it has no loss verb), so a " +
  "networkCondition request whose only signal is packetLossPercent applies nothing and cannot be " +
  "reported as applied. Use a documented profile (which bundles latency and bandwidth) or a " +
  "host-side proxy for loss shaping.";

export const NETWORK_CONDITION_EMPTY_REQUEST_ERROR =
  "networkCondition specified no change to apply. Provide a profile, cancel/reset, or a " +
  "latency/bandwidth override.";

export const NETWORK_CONDITION_OFFLINE_OVERRIDE_ERROR =
  "networkCondition profile 'offline' cannot be combined with a latency/bandwidth override " +
  "(delayMs/downloadKbps/uploadKbps): offline disables the link, so there is nothing to shape. " +
  "Use 'offline' alone, or a connected profile with the override.";

/** Best-effort reset that undoes any shaping — used to roll back a failed degrade. */
export const NETWORK_CONDITION_ROLLBACK_COMMAND_TIMEOUT_MS = 2000;
export const NETWORK_CONDITION_ROLLBACK_TOTAL_TIMEOUT_MS = 6000;
export const NETWORK_CONDITION_ROLLBACK_COMMANDS = [
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
export function buildEmulatorNetworkCommands(
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
