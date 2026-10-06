import { logger } from "../../../utils/logger";
import { serverConfig } from "../../../utils/ServerConfig";
import { pathExists } from "../../../utils/filesystem/DefaultFileSystem";
import { WcagAudit, capAccessibilityViolations } from "../../accessibility/WcagAudit";
import { projectAuditElements } from "../../accessibility/AuditElementProjection";
import type { ContrastChecker } from "../../accessibility/ContrastChecker";
import type { BootedDevice, ObserveResult } from "../../../models";
import type { PerformanceTracker } from "../../../utils/PerformanceTracker";
import type { AccessibilityAuditConfig } from "../../../models/AccessibilityAudit";

export interface AccessibilityAuditorOptions {
  device: BootedDevice;
  /**
   * Resolves the screenshot captured for exactly this observation. Returning
   * undefined skips the contrast check; it must never name another capture.
   */
  screenshotPathResolver?: (observationId: string) => Promise<string | undefined>;
  /** Allow tests to stub the config gate */
  getConfig?: () => AccessibilityAuditConfig | null;
  /** Allow tests to read screenshot pixels through an injected image backend */
  contrastChecker?: ContrastChecker;
}

/**
 * Confirms the screenshot recorded for THIS observation is still on disk.
 *
 * The contrast check may only sample pixels captured for the observation being
 * audited. There is deliberately no device-wide "latest screenshot" or
 * temp-directory scan fallback: with `screenshot: "none"`, or a failed,
 * cancelled or superseded capture, such a fallback hands back an earlier
 * screen's image and reports contrast findings for the wrong screen (#10037).
 * Callers pass the per-observation path (`getPathForObservation`), or nothing.
 */
export async function resolveObservationScreenshotPath(
  observationPath: string | null | undefined,
): Promise<string | undefined> {
  if (!observationPath) {
    return undefined;
  }
  try {
    return (await pathExists(observationPath)) ? observationPath : undefined;
  } catch (error) {
    logger.warn(`[AccessibilityAudit] Failed to check observation screenshot: ${error}`);
    return undefined;
  }
}

/**
 * Runs the WCAG accessibility audit and attaches the result to an ObserveResult.
 *
 * Audit failures are logged but never propagate as errors on the result.
 */
export class AccessibilityAuditor {
  private readonly device: BootedDevice;
  private readonly screenshotPathResolver: (observationId: string) => Promise<string | undefined>;
  private readonly getConfig: () => AccessibilityAuditConfig | null;
  private readonly contrastChecker: ContrastChecker | undefined;

  constructor(opts: AccessibilityAuditorOptions) {
    this.device = opts.device;
    this.contrastChecker = opts.contrastChecker;
    this.screenshotPathResolver = opts.screenshotPathResolver ?? (() => Promise.resolve(undefined));
    this.getConfig = opts.getConfig ?? (() => serverConfig.getAccessibilityAuditConfig());
  }

  async run(result: ObserveResult, perf: PerformanceTracker): Promise<void> {
    // Check if accessibility audit is enabled via CLI flag
    const auditConfig = this.getConfig();

    if (!auditConfig) {
      return;
    }

    // Only run on Android for now
    if (this.device.platform !== "android") {
      logger.debug("[AccessibilityAudit] Skipping audit, only Android is supported");
      return;
    }

    // Need view hierarchy
    if (!result.viewHierarchy?.hierarchy) {
      logger.debug("[AccessibilityAudit] Skipping audit, no view hierarchy available");
      return;
    }

    // Need active window for screen ID
    if (!result.activeWindow?.appId) {
      logger.debug("[AccessibilityAudit] Skipping audit, no active app");
      return;
    }

    try {
      await perf.track("accessibilityAudit", async () => {
        logger.info(
          `[AccessibilityAudit] Running WCAG ${auditConfig.level} audit for ${result.activeWindow?.appId}`,
        );

        // Initialize audit
        const wcagAudit = new WcagAudit(undefined, undefined, this.contrastChecker);

        // Extract elements directly from view hierarchy for audit, noting which
        // clickable containers are labelled by merged descendant text.
        const {
          elements: allElements,
          descendantLabelled,
          windowIds,
        } = projectAuditElements(result.viewHierarchy!);

        // Only this observation's own capture may feed the contrast check
        const screenshotPath = await this.screenshotPathResolver(result.observationId);

        // Run the audit
        const auditResult = await wcagAudit.audit(
          allElements,
          result.viewHierarchy!.hierarchy,
          screenshotPath,
          result.activeWindow!.appId,
          auditConfig,
          {
            density: result.viewHierarchy!.density,
            windows: result.viewHierarchy!.windows,
            descendantLabelled,
            elementWindowIds: windowIds,
          },
        );

        // Attach audit result to observe result, bounded for output
        result.accessibilityAudit = capAccessibilityViolations(auditResult);

        if (!auditResult.summary.passed) {
          logger.warn(
            `[AccessibilityAudit] Accessibility audit FAILED with ${auditResult.violations.length} violations (${auditResult.summary.bySeverity.error} errors, ${auditResult.summary.bySeverity.warning} warnings)`,
          );
        } else {
          logger.info("[AccessibilityAudit] Accessibility audit PASSED");
        }
      });
    } catch (error) {
      logger.error(`[AccessibilityAudit] Failed to run accessibility audit: ${error}`);
      // Don't fail the entire observation if audit fails
    }
  }
}
