import { toActionableError } from "../models/ActionableError";
import { z } from "zod/v4";
import { PLAN_SKELETON } from "./toolRegistryTypes";
import { ToolRegistry, ProgressCallback } from "./toolRegistry";
import { BiometricAuth } from "../features/action/BiometricAuth";
import { ActionableError, BootedDevice } from "../models";
import { createStructuredToolResponse } from "../utils/toolUtils";
import {
  addDeviceTargetingToSchema,
  addSessionUuidToSchema,
  responseShapeControlFields,
} from "../utils/schemaHelpers";
import {
  biometricAuthResultSchema,
  getIosSimulatorCapabilitiesResultSchema,
} from "./biometricToolOutputSchemas";
import { computeIosSimulatorCapabilities } from "../features/utility/iosSimulatorCapabilities";
import { DeviceState, type BiometricEnrollment } from "../features/utility/DeviceState";
import { defaultDaemonContext, type DaemonContext } from "../daemon/daemonContext";
import type { SessionManager } from "../daemon/sessionManager";
import { runSessionBiometricMutation } from "./sessionBiometricEnrollment";

// Type definitions for better TypeScript support
export type BiometricAuthArgs = z.output<typeof biometricAuthSchema>;

// Schema definition
//
// #6712: `.strict()` — the advertised `additionalProperties: false` was not
// enforced at runtime, so an undeclared caller argument was silently dropped.
// The `errorCode` refinement is applied AFTER `addDeviceTargetingToSchema`
// because zod v4's `.extend()` (which that helper uses) drops a base object's
// refinements; applied inside, the check never ran.
export const biometricAuthSchema = addDeviceTargetingToSchema(
  z
    .object({
      action: z
        .enum(["match", "fail", "cancel", "error", "enroll", "unenroll"])
        .describe(
          "match/fail/enroll/unenroll on iOS Simulator; cancel/error need the AutoMobile SDK in the app",
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
      ...responseShapeControlFields,
    })
    .strict(),
).refine((data) => data.errorCode === undefined || data.action === "error", {
  message: "errorCode is only applicable when action is 'error'",
  path: ["errorCode"],
});

export const getIosSimulatorCapabilitiesSchema = addSessionUuidToSchema(
  z
    .object({
      deviceType: z
        .string()
        .min(1)
        .describe("CoreSimulator device-type identifier selected from automobile:devices/images."),
      runtime: z
        .string()
        .min(1)
        .describe("CoreSimulator runtime identifier selected from automobile:devices/images."),
    })
    .strict(),
);

interface BiometricEnrollmentCapture {
  sessionManager?: SessionManager;
  initialEnrollment?: BiometricEnrollment;
}

async function captureBiometricEnrollment(
  device: BootedDevice,
  args: BiometricAuthArgs,
  daemon: DaemonContext = defaultDaemonContext,
): Promise<BiometricEnrollmentCapture> {
  const changesEnrollment = args.action === "enroll" || args.action === "unenroll";
  const sessionManager =
    changesEnrollment && args.sessionUuid ? daemon.sessionManager() : undefined;
  if (!sessionManager || !args.sessionUuid) {
    return {};
  }
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
export const getIosSimulatorCapabilitiesHandler = async (
  args: Pick<z.infer<typeof getIosSimulatorCapabilitiesSchema>, "deviceType" | "runtime">,
) =>
  createStructuredToolResponse(
    computeIosSimulatorCapabilities({
      deviceType: args.deviceType,
      runtime: args.runtime,
    }),
  );

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
      const result = await runSessionBiometricMutation(
        capture.sessionManager,
        args.sessionUuid,
        device.deviceId,
        {
          initialEnrollment: capture.initialEnrollment,
          mutation: () =>
            biometricAuth.execute(
              {
                action: args.action,
                modality: args.modality,
                fingerprintId: args.fingerprintId,
                errorCode: args.errorCode,
                ttlMs: args.ttlMs,
              },
              progress,
            ),
        },
      );

      if (!result.success) {
        throw new ActionableError(result.error || `Failed to execute biometric ${args.action}`);
      }

      return createStructuredToolResponse({
        message: result.message || `Biometric ${args.action} executed`,
        observation: result.observation,
        ...result,
      });
    } catch (error) {
      throw toActionableError(error, `Failed to execute biometric authentication`);
    }
  };

  ToolRegistry.register(
    "getIosSimulatorCapabilities",
    "Discover biometric capabilities for a selected iOS Simulator device type and runtime.",
    getIosSimulatorCapabilitiesSchema,
    {
      handler: getIosSimulatorCapabilitiesHandler,
      defaultEnabled: false,
      readOnly: true,
      outputSchema: getIosSimulatorCapabilitiesResultSchema,
    },
  );

  // Register the tool
  ToolRegistry.registerDeviceAware(
    "biometricAuth",
    "Simulate biometric auth: Android emulator/SDK hook, or iOS via the app's AutoMobile SDK or Simulator.",
    biometricAuthSchema,
    {
      handler: biometricAuthHandler,
      defaultEnabled: false,
      supportsProgress: true,
      outputSchema: biometricAuthResultSchema,
      ...PLAN_SKELETON,
    },
  );
}
