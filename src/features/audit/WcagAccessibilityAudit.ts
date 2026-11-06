import type { BootedDevice } from "../../models";
import type { AccessibilityAuditResult, WcagViolation } from "../../models/AccessibilityAudit";
import {
  OnDemandAudit,
  type AuditContainer,
  type AuditFailOn,
  type OnDemandAuditEngines,
  type OnDemandAuditResult,
} from "./OnDemandAudit";

/**
 * The host-side WCAG checks (contrast, touch targets, labels, headings) as the `wcag` engine of
 * `accessibilityAudit` (#17279). It runs the accessibility kind of {@link OnDemandAudit}, so its
 * findings, scoping, baselines and `failOn` are the ones `audit` reports, flattened to the
 * accessibilityAudit result shape.
 */

export interface WcagAccessibilityAuditInput {
  appId?: string;
  container?: AuditContainer;
  baseline?: { name: string; mode: "compare" | "record" };
  failOn?: AuditFailOn;
}

export interface WcagAccessibilityAuditResult {
  success: boolean;
  /** Set by `failOn`: the reported findings reach the requested severity. */
  failed: boolean;
  engine: "wcag";
  appId?: string;
  violations?: WcagViolation[];
  totalViolations?: number;
  truncated?: boolean;
  summary?: AccessibilityAuditResult["summary"];
  screenId?: string;
  baselineDiff?: OnDemandAuditResult["baselineDiff"];
  baselineRecorded?: string;
  errorCode?: "unsupported_platform";
  error?: string;
}

export const WCAG_ENGINE_UNSUPPORTED_ERROR =
  "The wcag engine runs on Android only; on iOS use engine platform (XCUITest).";

export function toWcagAccessibilityAuditResult(
  result: OnDemandAuditResult,
): WcagAccessibilityAuditResult {
  if (result.unsupported?.accessibility) {
    return {
      success: false,
      failed: false,
      engine: "wcag",
      errorCode: "unsupported_platform",
      error: WCAG_ENGINE_UNSUPPORTED_ERROR,
    };
  }
  const { success, failed, appId, accessibility, baselineDiff, baselineRecorded, error } = result;
  return {
    success,
    failed,
    engine: "wcag",
    ...(appId ? { appId } : {}),
    ...(accessibility ?? {}),
    ...(baselineDiff ? { baselineDiff } : {}),
    ...(baselineRecorded ? { baselineRecorded } : {}),
    ...(error ? { error } : {}),
  };
}

export async function runWcagAccessibilityAudit(
  device: BootedDevice,
  engines: OnDemandAuditEngines,
  input: WcagAccessibilityAuditInput,
): Promise<WcagAccessibilityAuditResult> {
  const result = await new OnDemandAudit(device, engines).run({
    ...input,
    kinds: ["accessibility"],
  });
  return toWcagAccessibilityAuditResult(result);
}
