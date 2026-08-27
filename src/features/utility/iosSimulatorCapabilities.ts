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

export interface IosSimulatorCapabilitiesReport {
  schemaVersion: typeof IOS_SIMULATOR_CAPABILITIES_SCHEMA_VERSION;
  platform: "ios";
  deviceType: string;
  runtime: string;
  capabilities: IosSimulatorCapability[];
}

const BIOMETRIC_ENROLLMENT_PREREQUISITE =
  "Set biometrics.enrollment to enrolled with setDeviceState before simulating a match or fail.";

/**
 * Report capabilities independent of a running simulator. This is intentionally
 * pure so callers can negotiate the contract before creating a session.
 */
export function computeIosSimulatorCapabilities(
  context: IosSimulatorCapabilitiesContext,
): IosSimulatorCapabilitiesReport {
  return {
    schemaVersion: IOS_SIMULATOR_CAPABILITIES_SCHEMA_VERSION,
    platform: "ios",
    deviceType: context.deviceType,
    runtime: context.runtime,
    capabilities: [
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
    ],
  };
}

export function findIosSimulatorCapability(
  report: IosSimulatorCapabilitiesReport,
  id: IosSimulatorCapabilityId,
): IosSimulatorCapability | undefined {
  return report.capabilities.find((capability) => capability.id === id);
}
