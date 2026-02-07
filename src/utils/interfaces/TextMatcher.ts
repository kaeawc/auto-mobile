export interface TextMatcher {
  fuzzyTextMatch(text1: string, text2: string, caseSensitive?: boolean): boolean;
  createTextMatcher(text: string, fuzzyMatch?: boolean, caseSensitive?: boolean): (input?: string) => boolean;
}
