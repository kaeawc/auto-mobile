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
  /**
   * Present for deliberately restricted diagnostic runs. Ordinary doctor runs
   * leave this absent so their existing behavior and report shape are unchanged.
   */
  diagnosticProfile?: DoctorDiagnosticProfile;
  system: CheckSection;
  android?: CheckSection;
  ios?: CheckSection;
  autoMobile: CheckSection;
  summary: DoctorSummary;
  recommendations: string[];
}

/**
 * Cancellation seam for a single probe (#7008). A caller that races a check
 * against its own deadline hands the check one signal and one absolute deadline
 * for every subprocess, network read, and device probe it starts. Callers that
 * pass nothing get the historical unbounded behaviour.
 */
export interface DoctorProbeOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Absolute deadline on {@link timer}'s clock; internal orchestration only. */
  deadlineMs?: number;
  /** Injectable clock for the shared deadline; omitted by CLI/MCP callers. */
  timer?: import("../utils/SystemTimer").Timer;
}

/**
 * A deliberately restricted diagnostic profile used after repairing shared
 * daemon control state. It is host/toolchain and daemon-health focused; it
 * never picks an arbitrary booted device for CtrlProxy setup or validation.
 */
export type DoctorDiagnosticProfile = "post-repair-read-only";

/**
 * Options for running the doctor diagnostic
 */
export interface DoctorOptions extends DoctorProbeOptions {
  /** Run Android-specific checks only */
  android?: boolean;
  /** Run iOS-specific checks only */
  ios?: boolean;
  /** Restrict device-specific checks to one selected device */
  deviceId?: string;
  /** Output in JSON format */
  json?: boolean;
  /**
   * Internal recovery-only profile. Ordinary CLI/MCP doctor invocations must
   * not select this profile.
   */
  diagnosticProfile?: DoctorDiagnosticProfile;
}
