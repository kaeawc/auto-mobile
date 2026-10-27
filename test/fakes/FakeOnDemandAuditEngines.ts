import type {
  AuditBaselineStore,
  MemoryAuditResult,
  OnDemandAuditEngines,
} from "../../src/features/audit/OnDemandAudit";
import type { ObserveResult } from "../../src/models";
import type {
  AccessibilityAuditConfig,
  AccessibilityAuditResult,
  WcagViolation,
} from "../../src/models/AccessibilityAudit";
import type { Element } from "../../src/models";
import type { PerformanceAuditResult } from "../../src/models/PerformanceAuditResult";

/** A container element for scoping tests: the top 600px of the screen. */
export const FAKE_AUDIT_CARD: Element = {
  bounds: { left: 0, top: 0, right: 1080, bottom: 600 },
  "resource-id": "com.example:id/card",
};

export function observation(appId = "com.example"): ObserveResult {
  return {
    updatedAt: 1,
    observationId: "obs-1",
    screenSize: { width: 1080, height: 1920 },
    systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
    activeWindow: { appId, activityName: "Main", layoutSeqSum: 0 },
  } as ObserveResult;
}

export class FakeOnDemandAuditEngines implements OnDemandAuditEngines {
  violations: WcagViolation[] = [];
  observed = observation();
  flagConfig: AccessibilityAuditConfig | null = null;
  performanceResult: PerformanceAuditResult | undefined = undefined;
  memoryResult = { passed: true } as MemoryAuditResult;
  readonly savedBaselines = new Map<string, WcagViolation[]>();
  readonly baselines: AuditBaselineStore = {
    getBaseline: async (name) => {
      const violations = this.savedBaselines.get(name);
      return violations ? { violations } : null;
    },
    saveBaseline: async (name, violations) => {
      this.savedBaselines.set(name, violations);
    },
  };
  readonly calls: string[] = [];
  readonly configs: AccessibilityAuditConfig[] = [];

  async observe() {
    this.calls.push("observe");
    return { result: this.observed, screenshotPath: "/tmp/shot.png" };
  }
  async accessibility(
    _result: ObserveResult,
    screenshotPath: string | undefined,
    appId: string,
    config: AccessibilityAuditConfig,
  ): Promise<AccessibilityAuditResult> {
    this.calls.push(`accessibility:${appId}:${screenshotPath}`);
    this.configs.push(config);
    return {
      config,
      violations: this.violations,
      summary: { totalViolations: this.violations.length, passed: true },
      screenId: "screen-1",
    } as AccessibilityAuditResult;
  }
  async performance() {
    this.calls.push("performance");
    return this.performanceResult;
  }
  async memory(appId: string) {
    this.calls.push(`memory:${appId}`);
    return this.memoryResult;
  }
  elements() {
    return [FAKE_AUDIT_CARD];
  }
  accessibilityConfig() {
    return this.flagConfig;
  }
}
