import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import corpus from "../../fixtures/prototype-spec/corpus.json";
import { prototypeSpecSchema } from "../../../src/features/prototype/prototypeSpec";
import { prototypePlatformNotes } from "../../../src/features/prototype/prototypePlatformNotes";

for (const [name, expected] of Object.entries(corpus.validPlatformNotes)) {
  test(`shared foreign namespace notes ${name}`, () => {
    const spec = prototypeSpecSchema.parse(
      JSON.parse(
        readFileSync(join(import.meta.dir, "../../fixtures/prototype-spec/valid", name), "utf8"),
      ),
    );
    const platform = expected.platform === "ios" ? "ios" : "android";
    expect(
      prototypePlatformNotes(spec, platform, () => true).some(
        (note) =>
          note.construct === "platformNamespace" &&
          note.effect === "ignored" &&
          JSON.stringify(note.paths) === JSON.stringify(expected.paths),
      ),
    ).toBe(true);
  });
}
