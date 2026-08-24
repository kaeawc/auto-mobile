/**
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { DoctorReport, DoctorOptions, DoctorSummary, CheckResult } from "./types";
import { runSystemChecks } from "./checks/system";
import { runAndroidChecks } from "./checks/android";
import { runIosChecks } from "./checks/ios";
import { runAutoMobileChecks, checkDaemonBuildIdentity } from "./checks/automobile";
import { resolveAssetVersion, resolvePinnedVersion } from "../constants/release";

/**
 * Calculate summary statistics from check results
 */
function calculateSummary(allChecks: CheckResult[]): DoctorSummary {
  const summary: DoctorSummary = {
    total: allChecks.length,
    passed: 0,
    warnings: 0,
    failed: 0,
    skipped: 0,
  };

  for (const check of allChecks) {
    switch (check.status) {
      case "pass":
        summary.passed++;
        break;
      case "warn":
        summary.warnings++;
        break;
      case "fail":
        summary.failed++;
        break;
      case "skip":
        summary.skipped++;
        break;
    }
  }

  return summary;
}

/**
 * Collect all recommendations from failed/warning checks
 */
function collectRecommendations(allChecks: CheckResult[]): string[] {
  const recommendations: string[] = [];

  for (const check of allChecks) {
    if ((check.status === "fail" || check.status === "warn") && check.recommendation) {
      recommendations.push(`${check.name}: ${check.recommendation}`);
    }
  }

  return recommendations;
}

/**
 * Injectable check-runner seams for {@link runDoctor}. Unit tests supply fakes so
 * the orchestration (which sections run, summary math, version resolution) is
 * exercised without real ADB / socket / iOS I/O. Defaults call the real runners.
 */
export interface RunDoctorDependencies {
  runSystemChecks?: () => CheckResult[];
  runAndroidChecks?: (options: DoctorOptions) => Promise<CheckResult[]>;
  runIosChecks?: (options: DoctorOptions) => Promise<CheckResult[]>;
  runAutoMobileChecks?: (options: DoctorOptions) => Promise<CheckResult[]>;
}

interface ResolvedDoctorRunners {
  system: () => CheckResult[];
  android: (options: DoctorOptions) => Promise<CheckResult[]>;
  ios: (options: DoctorOptions) => Promise<CheckResult[]>;
  autoMobile: (options: DoctorOptions) => Promise<CheckResult[]>;
}

/**
 * Resolve each injectable check-runner seam to its live default. Extracted from
 * {@link runDoctor} so the `??` fallbacks live here rather than inflating the
 * orchestrator's cyclomatic complexity past the ratchet.
 */
function resolveDoctorRunners(dependencies: RunDoctorDependencies): ResolvedDoctorRunners {
  return {
    system: dependencies.runSystemChecks ?? runSystemChecks,
    android: dependencies.runAndroidChecks ?? runAndroidChecks,
    ios: dependencies.runIosChecks ?? runIosChecks,
    autoMobile: dependencies.runAutoMobileChecks ?? runAutoMobileChecks,
  };
}

/**
 * Run the doctor diagnostic tool
 */
export async function runDoctor(
  options: DoctorOptions = {},
  dependencies: RunDoctorDependencies = {},
): Promise<DoctorReport> {
  const allChecks: CheckResult[] = [];

  // Resolve injectable seams to their live defaults once (keeps the `??`
  // fallbacks out of this function's complexity budget).
  const runners = resolveDoctorRunners(dependencies);

  // Always run system checks
  const systemChecks = runners.system();
  allChecks.push(...systemChecks);

  // Determine which platform checks to run
  const runAndroid =
    options.android === true || (options.android !== false && options.ios !== true);
  const runIos =
    options.ios === true ||
    (options.ios !== true && options.android !== true && process.platform === "darwin");

  // Run Android checks if applicable
  let androidChecks: CheckResult[] | undefined;
  if (runAndroid) {
    androidChecks = await runners.android(options);
    allChecks.push(...androidChecks);
  }

  // Run iOS checks if applicable
  let iosChecks: CheckResult[] | undefined;
  if (runIos) {
    iosChecks = await runners.ios(options);
    allChecks.push(...iosChecks);
  }

  // Always run AutoMobile checks
  const autoMobileChecks = await runners.autoMobile(options);
  allChecks.push(...autoMobileChecks);

  // Calculate summary and recommendations
  const summary = calculateSummary(allChecks);
  const recommendations = collectRecommendations(allChecks);

  const report: DoctorReport = {
    timestamp: new Date().toISOString(),
    // Concrete pinned version (honors AUTOMOBILE_VERSION), never the "latest" literal (#2746).
    version: resolveAssetVersion(resolvePinnedVersion()),
    platform: process.platform,
    arch: process.arch,
    system: { checks: systemChecks },
    autoMobile: { checks: autoMobileChecks },
    summary,
    recommendations,
  };

  // Add platform-specific sections if they were run
  if (androidChecks) {
    report.android = { checks: androidChecks };
  }
  if (iosChecks) {
    report.ios = { checks: iosChecks };
  }

  return report;
}

/**
 * Collect every check across all sections of a report (for recomputing totals).
 */
function collectAllChecks(report: DoctorReport): CheckResult[] {
  return [
    ...report.system.checks,
    ...(report.android?.checks ?? []),
    ...(report.ios?.checks ?? []),
    ...report.autoMobile.checks,
  ];
}

/**
 * Recompute a daemon-served report's "Daemon Build Identity" check from the
 * **client** side and splice the authoritative result back in.
 *
 * `auto-mobile --cli doctor` runs {@link runDoctor} inside the *daemon* process
 * (the CLI tries the daemon first), so the build-identity check there compares
 * the daemon to *itself* via `getCurrentBuildIdentity()` and can never see a
 * wrong-build skew — defeating the check in its primary flow (#2736). The
 * invoking process is the only one that knows the real client build, so the CLI
 * re-runs the check here (its own `getCurrentBuildIdentity()` vs the daemon's
 * PID-file identity) and replaces the daemon's self-comparison, recomputing the
 * summary/recommendations so a newly-detected skew is actually counted.
 *
 * No-op when the report has no AutoMobile section (e.g. an MCP parse fallback).
 *
 * @param runCheck injectable client-side check (defaults to {@link checkDaemonBuildIdentity})
 */
export async function applyClientBuildIdentity(
  report: DoctorReport,
  runCheck: () => Promise<CheckResult> = () => checkDaemonBuildIdentity(),
): Promise<DoctorReport> {
  if (!report?.autoMobile?.checks) {
    return report;
  }

  const clientCheck = await runCheck();
  const checks = report.autoMobile.checks;
  const idx = checks.findIndex((check) => check.name === clientCheck.name);
  if (idx >= 0) {
    checks[idx] = clientCheck;
  } else {
    checks.push(clientCheck);
  }

  const allChecks = collectAllChecks(report);
  report.summary = calculateSummary(allChecks);
  report.recommendations = collectRecommendations(allChecks);
  return report;
}

// Re-export types and formatter for convenience
export { formatConsoleOutput, formatJsonOutput } from "./formatter";
export * from "./types";
