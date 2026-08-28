/**
 * Stable, pre-session capability contract for iOS Simulator features AutoMobile
 * can control. Device type and runtime identify the caller's selected simulator;
 * BiometricKit's notifyutil contract is shared by supported iOS Simulator types.
 */

export const IOS_SIMULATOR_CAPABILITIES_SCHEMA_VERSION = 1 as const;

export type IosSimulatorCapabilityId =
  | "biometrics.enrollment"
  | "biometrics.match"
  | "biometrics.fail"
  | "biometrics.cancel"
  | "biometrics.error";

export type IosSimulatorCapabilityState = "supported" | "partial" | "unsupported";

export interface IosSimulatorCapability {
  id: IosSimulatorCapabilityId;
  state: IosSimulatorCapabilityState;
  reason: string;
  prerequisites?: string[];
}

export interface IosSimulatorCapabilitiesContext {
  /** CoreSimulator device-type identifier selected from automobile:devices/images. */
  deviceType: string;
  /** CoreSimulator runtime identifier selected from automobile:devices/images. */
  runtime: string;
}

/**
 * Whether the requested device-type/runtime pair can host BiometricKit at all.
 * `automobile:devices/images` lists every CoreSimulator device type and runtime,
 * including watchOS/tvOS entries, so the selection must be validated before any
 * biometric capability is advertised.
 */
export interface IosSimulatorSelectionValidity {
  valid: boolean;
  reason?: string;
}

export interface IosSimulatorCapabilitiesReport {
  schemaVersion: typeof IOS_SIMULATOR_CAPABILITIES_SCHEMA_VERSION;
  platform: "ios";
  deviceType: string;
  runtime: string;
  selection: IosSimulatorSelectionValidity;
  capabilities: IosSimulatorCapability[];
}

const BIOMETRIC_ENROLLMENT_PREREQUISITE =
  "Set biometrics.enrollment to enrolled with setDeviceState before simulating a match or fail.";

const DEVICE_TYPE_PREFIX = "com.apple.CoreSimulator.SimDeviceType.";
const RUNTIME_PREFIX = "com.apple.CoreSimulator.SimRuntime.";

/** CoreSimulator device families that expose BiometricKit (Touch ID / Face ID). */
const BIOMETRIC_DEVICE_FAMILY_PATTERN = /^(iPhone|iPad)[-.]/i;
const IOS_RUNTIME_PATTERN = /^iOS[-.]/i;

function stripPrefix(value: string, prefix: string): string {
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

/**
 * Validate the selected pair. A trailing separator is appended before matching
 * so a bare family name ("iPhone") and a versioned identifier ("iPhone-16") are
 * treated alike, while "iPhoneish" is not.
 */
function validateSelection(
  context: IosSimulatorCapabilitiesContext,
): IosSimulatorSelectionValidity {
  const deviceType = stripPrefix(context.deviceType.trim(), DEVICE_TYPE_PREFIX);
  const runtime = stripPrefix(context.runtime.trim(), RUNTIME_PREFIX);
  if (!BIOMETRIC_DEVICE_FAMILY_PATTERN.test(`${deviceType}-`)) {
    return {
      valid: false,
      reason: `Device type "${context.deviceType}" has no BiometricKit support.`,
    };
  }
  if (!IOS_RUNTIME_PATTERN.test(`${runtime}-`)) {
    return {
      valid: false,
      reason: `Runtime "${context.runtime}" is not an iOS Simulator runtime.`,
    };
  }
  return { valid: true };
}

function unsupportedCapabilities(reason: string): IosSimulatorCapability[] {
  return (
    [
      "biometrics.enrollment",
      "biometrics.match",
      "biometrics.fail",
      "biometrics.cancel",
      "biometrics.error",
    ] as const
  ).map((id) => ({ id, state: "unsupported" as const, reason }));
}

function supportedCapabilities(): IosSimulatorCapability[] {
  return [
    {
      id: "biometrics.enrollment",
      state: "supported",
      reason: "BiometricKit enrollment can be read and set through Simulator notifyutil.",
    },
    {
      id: "biometrics.match",
      state: "partial",
      reason: "Simulator can inject a biometric match after enrollment is configured.",
      prerequisites: [BIOMETRIC_ENROLLMENT_PREREQUISITE],
    },
    {
      id: "biometrics.fail",
      state: "partial",
      reason: "Simulator can inject a biometric non-match after enrollment is configured.",
      prerequisites: [BIOMETRIC_ENROLLMENT_PREREQUISITE],
    },
    {
      id: "biometrics.cancel",
      state: "unsupported",
      reason: "iOS Simulator exposes no public biometric cancellation injection.",
    },
    {
      id: "biometrics.error",
      state: "unsupported",
      reason: "iOS Simulator exposes no public biometric error injection.",
    },
  ];
}

/**
 * Report capabilities independent of a running simulator. This is intentionally
 * pure so callers can negotiate the contract before creating a session.
 */
export function computeIosSimulatorCapabilities(
  context: IosSimulatorCapabilitiesContext,
): IosSimulatorCapabilitiesReport {
  const selection = validateSelection(context);
  return {
    schemaVersion: IOS_SIMULATOR_CAPABILITIES_SCHEMA_VERSION,
    platform: "ios",
    deviceType: context.deviceType,
    runtime: context.runtime,
    selection,
    capabilities: selection.valid
      ? supportedCapabilities()
      : unsupportedCapabilities(selection.reason ?? "Unsupported iOS Simulator selection."),
  };
}

export function findIosSimulatorCapability(
  report: IosSimulatorCapabilitiesReport,
  id: IosSimulatorCapabilityId,
): IosSimulatorCapability | undefined {
  return report.capabilities.find((capability) => capability.id === id);
}
