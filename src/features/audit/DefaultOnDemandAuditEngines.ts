import type { BootedDevice, ObserveResult } from "../../models";
import { RealObserveScreen } from "../observe/ObserveScreen";
import { getScreenshotStateStore } from "../observe/screenshot/ScreenshotStateRegistry";
import { resolveObservationScreenshotPath } from "../observe/audits/AccessibilityAuditor";
import { PerformanceAuditor } from "../observe/audits/PerformanceAuditor";
import { WcagAudit } from "../accessibility/WcagAudit";
import { projectAuditElements } from "../accessibility/AuditElementProjection";
import { BaselineManager } from "../accessibility/BaselineManager";
import { MemoryAudit } from "../memory/MemoryAudit";
import { serverConfig } from "../../utils/ServerConfig";
import { NoOpPerformanceTracker } from "../../utils/NoOpPerformanceTracker";
import type { AuditBaselineStore, OnDemandAuditEngines } from "./OnDemandAudit";

/**
 * Named baselines share the accessibility baseline table with the per-screen baselines the
 * observe-time audit keeps; the prefix keeps a name from ever matching a screen id.
 */
const NAMED_BASELINE_PREFIX = "audit-baseline:";

function namedBaselineStore(manager: BaselineManager): AuditBaselineStore {
  return {
    getBaseline: (name) => manager.getBaseline(`${NAMED_BASELINE_PREFIX}${name}`),
    saveBaseline: (name, violations) =>
      manager.saveBaseline(`${NAMED_BASELINE_PREFIX}${name}`, violations),
  };
}

/** The production engines: the same ones `observe` runs behind its feature flags. */
export function createDefaultOnDemandAuditEngines(device: BootedDevice): OnDemandAuditEngines {
  const observeScreen = new RealObserveScreen(device);
  return {
    async observe() {
      // The flag-driven audits are skipped here; this tool runs the ones it was asked for.
      const result = await observeScreen.execute({
        freshness: "fresh",
        screenshot: "settled",
        skipAccessibilityAudit: true,
        skipPerformanceAudit: true,
      });
      // Only this observation's own capture may feed the contrast check (#10037).
      const screenshotPath = await resolveObservationScreenshotPath(
        getScreenshotStateStore().getPathForObservation(device.deviceId, result.observationId),
      );
      return { result, screenshotPath };
    },
    async accessibility(result, screenshotPath, appId, config) {
      const viewHierarchy = result.viewHierarchy;
      if (!viewHierarchy?.hierarchy) {
        throw new Error("The observation has no view hierarchy to audit.");
      }
      const { elements, descendantLabelled, windowIds } = projectAuditElements(viewHierarchy);
      return new WcagAudit().audit(
        elements,
        viewHierarchy.hierarchy,
        { screenshotPath, packageName: appId, config },
        {
          density: viewHierarchy.density,
          windows: viewHierarchy.windows,
          descendantLabelled,
          elementWindowIds: windowIds,
        },
      );
    },
    async performance(result) {
      // Run on a copy so the auditor's attachment never mutates the caller's observation.
      const target: ObserveResult = { ...result };
      await new PerformanceAuditor({
        device,
        isEnabled: () => true,
        observeScreenProvider: () => observeScreen,
      }).run(target, new NoOpPerformanceTracker());
      return target.performanceAudit;
    },
    memory(appId) {
      // A snapshot of the app as it is now: no action runs between the two samples.
      return new MemoryAudit(device).runAudit(appId, "audit", {}, async () => {});
    },
    elements(result) {
      return result.viewHierarchy ? projectAuditElements(result.viewHierarchy).elements : [];
    },
    baselines: namedBaselineStore(new BaselineManager()),
    accessibilityConfig: () => serverConfig.getAccessibilityAuditConfig(),
  };
}
