import type { ElementBounds, ViewHierarchyNode, ViewHierarchyResult } from "../models";
import { DefaultElementParser } from "../features/utility/ElementParser";

const SYSTEM_UI_PACKAGE = "com.android.systemui";
const SYSTEM_UI_ANR_TITLE = "System UI isn't responding";
const WAIT_ACTION = "Wait";
const CLOSE_APP_ACTION = "Close app";

// The ANR dialog title and action labels are localized, so exact English text
// never matches on non-English devices. The framework AlertDialog resource IDs
// are stable across locales: `alertTitle` names the title, and AOSP's
// AppNotRespondingDialog wires BUTTON_NEGATIVE ("Wait") and BUTTON_POSITIVE
// ("Close app"), which the AlertController renders as `button2`/`button1`.
const ALERT_TITLE_RESOURCE_ID = "android:id/alertTitle";
const WAIT_BUTTON_RESOURCE_ID = "android:id/button2";
const CLOSE_APP_BUTTON_RESOURCE_ID = "android:id/button1";

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
  titleFound: boolean;
  closeAppFound: boolean;
  alertTitleFound: boolean;
  closeAppResourceFound: boolean;
  waitBounds?: ElementBounds;
  waitBoundsByResourceId?: ElementBounds;
}

/**
 * Detects the Android framework System UI ANR dialog in the topmost window.
 * A matching title alone is insufficient because an app can render the same
 * text; require System UI ownership or both framework action labels.
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
    systemUi: topmostWindowPackageIsSystemUi(viewHierarchy),
    titleFound: false,
    closeAppFound: false,
    alertTitleFound: false,
    closeAppResourceFound: false,
  };
  for (const root of topmostWindow) {
    parser.traverseNode(root, (node: ViewHierarchyNode) =>
      inspectSystemUiAnrNode(node, parser, signals),
    );
  }

  // English match: exact localized-in-English strings, ownership-or-Close-app.
  const englishWaitBounds = matchesEnglishSystemUiAnr(signals) ? signals.waitBounds : undefined;
  if (englishWaitBounds) {
    return { waitBounds: englishWaitBounds };
  }
  // Localized fallback: a System UI-owned framework AlertDialog with the ANR
  // button layout (alert title plus both Wait/Close-app buttons). Gating on
  // System UI ownership keeps this from matching unrelated app dialogs.
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
    (signals.systemUi || signals.closeAppFound)
  );
}

function matchesLocalizedSystemUiAnr(signals: SystemUiAnrSignals): boolean {
  return (
    signals.systemUi &&
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
  const packageName = coalesceString(properties.package, properties["package-name"]);
  const resourceId = coalesceString(properties["resource-id"], properties.resourceId);
  signals.systemUi ||= packageName === SYSTEM_UI_PACKAGE;
  signals.titleFound ||= text === SYSTEM_UI_ANR_TITLE;
  signals.closeAppFound ||= text === CLOSE_APP_ACTION;
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
