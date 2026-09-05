import type { BootedDevice, Element, ObserveResult } from "../../models";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import type { ProgressCallback } from "../action/BaseVisualChange";
import type { ElementParser } from "../../utils/interfaces/ElementParser";
import { TapOnElement } from "../action/TapOnElement";
import { logger } from "../../utils/logger";
import { extractAllElements, tapSelectorFor } from "./ExploreElementExtraction";
import { defaultTimer } from "../../utils/SystemTimer";

/**
 * Normalized, lowercased text for an element.
 *
 * `text` and `content-desc` are joined with a space so a keyword can never be
 * formed by the concatenation itself (issue #4190).
 */
function elementText(el: Element): string {
  return `${el.text ?? ""} ${el["content-desc"] ?? ""}`.toLowerCase();
}

/**
 * Rating keywords plus their common inflections, matched on word boundaries.
 *
 * Substring matching misclassified ordinary UI text — "Get Started" and
 * "Restart" contain "star", "accurate"/"generate"/"separate" contain "rate"
 * (issue #4190). Boundary matching keeps legitimate hits such as "5 stars"
 * and "Enjoying the app?".
 */
const RATING_KEYWORDS = [
  "rate",
  "rates",
  "rated",
  "rating",
  "ratings",
  "review",
  "reviews",
  "reviewed",
  "feedback",
  "enjoy",
  "enjoys",
  "enjoyed",
  "enjoying",
  "star",
  "stars",
];

const RATING_KEYWORD_PATTERN = new RegExp(`\\b(?:${RATING_KEYWORDS.join("|")})\\b`);

/**
 * Check if screen is a permission dialog
 */
export function isPermissionDialog(elements: Element[]): boolean {
  const permissionKeywords = [
    "allow",
    "permission",
    "access",
    "deny",
    "don't allow",
    "while using",
    "only this time",
  ];

  return elements.some((el) => {
    const text = (el.text?.toLowerCase() ?? "") + (el["content-desc"]?.toLowerCase() ?? "");
    return permissionKeywords.some((keyword) => text.includes(keyword));
  });
}

/**
 * Check if screen is a login/signup screen
 */
export function isLoginScreen(elements: Element[]): boolean {
  const loginKeywords = ["login", "sign in", "sign up", "username", "password", "email"];
  const hasEditText = elements.some((el) => el["class"]?.toLowerCase().includes("edittext"));

  const hasLoginText = elements.some((el) => {
    const text = (el.text?.toLowerCase() ?? "") + (el["content-desc"]?.toLowerCase() ?? "");
    return loginKeywords.some((keyword) => text.includes(keyword));
  });

  // Login screen typically has text fields and login-related text
  return hasEditText && hasLoginText;
}

/**
 * Check if screen is a rating/review dialog
 */
export function isRatingDialog(elements: Element[]): boolean {
  return elements.some((el) => RATING_KEYWORD_PATTERN.test(elementText(el)));
}

/**
 * Handle permission dialog by clicking "Allow" or similar
 */
export async function handlePermissionDialog(
  elements: Element[],
  device: BootedDevice,
  adb: AdbExecutor | null,
  progress?: ProgressCallback,
): Promise<boolean> {
  // Look for "Allow" or "While using" buttons
  const allowKeywords = ["allow", "while using", "only this time", "ok"];

  for (const element of elements) {
    if (!element.clickable) {
      continue;
    }

    const text =
      (element.text?.toLowerCase() ?? "") + (element["content-desc"]?.toLowerCase() ?? "");

    if (allowKeywords.some((keyword) => text.includes(keyword))) {
      const selector = tapSelectorFor(element);
      if (!selector) {
        continue;
      }
      try {
        const tapOn = new TapOnElement(device, adb);
        await tapOn.execute({ ...selector, action: "tap" }, progress);
        await defaultTimer.sleep(1000);
        return true;
      } catch (error) {
        logger.warn(`[Explore] Failed to handle permission dialog: ${error}`);
      }
    }
  }

  return false;
}

/**
 * Dismiss dialog by clicking dismiss/close/later buttons
 */
async function dismissDialog(
  elements: Element[],
  device: BootedDevice,
  adb: AdbExecutor | null,
  progress?: ProgressCallback,
): Promise<boolean> {
  const dismissKeywords = ["not now", "later", "no thanks", "dismiss", "close", "skip"];

  for (const element of elements) {
    if (!element.clickable) {
      continue;
    }

    const text =
      (element.text?.toLowerCase() ?? "") + (element["content-desc"]?.toLowerCase() ?? "");

    if (dismissKeywords.some((keyword) => text.includes(keyword))) {
      const selector = tapSelectorFor(element);
      if (!selector) {
        continue;
      }
      try {
        const tapOn = new TapOnElement(device, adb);
        await tapOn.execute({ ...selector, action: "tap" }, progress);
        await defaultTimer.sleep(1000);
        return true;
      } catch (error) {
        logger.warn(`[Explore] Failed to dismiss dialog: ${error}`);
      }
    }
  }

  return false;
}

/**
 * Handler for dead end situations
 */
type DeadEndHandler = (progress?: ProgressCallback) => Promise<void>;

/**
 * Detect and handle blocker screens (login, permissions, dialogs)
 */
export async function detectAndHandleBlockers(
  observation: ObserveResult,
  device: BootedDevice,
  adb: AdbExecutor | null,
  elementParser: ElementParser,
  handleDeadEnd: DeadEndHandler,
  progress?: ProgressCallback,
): Promise<boolean> {
  const viewHierarchy = observation.viewHierarchy;
  if (!viewHierarchy || viewHierarchy.hierarchy.error) {
    return false;
  }

  // Look for common blocker patterns
  const elements = extractAllElements(viewHierarchy, elementParser);

  // Check for permission dialogs
  if (isPermissionDialog(elements)) {
    logger.info("[Explore] Detected permission dialog, attempting to dismiss");
    return await handlePermissionDialog(elements, device, adb, progress);
  }

  // Check for login/signup screens
  if (isLoginScreen(elements)) {
    logger.info("[Explore] Detected login screen, skipping by going back");
    await handleDeadEnd(progress);
    return true;
  }

  // Check for app rating/review dialogs
  if (isRatingDialog(elements)) {
    logger.info("[Explore] Detected rating dialog, attempting to dismiss");
    return await dismissDialog(elements, device, adb, progress);
  }

  return false;
}
