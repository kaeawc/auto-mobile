import type { ViewHierarchyNode, ViewHierarchyResult } from "../../models";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import {
  ALERT_TITLE_RESOURCE_ID,
  CLOSE_APP_BUTTON_RESOURCE_ID,
  WAIT_BUTTON_RESOURCE_ID,
} from "../../utils/androidSystemUiAnr";
import { logger } from "../../utils/logger";
import { DefaultElementParser } from "../utility/ElementParser";
import { APP_ERROR_RESOURCE_ID_PREFIX, FRAMEWORK_WINDOW_PACKAGE } from "./observationVerdict";

/**
 * `getForegroundApp` reports the resumed activity beneath an AppErrorDialog,
 * while the dialog itself is the focused framework window. Confirm that rare
 * divergence before treating the captured `android` hierarchy as stale.
 */
export async function isConfirmedFrameworkErrorDialog(
  adb: AdbExecutor,
  viewHierarchy: ViewHierarchyResult | undefined,
  signal?: AbortSignal,
): Promise<boolean> {
  if (viewHierarchy?.packageName !== FRAMEWORK_WINDOW_PACKAGE) {
    return false;
  }
  const parser = new DefaultElementParser();
  let appErrorResourceFound = false;
  let alertTitleFound = false;
  let closeAppButtonFound = false;
  let waitButtonFound = false;
  let anrTitleFound = false;
  let waitActionFound = false;
  for (const root of parser.extractRootNodes(viewHierarchy)) {
    parser.traverseNode(root, (node: unknown) => {
      const properties = parser.extractNodeProperties(node as ViewHierarchyNode);
      const resourceId = properties["resource-id"] ?? properties.resourceId;
      appErrorResourceFound ||=
        typeof resourceId === "string" && resourceId.startsWith(APP_ERROR_RESOURCE_ID_PREFIX);
      alertTitleFound ||= resourceId === ALERT_TITLE_RESOURCE_ID;
      closeAppButtonFound ||= resourceId === CLOSE_APP_BUTTON_RESOURCE_ID;
      waitButtonFound ||= resourceId === WAIT_BUTTON_RESOURCE_ID;
      const text = properties.text ?? properties["content-desc"];
      anrTitleFound ||= typeof text === "string" && /\b(?:isn't|is not) responding\b/i.test(text);
      waitActionFound ||= text === "Wait";
    });
  }
  const capturedDialog =
    appErrorResourceFound ||
    (anrTitleFound && waitActionFound) ||
    (alertTitleFound && closeAppButtonFound && waitButtonFound);
  if (!capturedDialog) {
    return false;
  }
  try {
    const { stdout } = await adb.executeCommand(`shell "dumpsys window"`, { signal });
    return /mCurrentFocus=Window\{[^}\r\n]*Application (?:Error:|Not Responding)/.test(stdout);
  } catch (error) {
    // This optional confirmation must not fail observe; fall back to the normal mismatch gate.
    logger.debug("Failed to read focused framework window from dumpsys:", error);
    return false;
  }
}
