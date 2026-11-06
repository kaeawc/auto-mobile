import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  prototypeSensitiveSinkErrors,
  prototypeSensitiveWarnings,
} from "../../../src/features/prototype/prototypeStrictPolicy";
import { validatePrototypeSpec } from "../../../src/features/prototype/prototypeValidation";

interface SensitiveFixture {
  spec: unknown;
  options: { library: boolean };
}

interface RefusedFixture extends SensitiveFixture {
  sinkOnly?: never;
  expectedPath: string;
  expectedMessage: string;
}

interface SinkOnlyFixture extends SensitiveFixture {
  sinkOnly: true;
  expectedPath?: never;
  expectedMessage?: never;
}

const directory = join(import.meta.dir, "../../fixtures/prototype-spec/library-sensitive");
const files = readdirSync(directory)
  .filter((name) => name.endsWith(".json"))
  .sort();

describe("shared sensitive library fixtures", () => {
  test("includes the repeat item copy regression", () => {
    expect(files).toContain("repeat-item-copy.json");
  });

  test.each(files)("%s", (name) => {
    const fixture = JSON.parse(readFileSync(join(directory, name), "utf8")) as
      | RefusedFixture
      | SinkOnlyFixture;
    expect(fixture.options.library).toBe(fixture.expectedPath !== undefined);
    expect(fixture.sinkOnly).toBe(fixture.expectedPath === undefined ? true : undefined);
    expect(validatePrototypeSpec(fixture.spec).success).toBe(true);
    expect(prototypeSensitiveSinkErrors(fixture.spec)).toEqual(
      fixture.expectedPath !== undefined
        ? [{ path: fixture.expectedPath, message: fixture.expectedMessage }]
        : [],
    );
    if (!fixture.sinkOnly) {
      expect(prototypeSensitiveWarnings(fixture.spec)).toEqual([
        `${fixture.expectedPath}: ${fixture.expectedMessage}; this is a warning only and does not block the show.`,
      ]);
      expect(validatePrototypeSpec(fixture.spec, fixture.options)).toEqual({
        success: false,
        error: {
          path: fixture.expectedPath,
          message: fixture.expectedMessage,
        },
      });
    } else if (name.startsWith("platform-")) {
      expect(validatePrototypeSpec(fixture.spec, { library: true }).success).toBe(true);
    }
  });
});
