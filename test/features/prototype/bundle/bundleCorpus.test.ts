import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  BUNDLE_ERROR_CODES,
  PrototypeBundleError,
  readPrototypeBundle,
} from "../../../../src/features/prototype/bundle";
import {
  materializeBundleRecipe,
  recipeName,
  type BundleRecipe,
} from "../../../helpers/prototypeBundleRecipe";

const root = join(import.meta.dir, "../../../fixtures/prototype-bundle");
const recipes = ["valid", "invalid"].flatMap((directory) =>
  readdirSync(join(root, directory))
    .sort()
    .map((name) => ({
      name: `${directory}/${name}`,
      recipe: JSON.parse(readFileSync(join(root, directory, name), "utf8")) as BundleRecipe,
    })),
);

describe("language-neutral prototype bundle corpus", () => {
  for (const { name, recipe } of recipes) {
    test(name, () => {
      const bytes = materializeBundleRecipe(recipe);
      if (recipe.expected === "accept") {
        expect(readPrototypeBundle(bytes, recipe.limits).manifest.bundleFormatVersion).toBe(1);
        return;
      }
      let failure: unknown;
      try {
        readPrototypeBundle(bytes, recipe.limits);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(PrototypeBundleError);
      if (!(failure instanceof PrototypeBundleError)) {
        throw new Error("Expected typed bundle failure");
      }
      expect({ code: failure.code, entry: failure.entry }).toEqual({
        code: recipe.expected.code,
        entry: recipe.expected.entry === undefined ? undefined : recipeName(recipe.expected.entry),
      });
    });
  }
  test("every closed rejection code has a portable recipe", () => {
    const covered = new Set(
      recipes.flatMap(({ recipe }) => (recipe.expected === "accept" ? [] : [recipe.expected.code])),
    );
    expect([...covered].sort()).toEqual([...BUNDLE_ERROR_CODES].sort());
  });
});
