import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  prototypeSensitiveSinkErrors,
  prototypeSensitiveWarnings,
} from "../../../src/features/prototype/prototypeStrictPolicy";
import { validatePrototypeSpec } from "../../../src/features/prototype/prototypeValidation";

interface StateFixture {
  spec: unknown;
  options: { library: boolean };
  sinkOnly?: true;
  expectedPath?: string;
  expectedMessage?: string;
}

// Kept beside `library-sensitive/` until the Kotlin and Swift rules follow state copies (#16652);
// their runners read every file in the shared corpus.
const directory = join(import.meta.dir, "../../fixtures/prototype-spec/library-sensitive-state");
const files = readdirSync(directory)
  .filter((name) => name.endsWith(".json"))
  .sort();

describe("sensitive library fixtures routed through setState", () => {
  test("includes the setState copy regression", () => {
    expect(files).toContain("state-copy-to-data.json");
  });

  test.each(files)("%s", (name) => {
    const fixture = JSON.parse(readFileSync(join(directory, name), "utf8")) as StateFixture;
    expect(validatePrototypeSpec(fixture.spec).success).toBe(true);
    if (fixture.expectedPath === undefined) {
      expect(fixture.sinkOnly).toBe(true);
      expect(prototypeSensitiveSinkErrors(fixture.spec)).toEqual([]);
      expect(validatePrototypeSpec(fixture.spec, { library: true }).success).toBe(true);
      return;
    }
    const expected = { path: fixture.expectedPath, message: String(fixture.expectedMessage) };
    expect(fixture.options.library).toBe(true);
    expect(prototypeSensitiveSinkErrors(fixture.spec)).toEqual([expected]);
    expect(prototypeSensitiveWarnings(fixture.spec)).toEqual([
      `${fixture.expectedPath}: ${fixture.expectedMessage}; this is a warning only and does not block the show.`,
    ]);
    expect(validatePrototypeSpec(fixture.spec, fixture.options)).toEqual({
      success: false,
      error: expected,
    });
  });
});
