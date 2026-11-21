import type { Element, Point, ViewHierarchyNode, ViewHierarchyResult } from "../../models";
import { childrenOf, nodeAttributes } from "../../models/ViewHierarchyResult";
import { boundsArea } from "../../utils/bounds";
import type { ElementParser } from "../../utils/interfaces/ElementParser";
import type { ElementGeometry } from "../../utils/interfaces/ElementGeometry";
import type { ShareRow } from "./ShareTarget";

interface IosShareSheet {
  sheetKind: "ios-activity-view-controller";
  rows: ShareRow[];
  dismissPoint?: Point;
}

export function extractIosShareSheet(
  hierarchy: ViewHierarchyResult,
  parser: ElementParser,
  geometry: ElementGeometry,
): IosShareSheet | undefined {
  for (const root of parser.extractRootNodes(hierarchy)) {
    let container: ViewHierarchyNode | undefined;
    let dismiss: Element | null = null;
    parser.traverseNode(root, (node: ViewHierarchyNode) => {
      const attributes = nodeAttributes(node);
      if (attributes["resource-id"] === "ShareSheet.RemoteContainerView") {
        container = node;
      } else if (
        attributes["resource-id"] === "PopoverDismissRegion" &&
        attributes.text === "dismiss popup"
      ) {
        dismiss = parser.parseNodeBounds(node);
      }
    });
    if (!container) {
      continue;
    }
    const sheet = parser.parseNodeBounds(container);
    if (sheet && boundsArea(sheet.bounds) > 0) {
      return {
        sheetKind: "ios-activity-view-controller",
        rows: extractRows(container, parser),
        dismissPoint: dismiss ? exposedDismissPoint(dismiss, sheet, geometry) : undefined,
      };
    }
  }
}

function extractRows(container: ViewHierarchyNode, parser: ElementParser): ShareRow[] {
  const rows: ShareRow[] = [];
  parser.traverseNode(container, (node: ViewHierarchyNode) => {
    const attributes = nodeAttributes(node);
    const id = attributes["resource-id"];
    if (
      attributes.class !== "UITableViewCell" ||
      (id !== "shareCell" && id !== "actionGroupCell") ||
      (attributes.clickable !== true && attributes.clickable !== "true")
    ) {
      return;
    }
    const label = cellTitle(node);
    const element = parser.parseNodeBounds(node);
    if (label && element && boundsArea(element.bounds) > 0) {
      rows.push({
        target: { label, kind: id === "actionGroupCell" || label === "More" ? "action" : "app" },
        element,
      });
    }
  });
  return rows;
}

function cellTitle(node: ViewHierarchyNode): string | undefined {
  // UIKit puts the target title first and the publisher second, both with the same id.
  const title = childrenOf(node).find((child) => {
    const attributes = nodeAttributes(child);
    return attributes.class === "UILabel" && attributes["resource-id"] === "cellTitleLabel";
  });
  const text = title && nodeAttributes(title).text;
  return typeof text === "string" ? text.trim() : undefined;
}

function exposedDismissPoint(
  dismiss: Element,
  sheet: Element,
  geometry: ElementGeometry,
): Point | undefined {
  const bounds = dismiss.bounds;
  const center = geometry.getElementCenter(dismiss);
  if (boundsArea(bounds) > 0 && !geometry.isPointInElement(sheet, center.x, center.y)) {
    return center;
  }
  // The dismiss region can span the screen underneath the share sheet.
  const exposed = [
    { ...bounds, bottom: Math.min(bounds.bottom, sheet.bounds.top) },
    { ...bounds, top: Math.max(bounds.top, sheet.bounds.bottom) },
    { ...bounds, right: Math.min(bounds.right, sheet.bounds.left) },
    { ...bounds, left: Math.max(bounds.left, sheet.bounds.right) },
  ]
    .filter((area) => boundsArea(area) > 0)
    .map((area) => geometry.getElementCenter({ ...dismiss, bounds: area }));
  // A one-point strip rounds onto the sheet's inclusive edge, which would tap the sheet.
  return exposed.find((point) => !geometry.isPointInElement(sheet, point.x, point.y));
}
