import type { BootedDevice } from "../../models";
import { iosCtrlProxyClientFor } from "../observe/ios/iosCtrlProxyClientFor";
import {
  IOS_ACCESSIBILITY_AUDIT_CHECKS,
  type CtrlProxyAccessibilityAuditResult,
  type IosAccessibilityAuditCheck,
  type IosAccessibilityAuditRequest,
  type RunnerAccessibilityAuditIssue,
} from "../observe/ios/CtrlProxyAccessibilityAudit";
import { MAX_ACCESSIBILITY_VIOLATIONS } from "./WcagAudit";

/**
 * Runs the platform's own accessibility audit engine (#14086): XCUITest's
 * `performAccessibilityAudit` on iOS. Unlike the host-side WCAG audit (`WcagAudit`), the
 * platform engine sees real hit regions, Dynamic Type support, clipped text and traits.
 * Android's Accessibility Test Framework is a later phase; Android reports unsupported.
 */

export type AccessibilityAuditCheckInput = IosAccessibilityAuditCheck | "all";

export interface NativeAccessibilityAuditInput {
  appId?: string;
  checks?: readonly AccessibilityAuditCheckInput[];
  /** Bound on returned issues; defaults to the WCAG audit's bound. */
  maxIssues?: number;
  signal?: AbortSignal;
}

export type NativeAccessibilityAuditIssue = RunnerAccessibilityAuditIssue;

export interface NativeAccessibilityAuditResult {
  success: boolean;
  engine: "xcuitest" | "atf";
  issues: NativeAccessibilityAuditIssue[];
  /** Issues the engine reported, before `maxIssues` clipped them. */
  totalIssues: number;
  truncated: boolean;
  /** Requested checks this target could not run. */
  unsupportedChecks: string[];
  /** Set when the audit could not run at all on this target or runner. */
  errorCode?: "unsupported_capability" | "unsupported_platform";
  error?: string;
}

/** The narrow runner seam the audit needs. */
export interface IosAccessibilityAuditSender {
  requestAccessibilityAudit(
    request: IosAccessibilityAuditRequest,
  ): Promise<CtrlProxyAccessibilityAuditResult>;
}

export type IosAccessibilityAuditSenderFactory = (
  device: BootedDevice,
) => IosAccessibilityAuditSender;

const defaultSenderFactory: IosAccessibilityAuditSenderFactory = iosCtrlProxyClientFor;

const ANDROID_UNSUPPORTED_ERROR =
  "The native Android accessibility audit (Accessibility Test Framework) is not available yet. " +
  "Use the host-side WCAG audit instead: enable the accessibility-audit feature flag and observe.";

const OUTDATED_RUNNER_ERROR =
  "accessibilityAudit on iOS needs an AutoMobile iOS runner that supports " +
  "request_accessibility_audit; restart the daemon so it installs the current runner";

/** The concrete checks a request names; `all`, or no checks, means every check. */
export function resolveAuditChecks(
  checks: readonly AccessibilityAuditCheckInput[] | undefined,
): IosAccessibilityAuditCheck[] {
  if (!checks || checks.length === 0 || checks.includes("all")) {
    return [...IOS_ACCESSIBILITY_AUDIT_CHECKS];
  }
  return IOS_ACCESSIBILITY_AUDIT_CHECKS.filter((check) => checks.includes(check));
}

export class NativeAccessibilityAudit {
  constructor(
    private readonly senderFactory: IosAccessibilityAuditSenderFactory = defaultSenderFactory,
  ) {}

  async run(
    device: BootedDevice,
    input: NativeAccessibilityAuditInput = {},
  ): Promise<NativeAccessibilityAuditResult> {
    const checks = resolveAuditChecks(input.checks);
    if (device.platform !== "ios") {
      return unsupported("atf", checks, "unsupported_platform", ANDROID_UNSUPPORTED_ERROR);
    }
    const result = await this.senderFactory(device).requestAccessibilityAudit({
      ...(input.appId ? { appId: input.appId } : {}),
      checks,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (result.unsupported) {
      const detail = result.error ? ` (${result.error})` : "";
      return unsupported(
        "xcuitest",
        checks,
        "unsupported_capability",
        `${OUTDATED_RUNNER_ERROR}${detail}.`,
      );
    }
    const all = result.issues ?? [];
    const maxIssues = input.maxIssues ?? MAX_ACCESSIBILITY_VIOLATIONS;
    return {
      success: result.success,
      engine: "xcuitest",
      issues: all.slice(0, maxIssues),
      totalIssues: all.length,
      truncated: all.length > maxIssues,
      unsupportedChecks: result.unsupportedChecks ?? [],
      ...(result.success || !result.error ? {} : { error: result.error }),
    };
  }
}

function unsupported(
  engine: NativeAccessibilityAuditResult["engine"],
  checks: readonly string[],
  errorCode: NonNullable<NativeAccessibilityAuditResult["errorCode"]>,
  error: string,
): NativeAccessibilityAuditResult {
  return {
    success: false,
    engine,
    issues: [],
    totalIssues: 0,
    truncated: false,
    unsupportedChecks: [...checks],
    errorCode,
    error,
  };
}
