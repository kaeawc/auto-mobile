import type { MemoryAuditResult } from "../../src/features/audit/OnDemandAudit";
import type { BootedDevice } from "../../src/models";
import type { WcagViolation } from "../../src/models/AccessibilityAudit";
import type { PerformanceAuditResult } from "../../src/models/PerformanceAuditResult";
import type { ToolRegistrar } from "../../src/server/defineTool";
import { FakeOnDemandAuditEngines } from "../fakes/FakeOnDemandAuditEngines";
import { deviceAwareHandler } from "./registeredHandler";

/**
 * Fixed audit scenarios (#17279): the output the removed `audit` tool returned for each is pinned,
 * and the accessibilityAudit (wcag engine) and performanceAudit tools must reproduce it.
 */

export const AUDIT_ANDROID: BootedDevice = {
  name: "Pixel",
  platform: "android",
  deviceId: "emulator-5554",
};
export const AUDIT_IOS: BootedDevice = { name: "iPhone", platform: "ios", deviceId: "sim-1" };

export type ToolResponse = { isError?: boolean; structuredContent?: Record<string, unknown> };
export type RegisteredHandler = (
  device: BootedDevice,
  args: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<ToolResponse>;

/** The device-aware handler a tool registers, called the way the registry calls it. */
export function registeredHandler(tool: { register(registrar: ToolRegistrar): void }) {
  let handler: ((...args: never[]) => Promise<unknown>) | undefined;
  const registrar = {
    register: () => {},
    registerDeviceAware: (_name, _description, _schema, registered) => {
      handler = deviceAwareHandler(registered);
    },
  } as ToolRegistrar;
  tool.register(registrar);
  const call: RegisteredHandler = (device, args, signal) =>
    Reflect.apply(handler!, undefined, [device, args, undefined, signal]) as Promise<ToolResponse>;
  return call;
}

export function auditViolation(
  fingerprint: string,
  severity: WcagViolation["severity"],
  top = 10,
): WcagViolation {
  return {
    type: "touch-target-too-small",
    severity,
    criterion: "2.5.5",
    message: fingerprint,
    element: {
      bounds: { left: 10, top, right: 50, bottom: top + 40 },
      "resource-id": `com.example:id/${fingerprint}`,
    },
    fingerprint,
  };
}

/** Engines with a recorded `home` baseline and violations inside and outside the card. */
export function accessibilityScenarioEngines(): FakeOnDemandAuditEngines {
  const engines = new FakeOnDemandAuditEngines();
  engines.savedBaselines.set("home", [
    auditViolation("old", "error"),
    auditViolation("gone", "error"),
  ]);
  engines.violations = [
    auditViolation("old", "error"),
    auditViolation("added", "warning"),
    auditViolation("outside", "error", 1000),
  ];
  return engines;
}

/** Engines whose performance audit fails and whose memory audit passes. */
export function performanceScenarioEngines(): FakeOnDemandAuditEngines {
  const engines = new FakeOnDemandAuditEngines();
  engines.performanceResult = {
    passed: false,
    metrics: { p50Ms: 10, jankCount: 9 },
    violations: [
      { metric: "jankCount", threshold: 5, actual: 9, severity: "critical", contributionWeight: 1 },
    ],
    diagnostics: "jank",
  } as PerformanceAuditResult;
  engines.memoryResult = { passed: true } as MemoryAuditResult;
  return engines;
}

const OLD = auditViolation("old", "error");
const ADDED = auditViolation("added", "warning");

/** Removed `audit` with scope card, baseline compare `home` and failOn warning, over the a11y scenario. */
export const PINNED_ACCESSIBILITY = {
  success: false,
  failed: true,
  appId: "com.example",
  accessibility: {
    violations: [OLD, ADDED],
    totalViolations: 2,
    truncated: false,
    summary: { totalViolations: 3, passed: true },
    screenId: "screen-1",
  },
  baselineDiff: { new: [ADDED], fixed: ["gone"], unchanged: 1 },
};

const PINNED_MEMORY = { passed: true };

/** Removed `audit` kinds performance+memory with failOn error, over the performance scenario. */
export const PINNED_PERFORMANCE = {
  success: false,
  failed: true,
  appId: "com.example",
  performance: {
    passed: false,
    metrics: { p50Ms: 10, jankCount: 9 },
    violations: [
      { metric: "jankCount", threshold: 5, actual: 9, severity: "critical", contributionWeight: 1 },
    ],
    diagnostics: "jank",
  },
  memory: PINNED_MEMORY,
};

/** Removed `audit` kinds performance+memory for a background appId, over the performance scenario. */
export const PINNED_BACKGROUND_PERFORMANCE = {
  success: true,
  failed: false,
  appId: "com.other",
  unsupported: {
    performance:
      "The performance audit measures the foreground app; com.other is not in the foreground.",
  },
  memory: PINNED_MEMORY,
};
