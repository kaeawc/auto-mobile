import {
  normalizeIosHierarchy,
  projectActionableHierarchy,
} from "../../src/features/observe/HierarchyNormalization";
import { convertToViewHierarchyResult } from "../../src/features/observe/ios/IosHierarchyConverter";
import type { ConvertibleHierarchy } from "../../src/features/observe/ios/types";
import type { ObserveResult } from "../../src/models";
import { buildObserveResult } from "./observeFixture";

function isConvertibleHierarchy(value: unknown): value is ConvertibleHierarchy {
  return (
    typeof value === "object" &&
    value !== null &&
    "hierarchy" in value &&
    typeof value.hierarchy === "object" &&
    value.hierarchy !== null &&
    "packageName" in value &&
    typeof value.packageName === "string"
  );
}

/** Portrait iPhone 18 Pro point size the runner captures were taken at. */
const CAPTURE_SCREEN = { width: 402, height: 874 };

/**
 * Builds an observation from a raw `hierarchy_update` message captured from the iOS runner. It takes
 * the daemon's production path (convert, normalize, project), so tests read what a live read does.
 */
export function observationFromRunnerCapture(capture: { data: unknown }): ObserveResult {
  if (!isConvertibleHierarchy(capture.data)) {
    throw new Error("Runner capture has no hierarchy payload");
  }
  const converted = convertToViewHierarchyResult(capture.data);
  const viewHierarchy = projectActionableHierarchy(
    "ios",
    normalizeIosHierarchy(converted, converted.updatedAt),
  );
  return buildObserveResult({
    viewHierarchy,
    updatedAt: converted.updatedAt ?? 0,
    screenSize: CAPTURE_SCREEN,
    systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
  });
}
