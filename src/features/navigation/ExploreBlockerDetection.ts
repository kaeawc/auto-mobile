import type { BootedDevice, Element, ObserveResult, ViewHierarchyResult } from "../../models";
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

/**
 * Build a case-sensitive word-boundary pattern from already-lowercased
 * keywords. Callers must lowercase input text before testing (see
 * `elementText`) since the pattern itself carries no `i` flag.
 */
function wordBoundaryPattern(keywords: string[]): RegExp {
  return new RegExp(`\\b(?:${keywords.join("|")})\\b`);
}

/**
 * Test a keyword pattern against `text` and `content-desc` independently,
 * never against them joined.
 *
 * `elementText`'s space-joined string prevents a *single-token* keyword from
 * being manufactured across the two fields (e.g. "acc" + "ess" -> "access"),
 * but a *multi-word* keyword like "only this time" has its own internal
 * space — text:"Only" + content-desc:"this time" reproduces that exact
 * phrase via the join separator alone (issue #6122). Matching each field on
 * its own closes that gap while leaving single-field matches unchanged.
 */
function matchesInAnyField(pattern: RegExp, el: Element): boolean {
  const fields = [el.text, el["content-desc"]];
  return fields.some((field) => field !== undefined && pattern.test(field.toLowerCase()));
}

const RATING_KEYWORD_PATTERN = wordBoundaryPattern(RATING_KEYWORDS);

/**
 * Permission-dialog keywords, matched on word boundaries.
 *
 * Substring matching misclassified ordinary UI text — "access" matched
 * "Accessibility", and (in `handlePermissionDialog`) "ok" matched
 * "Bookmarks"/"Cookies"/"Tokens" (issue #6122, same defect class as #4190).
 * "access" is dropped entirely rather than boundary-matched: as a whole word
 * it still shows up in ambient, non-permission UI ("Quick access", "Access
 * your library" as a bookmarks/history shortcut). Real permission dialogs
 * always carry "allow"/"permission"/"deny" alongside it, so those keywords
 * cover the case ("Allow access to your location?" still matches via
 * "allow") without the false positives.
 */
const PERMISSION_KEYWORDS = [
  "allow",
  "permission",
  "deny",
  "don't allow",
  "while using",
  "only this time",
];

const PERMISSION_KEYWORD_PATTERN = wordBoundaryPattern(PERMISSION_KEYWORDS);

/**
 * Check if screen is a permission dialog
 */
export function isPermissionDialog(elements: Element[]): boolean {
  return elements.some((el) => matchesInAnyField(PERMISSION_KEYWORD_PATTERN, el));
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
 * "Allow"-button keywords, matched on word boundaries (issue #6122): bare
 * "ok" as a substring matched "Bookmarks"/"Look up"/"Cookies"/"Tokens".
 */
const ALLOW_KEYWORDS = ["allow", "while using", "only this time", "ok"];

const ALLOW_KEYWORD_PATTERN = wordBoundaryPattern(ALLOW_KEYWORDS);

/**
 * Handle permission dialog by clicking "Allow" or similar
 */
export async function handlePermissionDialog(
  elements: Element[],
  viewHierarchy: ViewHierarchyResult,
  device: BootedDevice,
  adb: AdbExecutor | null,
  progress?: ProgressCallback,
): Promise<boolean> {
  for (const element of elements) {
    if (!element.clickable) {
      continue;
    }

    if (matchesInAnyField(ALLOW_KEYWORD_PATTERN, element)) {
      const selector = tapSelectorFor(element, viewHierarchy);
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

const DISMISS_KEYWORDS = ["not now", "later", "no thanks", "dismiss", "close", "skip"];

const DISMISS_KEYWORD_PATTERN = wordBoundaryPattern(DISMISS_KEYWORDS);

/**
 * Dismiss dialog by clicking dismiss/close/later buttons
 */
async function dismissDialog(
  elements: Element[],
  viewHierarchy: ViewHierarchyResult,
  device: BootedDevice,
  adb: AdbExecutor | null,
  progress?: ProgressCallback,
): Promise<boolean> {
  for (const element of elements) {
    if (!element.clickable) {
      continue;
    }

    if (matchesInAnyField(DISMISS_KEYWORD_PATTERN, element)) {
      const selector = tapSelectorFor(element, viewHierarchy);
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
    return await handlePermissionDialog(elements, viewHierarchy, device, adb, progress);
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
    return await dismissDialog(elements, viewHierarchy, device, adb, progress);
  }

  return false;
}
