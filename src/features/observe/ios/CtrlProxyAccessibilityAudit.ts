/**
 * CtrlProxy iOS accessibility audit - runs XCUITest's own `performAccessibilityAudit`
 * on the foreground app through the runner's `request_accessibility_audit` command (#14086).
 */

import { sendCommand } from "../DeviceServiceUtils";
import type { BaseResult } from "../shared/types";
import type { DelegateContext, RunnerAccessibilityAuditIssue } from "./types";

export type { RunnerAccessibilityAuditIssue } from "./types";

/** The `XCUIAccessibilityAuditType` checks, by the names the runner and tool use. */
export const IOS_ACCESSIBILITY_AUDIT_CHECKS = [
  "contrast",
  "hitRegion",
  "dynamicType",
  "textClipped",
  "sufficientDescription",
  "trait",
  "elementDetection",
] as const;

export type IosAccessibilityAuditCheck = (typeof IOS_ACCESSIBILITY_AUDIT_CHECKS)[number];

/** An audit walks the whole screen, so it gets far more time than a gesture. */
export const IOS_ACCESSIBILITY_AUDIT_TIMEOUT_MS = 60_000;

export interface IosAccessibilityAuditRequest {
  /** The app to audit; the runner's tracked foreground app when absent. */
  appId?: string;
  checks: readonly IosAccessibilityAuditCheck[];
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface CtrlProxyAccessibilityAuditResult extends BaseResult {
  issues?: RunnerAccessibilityAuditIssue[];
  /** Checks the runner could not run on this OS or Xcode. */
  unsupportedChecks?: string[];
  /** The connected runner predates `request_accessibility_audit`. */
  unsupported?: boolean;
}

export async function requestAccessibilityAudit(
  context: DelegateContext,
  request: IosAccessibilityAuditRequest,
): Promise<CtrlProxyAccessibilityAuditResult> {
  const failure = (
    error: string,
    extra: Partial<CtrlProxyAccessibilityAuditResult> = {},
  ): CtrlProxyAccessibilityAuditResult => ({ success: false, totalTimeMs: 0, error, ...extra });
  return sendCommand<CtrlProxyAccessibilityAuditResult>(context, {
    idPrefix: "accessibilityAudit",
    responseType: "accessibility_audit_result",
    messageType: "request_accessibility_audit",
    params: {
      ...(request.appId ? { appId: request.appId } : {}),
      checks: [...request.checks],
    },
    timeoutMs: request.timeoutMs ?? IOS_ACCESSIBILITY_AUDIT_TIMEOUT_MS,
    abortSignal: request.signal,
    cancelScreenshotBackoff: false,
    notConnectedError: () => failure("Not connected to CtrlProxy"),
    unsupportedCommandError: (_type, error) => failure(error, { unsupported: true }),
    // A runner-reported failure is not an outdated runner.
    responseError: (error, totalTimeMs) => failure(error, { totalTimeMs }),
    timeoutError: () => failure("Timeout waiting for accessibility_audit_result"),
  });
}
