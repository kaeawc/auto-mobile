import { readFileSync, writeFileSync } from "node:fs";

export const prototypePluralLanguages =
  "ja zh ko vi th id ms lo km my en de nl sv da nb no fi it es el hu tr bg ca et eu sw ur fr pt hi bn fa gu kn am ru uk be pl cs sk ar".split(
    " ",
  );
export function pluralCategoriesFixture(): string {
  const counts = [...Array.from({ length: 121 }, (_, n) => n), 1000, 1001, 1002, 1011, 1012];
  return (
    JSON.stringify(
      Object.fromEntries(
        prototypePluralLanguages.map((language) => {
          const rules = new Intl.PluralRules(language);
          return [language, counts.map((n) => ({ n, category: rules.select(n) }))];
        }),
      ),
      null,
      2,
    ) + "\n"
  );
}
if (import.meta.main) {
  const path = new URL(
    "../../test/fixtures/prototype-spec/strings/plural-categories.json",
    import.meta.url,
  );
  const expected = pluralCategoriesFixture();
  if (process.argv.includes("--check")) {
    if (readFileSync(path, "utf8") !== expected) {
      throw new Error("Plural categories fixture is stale");
    }
    console.log("Plural categories fixture is current");
  } else {
    writeFileSync(path, expected);
    console.log("Generated plural categories fixture");
  }
}
