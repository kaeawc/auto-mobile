/**
 * On-demand audits (#14075): run the accessibility, performance and memory audit engines on the
 * current screen when asked, instead of only as a side effect of `observe` behind process-level
 * feature flags. The engines are reused as they are; this never changes feature-flag state.
 */

import type { BootedDevice, Element, ObserveResult } from "../../models";
import type {
  AccessibilityAuditConfig,
  AccessibilityAuditResult,
  WcagViolation,
} from "../../models/AccessibilityAudit";
import type { PerformanceAuditResult } from "../../models/PerformanceAuditResult";
import type { MemoryAudit } from "../memory/MemoryAudit";
import { MAX_ACCESSIBILITY_VIOLATIONS } from "../accessibility/WcagAudit";
import { matchesCtrlProxyResourceId } from "../utility/SearchableNode";

export const AUDIT_KINDS = ["accessibility", "performance", "memory"] as const;
export type AuditKind = (typeof AUDIT_KINDS)[number];

export const AUDIT_FAIL_ON = ["error", "warning", "never"] as const;
export type AuditFailOn = (typeof AUDIT_FAIL_ON)[number];

export type MemoryAuditResult = Awaited<ReturnType<MemoryAudit["runAudit"]>>;

/** Limits the accessibility audit to the subtree of one element. */
export interface AuditContainer {
  /** Resource id (full or the part after `:id/`). */
  elementId?: string;
  text?: string;
}

export interface OnDemandAuditInput {
  kinds?: readonly AuditKind[];
  /** The app to audit; the observed foreground app when absent. */
  appId?: string;
  container?: AuditContainer;
  baseline?: { name: string; mode: "compare" | "record" };
  failOn?: AuditFailOn;
}

export interface AuditBaselineStore {
  getBaseline(name: string): Promise<{ violations: Pick<WcagViolation, "fingerprint">[] } | null>;
  saveBaseline(name: string, violations: WcagViolation[]): Promise<void>;
}

export interface OnDemandAuditEngines {
  /** A fresh observation of the device, with this observation's screenshot when one was taken. */
  observe(): Promise<{ result: ObserveResult; screenshotPath?: string }>;
  /** The WCAG audit over a projection of the observation. */
  accessibility(
    result: ObserveResult,
    screenshotPath: string | undefined,
    appId: string,
    config: AccessibilityAuditConfig,
  ): Promise<AccessibilityAuditResult>;
  /** The UI performance audit of the observed foreground app. */
  performance(result: ObserveResult): Promise<PerformanceAuditResult | undefined>;
  /** A memory snapshot of the app. */
  memory(appId: string): Promise<MemoryAuditResult>;
  /** The audit elements of the observation, for container scoping. */
  elements(result: ObserveResult): Element[];
  baselines: AuditBaselineStore;
  /** The process's accessibility audit config, or null when the feature flag is off. */
  accessibilityConfig(): AccessibilityAuditConfig | null;
}

export interface OnDemandAuditResult {
  success: boolean;
  /** Set by `failOn`: the reported findings reach the requested severity. */
  failed: boolean;
  appId?: string;
  accessibility?: {
    violations: WcagViolation[];
    totalViolations: number;
    truncated: boolean;
    summary: AccessibilityAuditResult["summary"];
    screenId: string;
  };
  performance?: Pick<PerformanceAuditResult, "passed" | "metrics" | "violations" | "diagnostics">;
  memory?: MemoryAuditResult;
  baselineDiff?: { new: WcagViolation[]; fixed: string[]; unchanged: number };
  baselineRecorded?: string;
  /** Kinds this target could not run, and why. */
  unsupported?: Partial<Record<AuditKind, string>>;
  error?: string;
}

/** WCAG AA, reporting only; named baselines are applied here, not by the engine. */
export const DEFAULT_ON_DEMAND_ACCESSIBILITY_CONFIG: AccessibilityAuditConfig = {
  level: "AA",
  failureMode: "report",
  useBaseline: false,
};

const ANDROID_ONLY: Record<AuditKind, string> = {
  accessibility:
    "The WCAG audit runs on Android only; on iOS use accessibilityAudit (XCUITest) instead.",
  performance: "The performance audit runs on Android only.",
  memory: "The memory audit runs on Android only.",
};

function within(inner: Element["bounds"], outer: Element["bounds"]): boolean {
  return (
    inner.left >= outer.left &&
    inner.top >= outer.top &&
    inner.right <= outer.right &&
    inner.bottom <= outer.bottom
  );
}

/** The first element matching the container selector, or undefined. */
export function findAuditContainer(
  elements: readonly Element[],
  container: AuditContainer,
): Element | undefined {
  return elements.find(
    (element) =>
      (container.elementId !== undefined &&
        matchesCtrlProxyResourceId(element["resource-id"], container.elementId)) ||
      (container.text !== undefined &&
        (element.text === container.text || element["content-desc"] === container.text)),
  );
}

const SEVERITY_FAILS: Record<AuditFailOn, ReadonlySet<WcagViolation["severity"]>> = {
  error: new Set(["error"]),
  warning: new Set(["error", "warning"]),
  never: new Set(),
};

export class OnDemandAudit {
  constructor(
    private readonly device: BootedDevice,
    private readonly engines: OnDemandAuditEngines,
  ) {}

  async run(input: OnDemandAuditInput = {}): Promise<OnDemandAuditResult> {
    const kinds = new Set<AuditKind>(input.kinds?.length ? input.kinds : ["accessibility"]);
    if (this.device.platform !== "android") {
      return {
        success: false,
        failed: false,
        unsupported: Object.fromEntries([...kinds].map((kind) => [kind, ANDROID_ONLY[kind]])),
        error: "On-demand audits run on Android only.",
      };
    }
    const { result: observation, screenshotPath } = await this.engines.observe();
    const appId = input.appId ?? observation.activeWindow?.appId;
    if (!appId) {
      return {
        success: false,
        failed: false,
        error: "No foreground app to audit; launch the app or pass appId.",
      };
    }
    const output: OnDemandAuditResult = { success: true, failed: false, appId };
    const reported = kinds.has("accessibility")
      ? await this.runAccessibility(observation, screenshotPath, appId, { input, output })
      : [];
    if (reported === undefined) {
      return output;
    }
    await this.runDeviceAudits(kinds, observation, appId, output);
    output.failed = this.failed(reported, output, input.failOn ?? "never");
    output.success = output.error === undefined && !output.failed;
    return output;
  }

  private async runDeviceAudits(
    kinds: ReadonlySet<AuditKind>,
    observation: ObserveResult,
    appId: string,
    output: OnDemandAuditResult,
  ): Promise<void> {
    if (kinds.has("performance")) {
      await this.runPerformance(observation, appId, output);
    }
    if (kinds.has("memory")) {
      output.memory = await this.engines.memory(appId);
    }
  }

  /** Returns the violations that count toward `failOn`, or undefined when the audit failed. */
  private async runAccessibility(
    observation: ObserveResult,
    screenshotPath: string | undefined,
    appId: string,
    { input, output }: { input: OnDemandAuditInput; output: OnDemandAuditResult },
  ): Promise<WcagViolation[] | undefined> {
    const config = {
      ...(this.engines.accessibilityConfig() ?? DEFAULT_ON_DEMAND_ACCESSIBILITY_CONFIG),
      useBaseline: false,
    };
    const audit = await this.engines.accessibility(observation, screenshotPath, appId, config);
    let violations = audit.violations;
    if (input.container) {
      const container = findAuditContainer(this.engines.elements(observation), input.container);
      if (!container) {
        output.success = false;
        output.error = `Audit container not found: ${JSON.stringify(input.container)}`;
        return undefined;
      }
      violations = violations.filter((violation) =>
        within(violation.element.bounds, container.bounds),
      );
    }
    output.accessibility = {
      violations: violations.slice(0, MAX_ACCESSIBILITY_VIOLATIONS),
      totalViolations: violations.length,
      truncated: violations.length > MAX_ACCESSIBILITY_VIOLATIONS,
      summary: audit.summary,
      screenId: audit.screenId,
    };
    return this.applyBaseline(violations, input.baseline, output);
  }

  private async applyBaseline(
    violations: WcagViolation[],
    baseline: OnDemandAuditInput["baseline"],
    output: OnDemandAuditResult,
  ): Promise<WcagViolation[]> {
    if (!baseline) {
      return violations;
    }
    if (baseline.mode === "record") {
      await this.engines.baselines.saveBaseline(baseline.name, violations);
      output.baselineRecorded = baseline.name;
      return violations;
    }
    const stored = await this.engines.baselines.getBaseline(baseline.name);
    if (!stored) {
      output.error = `No accessibility baseline named '${baseline.name}'; record one first.`;
      return violations;
    }
    const known = new Set(stored.violations.map((violation) => violation.fingerprint));
    const current = new Set(violations.map((violation) => violation.fingerprint));
    const added = violations.filter((violation) => !known.has(violation.fingerprint));
    output.baselineDiff = {
      new: added,
      fixed: [...known].filter((fingerprint) => !current.has(fingerprint)),
      unchanged: violations.length - added.length,
    };
    // Compared against a baseline, only new violations count toward failOn.
    return added;
  }

  private async runPerformance(
    observation: ObserveResult,
    appId: string,
    output: OnDemandAuditResult,
  ): Promise<void> {
    if (observation.activeWindow?.appId !== appId) {
      output.unsupported = {
        ...output.unsupported,
        performance: `The performance audit measures the foreground app; ${appId} is not in the foreground.`,
      };
      return;
    }
    const result = await this.engines.performance(observation);
    if (result) {
      const { passed, metrics, violations, diagnostics } = result;
      output.performance = { passed, metrics, violations, diagnostics };
    }
  }

  private failed(
    reported: readonly WcagViolation[],
    output: OnDemandAuditResult,
    failOn: AuditFailOn,
  ): boolean {
    if (failOn === "never") {
      return false;
    }
    const failing = SEVERITY_FAILS[failOn];
    return (
      reported.some((violation) => failing.has(violation.severity)) ||
      output.performance?.passed === false ||
      output.memory?.passed === false
    );
  }
}
