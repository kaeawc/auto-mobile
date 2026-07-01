import { BaseActionResult } from "./BaseActionResult";

/**
 * Result of a biometric authentication action
 */
export interface BiometricAuthResult extends BaseActionResult {
  action: "match" | "fail" | "cancel" | "error";
  modality: "any" | "fingerprint" | "face";
  fingerprintId?: number;
  errorCode?: number;
  supported: boolean | "partial";
  message?: string;
}
