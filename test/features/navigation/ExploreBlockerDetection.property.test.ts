import { describe, test } from "bun:test";
import fc from "fast-check";
import type { Element } from "../../../src/models";
import {
  ALLOW_KEYWORDS,
  DENY_KEYWORDS,
  PERMISSION_KEYWORDS,
  containsTokenSequence,
  filterPermissionNavigationCandidates,
  isAffirmativeGrantElement,
  isPermissionDenyElement,
  matchesAnyKeywordInAnyField,
  tokenize,
} from "../../../src/features/navigation/ExploreBlockerDetection";

const RUN_OPTIONS = { seed: 6_486, numRuns: 100 } as const;
const separators = fc.constantFrom(" ", "_", "'", "-");
const shortWord = fc.string({
  unit: fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz"),
  minLength: 1,
  maxLength: 5,
});
const labelContainingPhrase = (phrase: string): fc.Arbitrary<string> =>
  fc
    .tuple(shortWord, separators, separators, shortWord)
    .map(([left, before, after, right]) => `${left}${before}${phrase}${after}${right}`);

const element = (text?: string, description?: string): Element => ({
  bounds: { left: 0, top: 0, right: 10, bottom: 10 },
  text,
  "content-desc": description,
});
const tokenLists = (keywords: string[]) => keywords.map((keyword) => tokenize(keyword));
const allKeywords = [...PERMISSION_KEYWORDS, ...ALLOW_KEYWORDS, ...DENY_KEYWORDS];
const singleTokens = [...new Set(allKeywords.flatMap((keyword) => tokenize(keyword)))];

describe("ExploreBlockerDetection permission properties", () => {
  test("deny phrases dominate affirmative grants", () => {
    fc.assert(
      fc.property(
        fc
          .constantFrom(...DENY_KEYWORDS)
          .chain((deny) =>
            fc
              .constantFrom(...ALLOW_KEYWORDS)
              .chain((allow) => labelContainingPhrase(`${deny} ${allow}`)),
          ),
        (label) => !isAffirmativeGrantElement(element(label)),
      ),
      RUN_OPTIONS,
    );
  });

  test("strict token substrings never hit keyword matching", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...singleTokens),
        shortWord,
        shortWord,
        (keyword, prefix, suffix) => {
          const longer = `${prefix}${keyword}${suffix}`;
          return !matchesAnyKeywordInAnyField(tokenLists(allKeywords), element(longer));
        },
      ),
      RUN_OPTIONS,
    );
  });

  test("multiword phrases cannot be manufactured across accessibility fields", () => {
    const phrases = [...new Set(allKeywords.filter((keyword) => tokenize(keyword).length > 1))];
    fc.assert(
      fc.property(fc.constantFrom(...phrases), (phrase) => {
        const tokens = tokenize(phrase);
        const split = Math.floor(tokens.length / 2);
        const left = tokens.slice(0, split);
        const right = tokens.slice(split);
        const phraseTokens = tokenize(phrase);
        return (
          !containsTokenSequence(left, phraseTokens) &&
          !containsTokenSequence(right, phraseTokens) &&
          !matchesAnyKeywordInAnyField([phraseTokens], element(left.join(" "), right.join(" ")))
        );
      }),
      RUN_OPTIONS,
    );
  });

  test("tokenization is idempotent and normalizes identifier spellings", () => {
    fc.assert(
      fc.property(shortWord, shortWord, (first, second) => {
        const tokens = tokenize(`${first} ${second}`);
        const normalized = tokenize(tokens.join(" "));
        const variants = ["ok_button", "okButton", "OKButton", "OK Button"].map((s) => tokenize(s));
        return (
          JSON.stringify(normalized) === JSON.stringify(tokens) &&
          variants.every((tokens) => JSON.stringify(tokens) === JSON.stringify(["ok", "button"]))
        );
      }),
      RUN_OPTIONS,
    );
  });

  test("permission candidate filtering removes deny elements only on confirmed permission screens", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...DENY_KEYWORDS),
        fc.constantFrom(...ALLOW_KEYWORDS),
        (deny, allow) => {
          const denied = element(`${deny} ${allow}`);
          const candidates = [denied, element(allow)];
          const filtered = filterPermissionNavigationCandidates(candidates, [
            element("Only this time"),
          ]);
          const ordinary = filterPermissionNavigationCandidates(candidates, [element("Settings")]);
          return (
            filtered.every((candidate) => !isPermissionDenyElement(candidate)) &&
            ordinary === candidates
          );
        },
      ),
      RUN_OPTIONS,
    );
  });
});
