import { readFileSync } from "node:fs";
import type { ObserveResult } from "../../src/models";
import { parseBounds } from "../../src/utils/bounds";
import { buildObserveResult } from "./observeFixture";

type SpatialPanelCapture = Pick<
  ObserveResult,
  "display" | "screenSize" | "activeWindow" | "backStack" | "viewHierarchy"
>;
const capture: SpatialPanelCapture = JSON.parse(
  readFileSync(
    new URL("../fixtures/android-xr/observe-spatial-panel-full-space-18022.json", import.meta.url),
    "utf8",
  ),
);
const noFocusCapture: SpatialPanelCapture = JSON.parse(
  readFileSync(
    new URL("../fixtures/android-xr/observe-spatial-panel-no-focus-18025.json", import.meta.url),
    "utf8",
  ),
);

const hostMissingCapture: SpatialPanelCapture = JSON.parse(
  readFileSync(
    new URL(
      "../fixtures/android-xr/observe-spatial-panel-host-window-missing-18022.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

const switchScrollCapture: SpatialPanelCapture = JSON.parse(
  readFileSync(
    new URL(
      "../fixtures/android-xr/observe-spatial-panel-switch-scroll-18022.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

/** Preserve both serialized tree representations; normalize only task geometry as the wire reader does. */
export function spatialPanelObservation(
  noFocus: boolean | "host-missing" | "switch-scroll" = false,
): ObserveResult {
  const clone = structuredClone(
    noFocus === "switch-scroll"
      ? switchScrollCapture
      : noFocus === "host-missing"
        ? hostMissingCapture
        : noFocus
          ? noFocusCapture
          : capture,
  );
  for (const task of clone.backStack?.tasks ?? []) {
    task.bounds = parseBounds(task.bounds) ?? undefined;
  }
  return buildObserveResult({
    ...clone,
    updatedAt: 0,
    systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
  });
}

/** Remove captured window roots from both representations without inventing node content. */
export function removeSpatialPanelPackageWindows(
  observation: ObserveResult,
  packageName: string,
): void {
  const hierarchy = observation.viewHierarchy!;
  hierarchy.windows = hierarchy.windows!.filter((window) => window.packageName !== packageName);
  hierarchy.hierarchy = {
    ...hierarchy.hierarchy,
    node: {
      node: hierarchy.windows.flatMap((window) => (window.hierarchy ? [window.hierarchy] : [])),
    },
  };
}
