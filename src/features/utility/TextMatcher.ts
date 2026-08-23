import type { TextMatcher } from "../../utils/interfaces/TextMatcher";

/**
 * Normalize Unicode quotation marks and apostrophes to their ASCII equivalents.
 * iOS and Android system dialogs frequently use smart/curly quotes that differ
 * from the straight quotes users type.
 */
export function normalizeQuotes(text: string): string {
  return text
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u0060\u00B4]/g, "'") // single quotes/apostrophes → U+0027
    .replace(/[\u201C\u201D\u201E\u201F\u2033\u00AB\u00BB]/g, '"') // double quotes → U+0022
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015]/g, "-") // dashes → U+002D
    .replace(/\u2026/g, "..."); // ellipsis → three dots
}

/**
 * Handles text matching algorithms for element search
 */
export class DefaultTextMatcher implements TextMatcher {
  /**
   * Perform partial text matching between two strings (substring containment)
   * @param text1 - First string to compare
   * @param text2 - Second string to compare
   * @param caseSensitive - Whether to use case-sensitive matching
   * @returns True if either string contains the other
   */
  partialTextMatch(text1: string, text2: string, caseSensitive: boolean = false): boolean {
    if (!text1 || !text2) {
      return false;
    }

    const str1 = caseSensitive ? normalizeQuotes(text1) : normalizeQuotes(text1).toLowerCase();
    const str2 = caseSensitive ? normalizeQuotes(text2) : normalizeQuotes(text2).toLowerCase();

    // Check if either string contains the other
    return str1.includes(str2) || str2.includes(str1);
  }

  /**
   * Create a text matching function based on options
   * @param text - Text to search for
   * @param partialMatch - Whether to use partial matching (substring containment)
   * @param caseSensitive - Whether to use case-sensitive matching
   * @returns A function that tests if an input string matches the search text
   */
  createTextMatcher(
    text: string,
    partialMatch: boolean = true,
    caseSensitive: boolean = false,
  ): (input?: string) => boolean {
    if (!text) {
      return () => false;
    }

    const searchText = caseSensitive ? normalizeQuotes(text) : normalizeQuotes(text).toLowerCase();

    return (input?: string): boolean => {
      if (!input) {
        return false;
      }

      const targetText = caseSensitive
        ? normalizeQuotes(input)
        : normalizeQuotes(input).toLowerCase();

      return partialMatch ? targetText.includes(searchText) : targetText === searchText;
    };
  }
}
