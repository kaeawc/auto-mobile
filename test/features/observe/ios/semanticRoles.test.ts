import { describe, expect, test } from "bun:test";
import { hasIosHeaderTrait } from "../../../../src/features/observe/ios/semanticRoles";

/**
 * PARAM-3 (issue #4174, item 9): `hasIosHeaderTrait` parses the runner's
 * comma-separated `sdk.accessibilityTraits` string and reports whether the
 * exact token `header` is present. A miss here silently drops the heading role
 * for VoiceOver users; a false positive mis-labels ordinary controls.
 *
 * The implementation is `split(",").some(t => t.trim() === "header")`, so the
 * boundary rows below (case sensitivity, substring look-alikes, a Cyrillic
 * homoglyph, whitespace, non-string/absent traits) are the real specification.
 */
describe("hasIosHeaderTrait", () => {
  interface Row {
    name: string;
    extras: unknown;
    expected: boolean;
  }

  const traits = (value: unknown): Record<string, unknown> => ({
    "sdk.accessibilityTraits": value,
  });

  const rows: Row[] = [
    // --- positive: exact token present, possibly among others / padded ---
    { name: "the sole trait is header", extras: traits("header"), expected: true },
    {
      name: "header is the first of several traits",
      extras: traits("header,button"),
      expected: true,
    },
    {
      name: "header is the last of several traits",
      extras: traits("button,header"),
      expected: true,
    },
    {
      name: "header sits in the middle of the list",
      extras: traits("button,header,image"),
      expected: true,
    },
    {
      name: "header has surrounding spaces after the split",
      extras: traits("button, header"),
      expected: true,
    },
    { name: "the whole value is padded with spaces", extras: traits("  header  "), expected: true },
    {
      name: "header appears with tab/space padding among traits",
      extras: traits("staticText,\theader\t"),
      expected: true,
    },
    {
      name: "a duplicated header token still matches",
      extras: traits("header,header"),
      expected: true,
    },

    // --- negative: look-alikes that must NOT match the exact token ---
    {
      name: "headerish is a superstring, not the token",
      extras: traits("headerish"),
      expected: false,
    },
    {
      name: "subheader is a substring, not the token",
      extras: traits("subheader"),
      expected: false,
    },
    {
      name: "Header differs by case (exact, case-sensitive)",
      extras: traits("Header"),
      expected: false,
    },
    { name: "HEADER differs by case", extras: traits("HEADER"), expected: false },
    {
      name: "a Cyrillic-homoglyph header is not the ASCII token",
      extras: traits("һeader"),
      expected: false,
    },
    { name: "head is a prefix, not the token", extras: traits("head"), expected: false },
    {
      name: "header embedded without a comma boundary does not match",
      extras: traits("myheader"),
      expected: false,
    },
    {
      name: "an unrelated trait list has no header",
      extras: traits("button,staticText,image"),
      expected: false,
    },
    { name: "an empty trait string matches nothing", extras: traits(""), expected: false },
    { name: "a lone comma yields only empty tokens", extras: traits(","), expected: false },

    // --- negative: the trait value is not a usable string ---
    { name: "traits is a number, not a string", extras: traits(42), expected: false },
    { name: "traits is null", extras: traits(null), expected: false },
    {
      name: "traits is an array (not the parsed string)",
      extras: traits(["header"]),
      expected: false,
    },
    { name: "the traits key is absent from extras", extras: { other: "header" }, expected: false },

    // --- negative: extras itself is not an object ---
    { name: "extras is null", extras: null, expected: false },
    { name: "extras is undefined", extras: undefined, expected: false },
    { name: "extras is a bare string", extras: "header", expected: false },
  ];

  for (const row of rows) {
    test(`returns ${row.expected} when ${row.name}`, () => {
      expect(hasIosHeaderTrait(row.extras)).toBe(row.expected);
    });
  }
});
