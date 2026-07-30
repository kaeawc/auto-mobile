import { logger } from "../../../utils/logger";
import { serverConfig } from "../../../utils/ServerConfig";
import { pathExists } from "../../../utils/filesystem/DefaultFileSystem";
import { statAsync } from "../../../utils/io";
import { getTempDir, TEMP_SUBDIRS } from "../../../utils/tempDir";
import { ScreenshotCache } from "../../../utils/screenshot/ScreenshotCache";
import { WcagAudit } from "../../accessibility/WcagAudit";
import { DefaultElementParser } from "../../utility/ElementParser";
import type { BootedDevice, ObserveResult } from "../../../models";
import type { Element } from "../../../models/Element";
import type { PerformanceTracker } from "../../../utils/PerformanceTracker";
import type { AccessibilityAuditConfig } from "../../../models/AccessibilityAudit";

export interface AccessibilityAuditorOptions {
  device: BootedDevice;
  /** Resolves the latest screenshot path for visual checks */
  screenshotPathResolver?: () => Promise<string | undefined>;
  /** Allow tests to stub the config gate */
  getConfig?: () => AccessibilityAuditConfig | null;
}

/**
 * Fallback used when the per-device screenshot state has no cached path —
 * scans the screenshots tempdir for the most recent .png/.webp by mtime.
 */
export async function findLatestScreenshotPath(): Promise<string | undefined> {
  try {
    const cacheDir = getTempDir(TEMP_SUBDIRS.SCREENSHOTS);
    const imageFiles = await ScreenshotCache.getScreenshotFiles(cacheDir);
    if (imageFiles.length === 0) {
      return undefined;
    }

    const fileStats = await Promise.all(
      imageFiles.map(async fullPath => {
        const stat = await statAsync(fullPath);
        return { path: fullPath, mtime: stat.mtime };
      })
    );

    fileStats.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

    return fileStats[0]?.path;
  } catch (error) {
    logger.warn(`[AccessibilityAudit] Failed to get latest screenshot: ${error}`);
    return undefined;
  }
}

/**
 * Helper that mirrors RealObserveScreen.getLatestScreenshotPath: first checks
 * the per-device cached path (via the supplied accessor), then falls back to
 * scanning the screenshots tempdir.
 */
export async function resolveLatestScreenshotPath(
  getCachedPath?: () => string | null | undefined
): Promise<string | undefined> {
  try {
    const cachedPath = getCachedPath?.();
    if (cachedPath) {
      const exists = await pathExists(cachedPath);
      if (exists) {
        return cachedPath;
      }
    }
  } catch (error) {
    logger.warn(`[AccessibilityAudit] Failed to check cached screenshot: ${error}`);
  }
  return findLatestScreenshotPath();
}

/**
 * Runs the WCAG accessibility audit and attaches the result to an ObserveResult.
 *
 * Audit failures are logged but never propagate as errors on the result.
 */
export class AccessibilityAuditor {
  private readonly device: BootedDevice;
  private readonly screenshotPathResolver: () => Promise<string | undefined>;
  private readonly getConfig: () => AccessibilityAuditConfig | null;

  constructor(opts: AccessibilityAuditorOptions) {
    this.device = opts.device;
    this.screenshotPathResolver = opts.screenshotPathResolver ?? (() => resolveLatestScreenshotPath());
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
        logger.info(`[AccessibilityAudit] Running WCAG ${auditConfig.level} audit for ${result.activeWindow?.appId}`);

        // Initialize audit
        const wcagAudit = new WcagAudit();

        // Extract elements directly from view hierarchy for audit
        const elementParser = new DefaultElementParser();
        const allElements: Element[] = elementParser.flattenViewHierarchy(result.viewHierarchy!)
          .map(entry => entry.element);

        // Get screenshot path if available (from TakeScreenshot cache)
        const screenshotPath = await this.screenshotPathResolver();

        // Run the audit
        const auditResult = await wcagAudit.audit(
          allElements,
          result.viewHierarchy!.hierarchy,
          screenshotPath,
          result.activeWindow!.appId,
          auditConfig,
          result.viewHierarchy!.density
        );

        // Attach audit result to observe result
        result.accessibilityAudit = auditResult;

        if (!auditResult.summary.passed) {
          logger.warn(
            `[AccessibilityAudit] Accessibility audit FAILED with ${auditResult.violations.length} violations (${auditResult.summary.bySeverity.error} errors, ${auditResult.summary.bySeverity.warning} warnings)`
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
