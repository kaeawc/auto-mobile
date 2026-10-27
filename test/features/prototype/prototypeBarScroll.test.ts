import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { validatePrototypeSpec } from "../../../src/features/prototype/prototypeValidation";
import { prototypeBarScrollFields } from "../../../src/features/prototype/prototypeBarScroll";
import corpus from "../../fixtures/prototype-spec/corpus.json";

describe("Material bar scroll contract", () => {
  for (const kind of ["valid", "invalid"] as const) {
    for (const name of corpus[kind].filter((name) => name.startsWith("bar-scroll-"))) {
      const fixture = JSON.parse(
        readFileSync(
          new URL(`../../fixtures/prototype-spec/${kind}/${name}`, import.meta.url),
          "utf8",
        ),
      );
      test(`${kind}: ${name}`, () => {
        const result = validatePrototypeSpec(kind === "valid" ? fixture : fixture.spec);
        if (kind === "valid") {
          expect(result.success).toBe(true);
        } else {
          expect(result).toMatchObject({ success: false, error: { path: fixture.expectedPath } });
        }
      });
    }
  }
  test("capability scan includes explicit defaults and reusable component roots", () => {
    expect(
      prototypeBarScrollFields({
        root: { type: "topAppBar", onScroll: "pinned" },
        components: { bar: { root: { type: "bottomNav", scroll: "feed", onScroll: "none" } } },
      }),
    ).toEqual(["root.onScroll", "components.bar.root.onScroll", "components.bar.root.scroll"]);
  });
});
