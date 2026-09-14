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
  recommendation?: string;
}

/**
 * Section containing multiple checks
 */
export interface CheckSection {
  checks: CheckResult[];
}

/**
 * Summary statistics for the doctor report
 */
export interface DoctorSummary {
  total: number;
  passed: number;
  warnings: number;
  failed: number;
  skipped: number;
}

/**
 * Complete doctor diagnostic report
 */
export interface DoctorReport {
  timestamp: string;
  version: string;
  platform: string;
  arch: string;
  system: CheckSection;
  android?: CheckSection;
  ios?: CheckSection;
  autoMobile: CheckSection;
  summary: DoctorSummary;
  recommendations: string[];
}

/**
 * Cancellation seam for a single probe (#7008). A caller that races a check
 * against its own deadline (the host/toolchain resource) hands the check a
 * signal to abort and a deadline for the commands it spawns, so the losing
 * probe's child processes are killed instead of accumulating across reads.
 * Callers that pass nothing get the historical unbounded behaviour.
 */
export interface DoctorProbeOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * Options for running the doctor diagnostic
 */
export interface DoctorOptions {
  /** Run Android-specific checks only */
  android?: boolean;
  /** Run iOS-specific checks only */
  ios?: boolean;
  /** Output in JSON format */
  json?: boolean;
}
