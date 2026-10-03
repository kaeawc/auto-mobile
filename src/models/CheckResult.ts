/**
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Status of an individual diagnostic check
 */
export type CheckStatus = "pass" | "warn" | "fail" | "skip";

/**
 * Result of a single diagnostic check
 */
export interface CheckResult {
  name: string;
  status: CheckStatus;
  message: string;
  value?: string | number | boolean | null;
  /** Additional context displayed below the check in console output. */
  detail?: string;
  recommendation?: string;
}
