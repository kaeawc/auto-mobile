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
import { auditForegroundRefusal } from "./AuditForegroundRefusal";
import { observeForegroundApp, type ForegroundAppReader } from "./IosForegroundApp";
import { logger } from "../../utils/logger";
import { errorMessage } from "../../utils/describeUnknownError";

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
  "Use the host-side WCAG checks instead: accessibilityAudit with engine wcag, the Android default.";

const OUTDATED_RUNNER_ERROR =
  "accessibilityAudit on iOS needs an AutoMobile iOS runner that supports " +
  "request_accessibility_audit; restart the daemon so it installs the current runner";

/**
 * XCUITest's errors for an app it cannot audit: `Invalid target app <pid>` for a background app,
 * `Invalid XCUIApplication` for one that is not running (#17303).
 */
const RUNNER_TARGET_ERROR = /Invalid target app|Invalid XCUIApplication/;

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
    private readonly foregroundApp: ForegroundAppReader = observeForegroundApp,
  ) {}

  async run(
    device: BootedDevice,
    input: NativeAccessibilityAuditInput = {},
  ): Promise<NativeAccessibilityAuditResult> {
    const checks = resolveAuditChecks(input.checks);
    if (device.platform !== "ios") {
      return unsupported("atf", checks, "unsupported_platform", ANDROID_UNSUPPORTED_ERROR);
    }
    const { appId, signal } = input;
    const mismatch = appId ? await this.foregroundMismatch(device, appId, signal) : undefined;
    if (mismatch) {
      return failed(mismatch);
    }
    const result = await this.senderFactory(device).requestAccessibilityAudit({
      ...(appId ? { appId } : {}),
      checks,
      ...(signal ? { signal } : {}),
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
    return toAuditResult(result, input);
  }

  /**
   * The refusal when `appId` is not the app on screen, as the wcag engine returns (#17303). An
   * unknown foreground is not a mismatch; the runner's own error is mapped instead.
   */
  private async foregroundMismatch(
    device: BootedDevice,
    appId: string,
    signal: AbortSignal | undefined,
  ): Promise<string | undefined> {
    let foreground: string | undefined;
    try {
      foreground = await this.foregroundApp(device, signal);
    } catch (error) {
      signal?.throwIfAborted();
      // Best effort: the runner still audits, and its target error is mapped to the refusal.
      logger.warn(`accessibilityAudit foreground read failed: ${errorMessage(error)}`, error);
      return undefined;
    }
    return foreground === undefined || foreground === appId
      ? undefined
      : auditForegroundRefusal(appId, foreground);
  }
}

function toAuditResult(
  result: CtrlProxyAccessibilityAuditResult,
  { appId, maxIssues = MAX_ACCESSIBILITY_VIOLATIONS }: NativeAccessibilityAuditInput,
): NativeAccessibilityAuditResult {
  const error = result.success ? undefined : result.error;
  if (appId && error && RUNNER_TARGET_ERROR.test(error)) {
    // The app left the foreground after the check, or the foreground was unknown.
    return failed(auditForegroundRefusal(appId));
  }
  const all = result.issues ?? [];
  return {
    success: result.success,
    engine: "xcuitest",
    issues: all.slice(0, maxIssues),
    totalIssues: all.length,
    truncated: all.length > maxIssues,
    unsupportedChecks: result.unsupportedChecks ?? [],
    ...(error ? { error } : {}),
  };
}

function failed(error: string): NativeAccessibilityAuditResult {
  return {
    success: false,
    engine: "xcuitest",
    issues: [],
    totalIssues: 0,
    truncated: false,
    unsupportedChecks: [],
    error,
  };
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
