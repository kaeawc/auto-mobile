import type { ObserveResult } from "../../models/ObserveResult";
import { nodeAttributes, type ViewHierarchyNode } from "../../models/ViewHierarchyResult";
import { ViewHierarchyParser } from "../../utils/ViewHierarchyParser";
import { WEAR_SYSUI_PACKAGE } from "./WearSurface";

/** Classify captured Wear UI without mistaking the shared SysUiActivity's tray for a watch face. */
export function wearSurfaceKind(
  observation: Pick<ObserveResult, "activeWindow" | "viewHierarchy">,
): ObserveResult["surface"] {
  const { activeWindow, viewHierarchy } = observation;
  if (!activeWindow?.appId || !viewHierarchy) {
    return undefined;
  }
  if (activeWindow.appId !== WEAR_SYSUI_PACKAGE) {
    return "app";
  }
  if (activeWindow.activityName?.startsWith(`${WEAR_SYSUI_PACKAGE}.experiences.globallauncher.`)) {
    return "launcher";
  }
  if (activeWindow.activityName !== `${WEAR_SYSUI_PACKAGE}.mainui.activity.SysUiActivity`) {
    return undefined;
  }

  const parser = new ViewHierarchyParser();
  let tile = false;
  let watchface = false;
  for (const root of parser.extractRootNodes(viewHierarchy)) {
    parser.traverseNode(root, (node: ViewHierarchyNode) => {
      const resourceId = nodeAttributes(node)["resource-id"];
      tile ||= resourceId === `${WEAR_SYSUI_PACKAGE}:id/carousel_tile_container`;
      watchface ||=
        resourceId === "watch_face_fallthrough" ||
        resourceId === `${WEAR_SYSUI_PACKAGE}:id/watchface_overlay`;
    });
  }
  return tile ? "tile" : watchface ? "watchface" : undefined;
}
