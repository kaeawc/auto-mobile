import type { ElementBounds, ViewHierarchyNode, ViewHierarchyResult } from "../models";
import { DefaultElementParser } from "../features/utility/ElementParser";

const SYSTEM_UI_PACKAGE = "com.android.systemui";
const SYSTEM_UI_ANR_TITLE = "System UI isn't responding";
const WAIT_ACTION = "Wait";
const CLOSE_APP_ACTION = "Close app";

export interface SystemUiAnrDialog {
  waitBounds: ElementBounds;
}

/**
 * Detects the Android framework System UI ANR dialog in the topmost window.
 * A matching title alone is insufficient because an app can render the same
 * text; require System UI ownership or both framework action labels.
 */
export function findSystemUiAnrDialog(
  viewHierarchy: ViewHierarchyResult,
  parser: Pick<
    DefaultElementParser,
    | "extractNodeProperties"
    | "extractWindowRootGroups"
    | "extractRootNodes"
    | "parseBounds"
    | "traverseNode"
  > = new DefaultElementParser(),
): SystemUiAnrDialog | undefined {
  const topmostWindow =
    parser.extractWindowRootGroups(viewHierarchy, "topmost-first")[0] ??
    parser.extractRootNodes(viewHierarchy);
  if (topmostWindow.length === 0) {
    return undefined;
  }

  let systemUi = topmostWindowPackageIsSystemUi(viewHierarchy);
  let titleFound = false;
  let closeAppFound = false;
  let waitBounds: ElementBounds | undefined;

  for (const root of topmostWindow) {
    parser.traverseNode(root, (node: ViewHierarchyNode) => {
      const properties = parser.extractNodeProperties(node);
      const text = String(properties.text ?? properties["content-desc"] ?? "");
      const packageName = String(properties.package ?? properties["package-name"] ?? "");
      systemUi ||= packageName === SYSTEM_UI_PACKAGE;
      titleFound ||= text === SYSTEM_UI_ANR_TITLE;
      closeAppFound ||= text === CLOSE_APP_ACTION;
      if (text === WAIT_ACTION) {
        waitBounds ??= parser.parseBounds(properties.bounds ?? node.bounds) ?? undefined;
      }
    });
  }

  if (!titleFound || !waitBounds || (!systemUi && !closeAppFound)) {
    return undefined;
  }
  return { waitBounds };
}

function topmostWindowPackageIsSystemUi(viewHierarchy: ViewHierarchyResult): boolean {
  const windows = viewHierarchy.windows;
  if (!windows || windows.length === 0) {
    return false;
  }
  const topmost = windows.reduce((current, candidate) =>
    (candidate.windowLayer ?? 0) > (current.windowLayer ?? 0) ? candidate : current,
  );
  return topmost.packageName === SYSTEM_UI_PACKAGE;
}

export function centerOfBounds(bounds: ElementBounds): { x: number; y: number } {
  return {
    x: Math.floor((bounds.left + bounds.right) / 2),
    y: Math.floor((bounds.top + bounds.bottom) / 2),
  };
}
