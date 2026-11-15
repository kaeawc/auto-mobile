/** How an observed text value compares with the requested one. */
export type TextValueMatch = "exact" | "normalized" | "mismatch";

// Spaces an app may insert or drop (card-number groups, thin-space thousands).
const WHITESPACE = /\s/gu;
// A comma that separates a thousands group: "1,000" but not "1,5".
const THOUSANDS_COMMA = /(?<=\d),(?=\d{3}(?!\d))/gu;
// Digits with only phone formatting: an optional leading "+", spaces, parentheses, dashes.
// It starts with "+", a digit or "(" and ends with a digit, so a leading or
// trailing dash (a sign) is never phone formatting: "-1234567" stays signed.
const PHONE_LIKE = /^\+?[\d(][\d\s()\-‐-–]*\d$/u;
const PHONE_FORMATTING = /[()\-‐-–]/gu;
const MIN_PHONE_DIGITS = 7;

function isPhoneLike(value: string): boolean {
  return PHONE_LIKE.test(value) && (value.match(/\d/gu)?.length ?? 0) >= MIN_PHONE_DIGITS;
}

/**
 * Remove only formatting that cannot change a value's meaning. Signs, decimal
 * points, currency symbols and other punctuation are kept, so "-5", "1.5" and
 * "$5" never normalize to "5", "15" and "5". Parentheses and dashes are dropped
 * only from phone-like values, where they group digits.
 */
function stripFormatting(value: string): string {
  const grouped = isPhoneLike(value) ? value.replace(PHONE_FORMATTING, "") : value;
  return grouped.replace(WHITESPACE, "").replace(THOUSANDS_COMMA, "");
}

/**
 * Compare a requested text value with what the field shows. An app that reformats
 * input (phone numbers, card numbers, grouped amounts) keeps the same characters
 * apart from safe formatting, so equality after removing it counts as a match
 * (#18350). A requested value with nothing left after normalization must match
 * exactly.
 */
export function matchTextValue(requested: string, observed: string): TextValueMatch {
  if (requested === observed) {
    return "exact";
  }
  const normalizedRequested = stripFormatting(requested);
  if (normalizedRequested !== "" && normalizedRequested === stripFormatting(observed)) {
    return "normalized";
  }
  return "mismatch";
}
