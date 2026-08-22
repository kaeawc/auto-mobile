import type { ElementBounds, ViewHierarchyNode, ViewHierarchyResult } from "../models";
import { DefaultElementParser } from "../features/utility/ElementParser";

const SYSTEM_UI_PACKAGE = "com.android.systemui";
const SYSTEM_UI_ANR_TITLE = "System UI isn't responding";
const WAIT_ACTION = "Wait";

// The ANR dialog title and action labels are localized, so exact English text
// never matches on non-English devices. The framework AlertDialog resource IDs
// are stable across locales: `alertTitle` names the title, and AOSP's
// AppNotRespondingDialog wires BUTTON_NEGATIVE ("Wait") and BUTTON_POSITIVE
// ("Close app"), which the AlertController renders as `button2`/`button1`.
const ALERT_TITLE_RESOURCE_ID = "android:id/alertTitle";
const WAIT_BUTTON_RESOURCE_ID = "android:id/button2";
const CLOSE_APP_BUTTON_RESOURCE_ID = "android:id/button1";
const SYSTEM_WINDOW_TYPE = 3;

export interface SystemUiAnrDialog {
  waitBounds: ElementBounds;
}

type AnrDialogParser = Pick<
  DefaultElementParser,
  | "extractNodeProperties"
  | "extractWindowRootGroups"
  | "extractRootNodes"
  | "parseBounds"
  | "traverseNode"
>;

interface SystemUiAnrSignals {
  systemUi: boolean;
  systemWindow: boolean;
  titleFound: boolean;
  alertTitleFound: boolean;
  closeAppResourceFound: boolean;
  waitBounds?: ElementBounds;
  waitBoundsByResourceId?: ElementBounds;
}

/**
 * Detects the Android framework System UI ANR dialog in the topmost window.
 * A matching title alone is insufficient because an app can render the same
 * text; require System UI ownership.
 */
export function findSystemUiAnrDialog(
  viewHierarchy: ViewHierarchyResult,
  parser: AnrDialogParser = new DefaultElementParser(),
): SystemUiAnrDialog | undefined {
  const topmostWindow =
    parser.extractWindowRootGroups(viewHierarchy, "topmost-first")[0] ??
    parser.extractRootNodes(viewHierarchy);
  if (topmostWindow.length === 0) {
    return undefined;
  }

  const signals: SystemUiAnrSignals = {
    systemUi: hierarchyPackageIsSystemUi(viewHierarchy) || topmostWindowPackageIsSystemUi(viewHierarchy),
    systemWindow: topmostWindowIsSystemWindow(viewHierarchy),
    titleFound: false,
    alertTitleFound: false,
    closeAppResourceFound: false,
  };
  for (const root of topmostWindow) {
    parser.traverseNode(root, (node: ViewHierarchyNode) =>
      inspectSystemUiAnrNode(node, parser, signals),
    );
  }

  // English match: exact localized-in-English strings plus System UI ownership.
  const englishWaitBounds = matchesEnglishSystemUiAnr(signals) ? signals.waitBounds : undefined;
  if (englishWaitBounds) {
    return { waitBounds: englishWaitBounds };
  }
  // Localized fallback: CtrlProxy exposes AccessibilityWindowInfo types, where
  // Android framework dialogs are TYPE_SYSTEM (3). Requiring a system window
  // prevents an app-owned AlertDialog from being mistaken for a localized ANR.
  const localizedWaitBounds = matchesLocalizedSystemUiAnr(signals)
    ? signals.waitBoundsByResourceId
    : undefined;
  if (localizedWaitBounds) {
    return { waitBounds: localizedWaitBounds };
  }
  return undefined;
}

function matchesEnglishSystemUiAnr(signals: SystemUiAnrSignals): boolean {
  return (
    signals.titleFound &&
    signals.waitBounds !== undefined &&
    signals.systemUi
  );
}

function matchesLocalizedSystemUiAnr(signals: SystemUiAnrSignals): boolean {
  return (
    signals.systemUi &&
    signals.systemWindow &&
    signals.alertTitleFound &&
    signals.closeAppResourceFound &&
    signals.waitBoundsByResourceId !== undefined
  );
}

function inspectSystemUiAnrNode(
  node: ViewHierarchyNode,
  parser: AnrDialogParser,
  signals: SystemUiAnrSignals,
): void {
  const properties = parser.extractNodeProperties(node);
  const text = coalesceString(properties.text, properties["content-desc"]);
  const packageName = coalesceString(
    properties.packageName,
    coalesceString(properties.package, properties["package-name"]),
  );
  const resourceId = coalesceString(properties["resource-id"], properties.resourceId);
  signals.systemUi ||= packageName === SYSTEM_UI_PACKAGE;
  signals.titleFound ||= text === SYSTEM_UI_ANR_TITLE;
  signals.alertTitleFound ||= resourceId === ALERT_TITLE_RESOURCE_ID;
  signals.closeAppResourceFound ||= resourceId === CLOSE_APP_BUTTON_RESOURCE_ID;
  if (text === WAIT_ACTION) {
    signals.waitBounds ??= boundsOfNode(parser, properties, node);
  }
  if (resourceId === WAIT_BUTTON_RESOURCE_ID) {
    signals.waitBoundsByResourceId ??= boundsOfNode(parser, properties, node);
  }
}

function coalesceString(primary: unknown, fallback: unknown): string {
  return String(primary ?? fallback ?? "");
}

function boundsOfNode(
  parser: AnrDialogParser,
  properties: { bounds?: unknown },
  node: ViewHierarchyNode,
): ElementBounds | undefined {
  return parser.parseBounds(properties.bounds ?? node.bounds) ?? undefined;
}

function topmostWindowPackageIsSystemUi(viewHierarchy: ViewHierarchyResult): boolean {
  return topmostWindow(viewHierarchy)?.packageName === SYSTEM_UI_PACKAGE;
}

function hierarchyPackageIsSystemUi(viewHierarchy: ViewHierarchyResult): boolean {
  return viewHierarchy.packageName === SYSTEM_UI_PACKAGE;
}

function topmostWindowIsSystemWindow(viewHierarchy: ViewHierarchyResult): boolean {
  return topmostWindow(viewHierarchy)?.type === SYSTEM_WINDOW_TYPE;
}

function topmostWindow(
  viewHierarchy: ViewHierarchyResult,
): NonNullable<ViewHierarchyResult["windows"]>[number] | undefined {
  const windows = viewHierarchy.windows;
  if (!windows || windows.length === 0) {
    return undefined;
  }
  return windows.reduce((current, candidate) =>
    (candidate.windowLayer ?? 0) > (current.windowLayer ?? 0) ? candidate : current,
  );
}

export function centerOfBounds(bounds: ElementBounds): { x: number; y: number } {
  return {
    x: Math.floor((bounds.left + bounds.right) / 2),
    y: Math.floor((bounds.top + bounds.bottom) / 2),
  };
}
