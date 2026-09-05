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
 * Tokenize accessibility field text into lowercase word tokens.
 *
 * Splits on every non-alphanumeric character (whitespace, underscore,
 * hyphen, dot, slash, apostrophe, punctuation) AND at camelCase boundaries
 * (a lowercase letter or digit followed by an uppercase letter), so
 * "ok_button", "okButton", and "OK Button" all tokenize to the same
 * `["ok", "button"]`.
 *
 * This replaces regex-boundary keyword matching (`\b`, then a
 * non-alphanumeric lookaround), which needed a new boundary rule for every
 * separator style real apps use — underscore ids in one #6122 follow-up,
 * camelCase ids in the next. Tokenizing once and comparing whole tokens ends
 * that per-case patching: a keyword matches iff it equals a token (or, for a
 * multi-word keyword, a contiguous run of tokens), so "ok" never matches
 * inside "token" or "bookmark", and "allow" never matches inside
 * "disallowance", regardless of how the surrounding text is punctuated or
 * cased.
 */
function tokenize(field: string): string[] {
  return field
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter((token) => token.length > 0)
    .map((token) => token.toLowerCase());
}

/**
 * True if `keywordTokens` (itself tokenized, so "don't allow" -> ["don", "t",
 * "allow"]) appears as a contiguous run inside `fieldTokens`.
 */
function containsTokenSequence(fieldTokens: string[], keywordTokens: string[]): boolean {
  if (keywordTokens.length === 0) {
    return false;
  }
  for (let start = 0; start + keywordTokens.length <= fieldTokens.length; start++) {
    if (keywordTokens.every((token, offset) => fieldTokens[start + offset] === token)) {
      return true;
    }
  }
  return false;
}

function toKeywordTokenLists(keywords: string[]): string[][] {
  return keywords.map(tokenize);
}

/**
 * Test a set of already-tokenized keywords against an element's `text` and
 * `content-desc` independently — never joined.
 *
 * A joined string would let a multi-word keyword be manufactured across the
 * two independent fields (text:"Only" + content-desc:"this time" -> "only
 * this time"), so each field is tokenized and searched on its own (issue
 * #6122 follow-up).
 */
function matchesAnyKeywordInAnyField(keywordTokenLists: string[][], el: Element): boolean {
  const fields = [el.text, el["content-desc"]];
  return fields.some((field) => {
    if (field === undefined) {
      return false;
    }
    const fieldTokens = tokenize(field);
    return keywordTokenLists.some((keywordTokens) =>
      containsTokenSequence(fieldTokens, keywordTokens),
    );
  });
}

const RATING_KEYWORD_PATTERN = wordBoundaryPattern(RATING_KEYWORDS);

/**
 * Permission-dialog keywords, matched by whole tokens (see `tokenize`).
 *
 * Substring matching misclassified ordinary UI text — "access" matched
 * "Accessibility", and (in `handlePermissionDialog`) "ok" matched
 * "Bookmarks"/"Cookies"/"Tokens" (issue #6122, same defect class as #4190).
 * "access" is dropped entirely rather than token-matched: as a whole word it
 * still shows up in ambient, non-permission UI ("Quick access", "Access your
 * library" as a bookmarks/history shortcut). Real permission dialogs always
 * carry "allow"/"permission"/"deny" alongside it, so those keywords cover the
 * case ("Allow access to your location?" still matches via "allow") without
 * the false positives.
 */
const PERMISSION_KEYWORDS = [
  "allow",
  "permission",
  "deny",
  "don't allow",
  "while using",
  "only this time",
];

const PERMISSION_KEYWORD_TOKENS = toKeywordTokenLists(PERMISSION_KEYWORDS);

/**
 * Check if screen is a permission dialog
 */
export function isPermissionDialog(elements: Element[]): boolean {
  return elements.some((el) => matchesAnyKeywordInAnyField(PERMISSION_KEYWORD_TOKENS, el));
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
 * "Allow"-button keywords, matched by whole tokens (issue #6122): bare "ok"
 * as a substring matched "Bookmarks"/"Look up"/"Cookies"/"Tokens", while
 * token matching still accepts machine ids like "ok_button"/"okButton" and
 * "okay" as its own affirmative.
 */
const ALLOW_KEYWORDS = ["allow", "while using", "only this time", "ok", "okay"];

const ALLOW_KEYWORD_TOKENS = toKeywordTokenLists(ALLOW_KEYWORDS);

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

    if (matchesAnyKeywordInAnyField(ALLOW_KEYWORD_TOKENS, element)) {
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

const DISMISS_KEYWORD_TOKENS = toKeywordTokenLists(DISMISS_KEYWORDS);

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

    if (matchesAnyKeywordInAnyField(DISMISS_KEYWORD_TOKENS, element)) {
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
