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
 * hyphen, dot, slash, apostrophe, punctuation) AND at camelCase boundaries —
 * both a lowercase/digit-to-uppercase transition ("okButton" -> "ok
 * Button") and an acronym-to-titlecase transition ("OKButton" ->
 * "OK Button", "HTTPServer" -> "HTTP Server") — so "ok_button", "okButton",
 * "OKButton", and "OK Button" all tokenize to the same `["ok", "button"]`.
 *
 * This replaces regex-boundary keyword matching (`\b`, then a
 * non-alphanumeric lookaround), which needed a new boundary rule for every
 * separator style real apps use — underscore ids in one #6122 follow-up,
 * plain camelCase ids in the next, acronym-prefixed camelCase in this one.
 * Tokenizing once and comparing whole tokens ends that per-case patching: a
 * keyword matches iff it equals a token (or, for a multi-word keyword, a
 * contiguous run of tokens), so "ok" never matches inside "token" or
 * "bookmark", and "allow" never matches inside "disallowance", regardless of
 * how the surrounding text is punctuated or cased.
 */
function tokenize(field: string): string[] {
  return field
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter((token) => token.length > 0)
    .map((token) => token.toLowerCase());
}

/**
 * True if `keywordTokens` (itself tokenized, so "don't allow" -> ["don", "t",
 * "allow"]) appears, by exact token equality, as a contiguous run inside
 * `fieldTokens`.
 *
 * An earlier revision stripped a trailing "s"/"es"/"ing"/"ed" from a field
 * token before comparing, to accept plurals like "permissions" without
 * listing them explicitly. That algorithmic stemming traded one false
 * negative for a false positive: "notes" strips to "not", so "Notes now"
 * satisfied the dismiss phrase "not now" (issue #6122 follow-up). Matching
 * stays exact-token-only; any inflected form a real dialog uses (e.g.
 * "permissions", "allows") is listed explicitly in the keyword set instead
 * (see `PERMISSION_KEYWORDS`), so the match surface is exactly what was
 * asked for, never a guess.
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
 * "access" is included as its own exact token: tokenizing "Accessibility"
 * yields the single token `["accessibility"]`, distinct from `["access"]`,
 * so it no longer collides the way the old substring check did — an earlier
 * revision dropped "access" from this list defensively, before the
 * tokenizer existed to make that distinction safely, which regressed
 * "Camera access required" to a miss. Plurals actually seen on real dialogs
 * ("permissions", "allows") are listed explicitly rather than derived by
 * stemming — stemming previously turned "Notes now" into a false dismiss
 * match ("notes" -> "not").
 *
 * Also includes the "allow"-family machine-form negatives that `DENY_KEYWORDS`
 * (below) exists to catch — "dont allow", "do not allow", "not allow", and the
 * fully concatenated "notallow", "dontallow", "donotallow", and "neverallow" — because a
 * deny-only dialog whose only text is one of these (e.g. a custom/OEM control
 * with `content-desc="notallow"`
 * and no separate "permission"/"access" label) previously failed detection
 * here entirely: `isPermissionDialog` returned false, so the permission
 * fast-path returned "none" and the control fell through to ordinary
 * navigation, where `performInteraction` could tap it and silently deny the
 * permission before `handlePermissionDialog` — and therefore `DENY_KEYWORDS`
 * — was ever consulted (issue #6293 P2). Generic deny words unrelated to
 * "allow" ("block", "reject", "disallow", "no thanks") are deliberately NOT
 * included here: unlike the "allow" forms, they show up in unrelated dialogs
 * (e.g. "Block this contact") and would misclassify those as permission
 * dialogs.
 */
const PERMISSION_KEYWORDS = [
  "allow",
  "allows",
  "permission",
  "permissions",
  "access",
  "deny",
  "don't allow",
  "dont allow",
  "dontallow",
  "do not allow",
  "donotallow",
  "not allow",
  "notallow",
  "never allow",
  "neverallow",
  "while using",
  "only this time",
];

const PERMISSION_KEYWORD_TOKENS = toKeywordTokenLists(PERMISSION_KEYWORDS);

// Broad copy matching is useful for the interactive blocker fast-path, where
// the next observation confirms the result. Dry-run candidate removal is
// irreversible for that plan, so require provenance or a distinctive platform
// action label before hiding ordinary app navigation controls.
const DISTINCTIVE_PERMISSION_ACTION_TOKENS = toKeywordTokenLists([
  "while using",
  "only this time",
  "don't allow",
  "dont allow",
  "dontallow",
  "do not allow",
  "donotallow",
  "not allow",
  "notallow",
  "never allow",
  "neverallow",
]);

/**
 * Check if screen is a permission dialog
 */
export function isPermissionDialog(elements: Element[]): boolean {
  return elements.some((el) => matchesAnyKeywordInAnyField(PERMISSION_KEYWORD_TOKENS, el));
}

function isConfirmedPermissionDialogForNavigation(elements: Element[]): boolean {
  return elements.some((element) => {
    const resourceId = element["resource-id"]?.toLowerCase() ?? "";
    return (
      resourceId.includes("permissioncontroller") ||
      matchesAnyKeywordInAnyField(DISTINCTIVE_PERMISSION_ACTION_TOKENS, element)
    );
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
 * "Allow"-button keywords, matched by whole tokens (issue #6122): bare "ok"
 * as a substring matched "Bookmarks"/"Look up"/"Cookies"/"Tokens", while
 * token matching still accepts machine ids like "ok_button"/"okButton" and
 * "okay" as its own affirmative. "ok"/"okay" are never inflected — "notes"
 * must never satisfy "not", so no keyword here is derived by stemming.
 */
const ALLOW_KEYWORDS = ["allow", "allows", "while using", "only this time", "ok", "okay"];

const ALLOW_KEYWORD_TOKENS = toKeywordTokenLists(ALLOW_KEYWORDS);

/**
 * Deny/negative-button keywords that must NEVER be tapped as the affirmative
 * grant target (safety, issue #6241).
 *
 * Whole-token matching (issue #6190) cannot distinguish grant from deny here:
 * Android's deny button reads "Don't allow", which tokenizes to
 * `["don", "t", "allow"]` — a genuine "allow" token — so it satisfies
 * `ALLOW_KEYWORDS`. When the deny button precedes the grant button in element
 * order, the old handler tapped the FIRST match and silently denied the
 * permission it set out to grant. An affirmative match is therefore accepted
 * only when the element does NOT also match one of these deny labels, so a
 * button carrying "allow" purely as part of a negative phrase ("Don't Allow")
 * is excluded rather than tapped.
 *
 * Listed as exact tokens/phrases (see `tokenize`): "don't allow" ->
 * `["don", "t", "allow"]`, "deny", "block", "reject", "disallow", plus the
 * dismissive "no thanks". Matched independently on `text` and `content-desc`.
 *
 * Two gaps this set must close by hand, because matching is whole-token and
 * carries no stemming:
 *   - Inflected deny forms. "block" tokenizes to `["block"]` and so does NOT
 *     match "Blocked" (`["blocked"]`); likewise "reject"/"rejected" and
 *     "disallow"/"disallowed". A control that carries an allow token in one
 *     field and "Blocked" in another would otherwise pass
 *     `isAffirmativeGrantElement` and be tapped, so every inflected deny form a
 *     real dialog uses is listed explicitly.
 *   - Machine-form negatives. A custom/OEM control may expose its denial via a
 *     `content-desc` id like `dontAllowButton` (-> `["dont", "allow",
 *     "button"]`), `doNotAllowButton` (-> `["do", "not", "allow", "button"]`),
 *     or `notAllowButton` (-> `["not", "allow", "button"]`, the "do"-less
 *     standalone form). The apostrophe phrase "don't allow" (`["don", "t",
 *     "allow"]`) does not match any of these concatenated spellings, so "dont
 *     allow", "do not allow", and "not allow" are each listed as their own
 *     phrase. A fully lowercase id with no separator or case boundary at all,
 *     such as `notallow` (no trailing "button"/"btn" token to split it off),
 *     tokenizes to the single token `["notallow"]` rather than `["not",
 *     "allow"]` — `containsTokenSequence` is exact-token, so the two-word
 *     phrase would not match it. "notallow" is listed as its own single-token
 *     keyword to cover exactly that fully concatenated spelling. Likewise the
 *     reported lowercase `dontallow`, `donotallow`, and `neverallow` forms are explicit
 *     single-token entries. This is normalization for known machine labels,
 *     not generic stemming or substring matching.
 */
const DENY_KEYWORDS = [
  "don't allow",
  "dont allow",
  "dontallow",
  "do not allow",
  "donotallow",
  "not allow",
  "notallow",
  "never allow",
  "neverallow",
  "deny",
  "denied",
  "block",
  "blocked",
  "reject",
  "rejected",
  "disallow",
  "disallowed",
  "no thanks",
];

const DENY_KEYWORD_TOKENS = toKeywordTokenLists(DENY_KEYWORDS);

/**
 * True when an element is a safe affirmative grant target: it matches an
 * "Allow" keyword AND does not match any deny/negative label (issue #6241).
 */
export function isPermissionDenyElement(element: Element): boolean {
  return matchesAnyKeywordInAnyField(DENY_KEYWORD_TOKENS, element);
}

/**
 * Applies permission-denial safety policy at ordinary navigation selection.
 * Keep non-permission screens untouched: labels such as "Block" remain valid
 * app navigation outside a recognized permission dialog.
 */
export function filterPermissionNavigationCandidates(
  candidates: Element[],
  screenElements: Element[],
): Element[] {
  return isPermissionDialog(screenElements) &&
    isConfirmedPermissionDialogForNavigation(screenElements)
    ? candidates.filter((element) => !isPermissionDenyElement(element))
    : candidates;
}

function isAffirmativeGrantElement(element: Element): boolean {
  return (
    matchesAnyKeywordInAnyField(ALLOW_KEYWORD_TOKENS, element) && !isPermissionDenyElement(element)
  );
}

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

    if (isAffirmativeGrantElement(element)) {
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
