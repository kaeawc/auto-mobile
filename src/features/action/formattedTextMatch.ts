/** How an observed text value compares with the requested one. */
export type TextValueMatch = "exact" | "normalized" | "mismatch";

// Whitespace, punctuation and symbols an app may insert or drop while formatting input.
const FORMATTING_CHARACTERS = /[\s\p{P}\p{S}]/gu;

function stripFormatting(value: string): string {
  return value.replace(FORMATTING_CHARACTERS, "");
}

/**
 * Compare a requested text value with what the field shows. An app that reformats
 * input (phone numbers, card numbers, dates) keeps the same letters and digits, so
 * equality after removing formatting characters counts as a match (#18350). A
 * requested value with no letters or digits must match exactly.
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
