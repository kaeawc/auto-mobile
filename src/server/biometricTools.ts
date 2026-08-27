import { z } from "zod/v4";
import { ToolRegistry, ProgressCallback } from "./toolRegistry";
import { BiometricAuth, BiometricAuthOptions } from "../features/action/BiometricAuth";
import { ActionableError, BootedDevice } from "../models";
import { createJSONToolResponse } from "../utils/toolUtils";
import { addDeviceTargetingToSchema } from "./toolSchemaHelpers";
import { computeIosSimulatorCapabilities } from "../features/utility/iosSimulatorCapabilities";
import { DeviceState, type BiometricEnrollment } from "../features/utility/DeviceState";
import { DaemonState } from "../daemon/daemonState";
import type { SessionManager } from "../daemon/sessionManager";

// Type definitions for better TypeScript support
export interface BiometricAuthArgs extends BiometricAuthOptions {
  // Device targeting fields are added by addDeviceTargetingToSchema.
  sessionUuid?: string;
}

// Schema definition
export const biometricAuthSchema = addDeviceTargetingToSchema(
  z
    .object({
      action: z
        .enum(["match", "fail", "cancel", "error", "enroll", "unenroll"])
        .describe(
          "match/fail/enroll/unenroll on iOS Simulator; cancel/error require Android SDK hook",
        ),
      modality: z
        .enum(["any", "fingerprint", "face"])
        .optional()
        .describe("Modality: any default, fingerprint, or face"),
      fingerprintId: z
        .number()
        .optional()
        .describe("Fingerprint ID: default 1 for match/error, 2 for fail/cancel"),
      errorCode: z.number().optional().describe("BiometricPrompt error code; action=error only"),
      ttlMs: z.number().optional().describe("SDK override TTL ms (default 5000)"),
    })
    .refine((data) => data.errorCode === undefined || data.action === "error", {
      message: "errorCode is only applicable when action is 'error'",
      path: ["errorCode"],
    }),
);

export const getIosSimulatorCapabilitiesSchema = z.object({
  deviceType: z
    .string()
    .min(1)
    .describe("CoreSimulator device-type identifier selected from automobile:devices/images."),
  runtime: z
    .string()
    .min(1)
    .describe("CoreSimulator runtime identifier selected from automobile:devices/images."),
});

interface BiometricEnrollmentCapture {
  sessionManager?: SessionManager;
  initialEnrollment?: BiometricEnrollment;
}

async function captureBiometricEnrollment(
  device: BootedDevice,
  args: BiometricAuthArgs,
): Promise<BiometricEnrollmentCapture> {
  const changesEnrollment = args.action === "enroll" || args.action === "unenroll";
  if (!changesEnrollment || !args.sessionUuid || !DaemonState.getInstance().isInitialized()) {
    return {};
  }
  const sessionManager = DaemonState.getInstance().getSessionManager();
  if (sessionManager.getBiometricEnrollment(args.sessionUuid)) {
    return { sessionManager };
  }
  const state = await new DeviceState(device).getBiometricEnrollmentState();
  if (!state.supported || !state.enrollment || state.error) {
    throw new ActionableError(
      state.error ?? "Failed to read iOS Simulator biometric enrollment state",
    );
  }
  return { sessionManager, initialEnrollment: state.enrollment };
}

/**
 * Register biometric authentication tools
 */
export function registerBiometricTools() {
  // Biometric auth handler
  const biometricAuthHandler = async (
    device: BootedDevice,
    args: BiometricAuthArgs,
    progress?: ProgressCallback,
  ) => {
    try {
      const capture = await captureBiometricEnrollment(device, args);
      const biometricAuth = new BiometricAuth(device);
      const result = await biometricAuth.execute(
        {
          action: args.action,
          modality: args.modality,
          fingerprintId: args.fingerprintId,
          errorCode: args.errorCode,
          ttlMs: args.ttlMs,
        },
        progress,
      );

      if (result.success && capture.sessionManager && capture.initialEnrollment) {
        capture.sessionManager.setBiometricEnrollment(args.sessionUuid!, {
          initialEnrollment: capture.initialEnrollment,
        });
      }
      if (!result.success) {
        throw new ActionableError(result.error || `Failed to execute biometric ${args.action}`);
      }

      return createJSONToolResponse({
        message: result.message || `Biometric ${args.action} executed`,
        observation: result.observation,
        ...result,
      });
    } catch (error) {
      throw new ActionableError(`Failed to execute biometric authentication: ${error}`);
    }
  };

  const getIosSimulatorCapabilitiesHandler = async (
    args: z.infer<typeof getIosSimulatorCapabilitiesSchema>,
  ) =>
    createJSONToolResponse(
      computeIosSimulatorCapabilities({
        deviceType: args.deviceType,
        runtime: args.runtime,
      }),
    );

  ToolRegistry.register(
    "getIosSimulatorCapabilities",
    "Discover biometric capabilities for a selected iOS Simulator device type and runtime.",
    getIosSimulatorCapabilitiesSchema,
    getIosSimulatorCapabilitiesHandler,
    { defaultEnabled: false },
  );

  // Register the tool
  ToolRegistry.registerDeviceAware(
    "biometricAuth",
    "Simulate biometric auth: Android emulator/SDK hook or iOS Simulator.",
    biometricAuthSchema,
    biometricAuthHandler,
    { defaultEnabled: false, supportsProgress: true },
  );
}
