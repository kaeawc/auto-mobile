import { z } from "zod/v4";
import { ToolRegistry, ProgressCallback } from "./toolRegistry";
import { BiometricAuth, BiometricAuthOptions } from "../features/action/BiometricAuth";
import { ActionableError, BootedDevice } from "../models";
import { createJSONToolResponse } from "../utils/toolUtils";
import { addDeviceTargetingToSchema } from "./toolSchemaHelpers";

// Type definitions for better TypeScript support
export interface BiometricAuthArgs extends BiometricAuthOptions {
  // Device targeting fields are added by addDeviceTargetingToSchema
}

// Schema definition
export const biometricAuthSchema = addDeviceTargetingToSchema(z.object({
  action: z.enum(["match", "fail", "cancel", "error"]).describe(
    "match/fail/cancel/error; cancel/error require Android SDK hook"
  ),
  modality: z.enum(["any", "fingerprint", "face"]).optional().describe(
    "Modality: any default, fingerprint, or face"
  ),
  fingerprintId: z.number().optional().describe(
    "Fingerprint ID: default 1 for match/error, 2 for fail/cancel"
  ),
  errorCode: z.number().optional().describe(
    "BiometricPrompt error code; action=error only"
  ),
  ttlMs: z.number().optional().describe(
    "SDK override TTL ms (default 5000)"
  )
}).refine(
  data => data.errorCode === undefined || data.action === "error",
  { message: "errorCode is only applicable when action is 'error'", path: ["errorCode"] }
));

/**
 * Register biometric authentication tools
 */
export function registerBiometricTools() {
  // Biometric auth handler
  const biometricAuthHandler = async (
    device: BootedDevice,
    args: BiometricAuthArgs,
    progress?: ProgressCallback
  ) => {
    try {
      const biometricAuth = new BiometricAuth(device);
      const result = await biometricAuth.execute({
        action: args.action,
        modality: args.modality,
        fingerprintId: args.fingerprintId,
        errorCode: args.errorCode,
        ttlMs: args.ttlMs
      }, progress);

      if (!result.success) {
        throw new ActionableError(result.error || `Failed to execute biometric ${args.action}`);
      }

      return createJSONToolResponse({
        message: result.message || `Biometric ${args.action} executed`,
        observation: result.observation,
        ...result
      });
    } catch (error) {
      throw new ActionableError(`Failed to execute biometric authentication: ${error}`);
    }
  };

  // Register the tool
  ToolRegistry.registerDeviceAware("biometricAuth", "Simulate biometric auth: Android emulator/SDK hook or iOS Simulator.", biometricAuthSchema, biometricAuthHandler, { supportsProgress: true });
}
