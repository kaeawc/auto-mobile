import { mapBindableFields } from "../../../src/features/prototype/prototypeTemplate";
import { bindPrototypeDataText } from "../../../src/features/prototype/prototypeData";
import { expect, test } from "bun:test";
import {
  prototypeLocaleChain,
  prototypePluralCategory,
  resolvePrototypeStringsText,
} from "../../../src/features/prototype/prototypeStrings";

test("locale chain normalizes tags and deduplicates prefixes", () => {
  expect(prototypeLocaleChain(["pt_BR", "PT"])).toEqual(["pt-br", "pt", "default"]);
});
test("translations preserve state bindings and resolve data counts", () => {
  expect(
    resolvePrototypeStringsText(
      { default: { x: { one: "{#} {name}", other: "{#} items" } } },
      ["en"],
      "{t:x|{data:/n}}",
      { n: 1 },
    ),
  ).toBe("1 {name}");
  expect(prototypePluralCategory("ar", 2)).toBe("two");
});

import { readFileSync, readdirSync } from "node:fs";
import type { PrototypeStrings } from "../../../src/features/prototype/prototypeStrings";
const resolveCases: {
  name: string;
  strings: PrototypeStrings;
  locales: string[];
  text: string;
  data?: unknown;
  expected: string;
}[] = JSON.parse(
  readFileSync(
    new URL("../../fixtures/prototype-spec/strings/resolve.json", import.meta.url),
    "utf8",
  ),
);
const pluralCases: Record<string, { n: number; category: Intl.LDMLPluralRule }[]> = JSON.parse(
  readFileSync(
    new URL("../../fixtures/prototype-spec/strings/plural-categories.json", import.meta.url),
    "utf8",
  ),
);
import { validatePrototypeSpec } from "../../../src/features/prototype/prototypeValidation";
import {
  prototypeStringsFields,
  prototypeSemanticsFields,
  resolvePrototypeStrings,
} from "../../../src/features/prototype/prototypeStrings";

for (const fixture of resolveCases) {
  test(`resolve: ${fixture.name}`, () => {
    expect(
      resolvePrototypeStringsText(fixture.strings, fixture.locales, fixture.text, fixture.data),
    ).toBe(fixture.expected);
  });
}
for (const [language, cases] of Object.entries(pluralCases)) {
  test(`integer plurals match Intl: ${language}`, () => {
    const intl = new Intl.PluralRules(language);
    for (const { n, category } of cases) {
      expect(intl.select(n)).toBe(category);
      expect(prototypePluralCategory(language, n)).toBe(category);
    }
  });
}
const invalidDir = new URL("../../fixtures/prototype-spec/invalid/", import.meta.url);
for (const name of readdirSync(invalidDir).filter(
  (name) => name.startsWith("strings-") || name.startsWith("semantics-"),
)) {
  const fixture = JSON.parse(readFileSync(new URL(name, invalidDir), "utf8"));
  test(`validation: ${name}`, () => {
    expect(validatePrototypeSpec(fixture.spec)).toEqual({
      success: false,
      error: { path: fixture.expectedPath, message: fixture.expectedMessage },
    });
  });
}
test("whole spec transforms display strings and preserves opaque tables and input", () => {
  const spec = {
    strings: { default: { title: "Hello {name}" } },
    root: {
      type: "text",
      spans: [{ text: "{t:title}" }],
      semantics: { label: "{t:title}", hint: "{t:title}" },
      contentDescription: "literal",
      onTap: [{ payload: { text: "{t:title}" } }],
    },
  };
  const result = resolvePrototypeStrings(spec, ["en"]);
  expect(result.root.spans[0]?.text).toBe("Hello {name}");
  expect(result.root.semantics.label).toBe("Hello {name}");
  expect(result.root.onTap[0]?.payload.text).toBe("{t:title}");
  expect(result.strings).toEqual(spec.strings);
  expect(spec.root.semantics.label).toBe("{t:title}");
  expect(prototypeStringsFields(spec)).toEqual([
    "strings",
    "root.spans[0].text",
    "root.semantics.label",
    "root.semantics.hint",
  ]);
  expect(prototypeSemanticsFields(spec)).toEqual(["root.semantics"]);
});
test("invalid runtime counts select other and unknown languages use English", () => {
  for (const n of [-1, 1.5, NaN, Infinity]) {
    expect(prototypePluralCategory("ar", n)).toBe("other");
  }
  expect(prototypePluralCategory("xx", 1)).toBe("one");
});

test("data substitution and translation commute for numeric and invalid numeric counts", () => {
  const strings = { default: { x: { one: "one", other: "other" } } };
  for (const n of [0, 1, 2, -1, 1.5]) {
    expect(resolvePrototypeStringsText(strings, ["en"], "{t:x|{data:/n}}", { n })).toBe(
      resolvePrototypeStringsText(strings, ["en"], `{t:x|${n}}`),
    );
  }
  expect(resolvePrototypeStringsText(strings, ["en"], "{t:x|{data:/n}}", { n: "1" })).toBe("one");
});

test("translation output is never scanned for translations again", () => {
  expect(resolvePrototypeStringsText({ default: { x: "{t:y}", y: "wrong" } }, [], "{t:x}")).toBe(
    "{t:y}",
  );
});

test("semantics participate in data binding validation and strings remain opaque", () => {
  const base = {
    id: "s",
    window: { placement: { type: "fullscreen" } },
    strings: { default: { title: "{name}" } },
    root: {
      type: "text",
      text: "{t:title}",
      semantics: { label: "{data:/title}", hint: "{t:title}" },
    },
    data: { title: "Hello" },
  };
  expect(validatePrototypeSpec(base).success).toBe(true);
  expect(validatePrototypeSpec({ ...base, data: {} }).success).toBe(true);
  const bound = mapBindableFields(base.root, "root", (value, _path, kind) =>
    kind === "text" && typeof value === "string"
      ? bindPrototypeDataText(value, () => "Hello")
      : value,
  );
  expect(bound.semantics).toEqual({ label: "Hello", hint: "{t:title}" });
});

test("translation boundaries and optional plural shape differences are accepted", () => {
  const spec = {
    id: "s",
    window: { placement: { type: "fullscreen" } },
    root: { type: "text", text: "{t:title}" },
    strings: {
      default: { title: "x".repeat(2048) },
      fr: { title: { other: "Autres" }, extra: "Allowed" },
    },
  };
  expect(validatePrototypeSpec(spec).success).toBe(true);
  expect(resolvePrototypeStrings(spec, ["fr"]).root.text).toBe("Autres");
});

import { prototypeRequiredPluralCategories } from "../../../src/features/prototype/prototypeStrings";
test("required plural forms match integer Intl categories plus mandatory other", () => {
  for (const language of "ja zh ko vi th id ms lo km my en de nl sv da nb no fi it es el hu tr bg ca et eu sw ur fr pt hi bn fa gu kn am ru uk be pl cs sk ar".split(
    " ",
  )) {
    const rules = new Intl.PluralRules(language);
    const expected = new Set<Intl.LDMLPluralRule>([
      ...Array.from({ length: 121 }, (_, n) => rules.select(n)),
      "other",
    ]);
    expect(new Set(prototypeRequiredPluralCategories(language))).toEqual(expected);
  }
  expect(prototypeRequiredPluralCategories("zz-ZZ")).toEqual(["other", "one"]);
});
