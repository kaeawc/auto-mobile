/**
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { release } from "node:os";
import { CheckResult } from "../types";

/**
 * Check operating system information
 */
export function checkOperatingSystem(): CheckResult {
  const platform = process.platform;
  const osRelease = release();

  return {
    name: "Operating System",
    status: "pass",
    message: `${platform} (${osRelease})`,
    value: platform,
  };
}

/**
 * Check system architecture
 */
export function checkArchitecture(): CheckResult {
  const arch = process.arch;

  return {
    name: "Architecture",
    status: "pass",
    message: arch,
    value: arch,
  };
}

/**
 * Detect the Bun version of the current runtime, or `undefined` under Node.js.
 * Injected into {@link checkRuntime} so the Node arm is testable — `globalThis.Bun`
 * is a non-configurable property and cannot be deleted or redefined in a test.
 */
export function detectBunVersion(): string | undefined {
  return (globalThis as { Bun?: { version?: string } }).Bun?.version;
}

/**
 * Check runtime environment (Node.js or Bun).
 *
 * @param detectVersion Injected runtime seam; defaults to the live detection.
 *   Return `undefined` to exercise the Node.js arm and a version string for the
 *   Bun arm. A function (not a value) is required because passing `undefined` to
 *   a defaulted value parameter would re-trigger the default.
 */
export function checkRuntime(
  detectVersion: () => string | undefined = detectBunVersion,
): CheckResult {
  const bunVersion = detectVersion();

  if (bunVersion) {
    return {
      name: "Runtime",
      status: "pass",
      message: `Bun ${bunVersion}`,
      value: `bun@${bunVersion}`,
    };
  }

  // Fallback to Node.js
  const nodeVersion = process.version;
  return {
    name: "Runtime",
    status: "pass",
    message: `Node.js ${nodeVersion}`,
    value: `node@${nodeVersion}`,
  };
}

/**
 * Run all system checks
 */
export function runSystemChecks(): CheckResult[] {
  return [checkOperatingSystem(), checkArchitecture(), checkRuntime()];
}
