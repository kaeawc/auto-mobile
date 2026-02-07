import type { TextMatcher } from "../../src/utils/interfaces/TextMatcher";

export class FakeTextMatcher implements TextMatcher {
  nextFuzzyResult: boolean = false;
  nextMatcherResult: boolean = false;

  fuzzyTextMatch(_text1: string, _text2: string, _caseSensitive?: boolean): boolean {
    return this.nextFuzzyResult;
  }

  createTextMatcher(_text: string, _fuzzyMatch?: boolean, _caseSensitive?: boolean): (input?: string) => boolean {
    const result = this.nextMatcherResult;
    return () => result;
  }
}
