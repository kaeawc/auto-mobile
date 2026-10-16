import { z } from "zod/v4";

export const biometricEnrollmentSchema = z.enum(["enrolled", "not_enrolled"]);

export type BiometricEnrollment = z.infer<typeof biometricEnrollmentSchema>;

export interface BiometricEnrollmentState {
  supported: boolean;
  enrollment?: BiometricEnrollment;
  method?: "ios_simulator_notifyutil";
  verified?: boolean;
  error?: string;
}

export const IOS_BIOMETRIC_ENROLLMENT_NOTIFICATION = "com.apple.BiometricKit.enrollmentChanged";

export const IOS_BIOMETRICS_UNSUPPORTED_ERROR =
  "Biometric enrollment state can only be read or set on an iOS Simulator.";
