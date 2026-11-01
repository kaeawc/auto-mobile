import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { prototypeSensitiveSinkErrors } from "../../../src/features/prototype/prototypeStrictPolicy";
import { validatePrototypeSpec } from "../../../src/features/prototype/prototypeValidation";

const directory = join(import.meta.dir, "../../fixtures/prototype-spec/library-sensitive");
const files = readdirSync(directory)
  .filter((name) => name.endsWith(".json"))
  .sort();

describe("shared sensitive library fixtures", () => {
  test.each(files)("%s", (name) => {
    const fixture = JSON.parse(readFileSync(join(directory, name), "utf8")) as {
      spec: unknown;
      options: { library: boolean };
      sinkOnly?: boolean;
      expectedPath?: string;
      expectedMessage?: string;
    };
    expect(fixture.options.library).toBe(fixture.expectedPath !== undefined);
    expect(fixture.sinkOnly).toBe(fixture.expectedPath === undefined ? true : undefined);
    expect(validatePrototypeSpec(fixture.spec).success).toBe(true);
    expect(prototypeSensitiveSinkErrors(fixture.spec)).toEqual(
      fixture.expectedPath
        ? [{ path: fixture.expectedPath, message: fixture.expectedMessage }]
        : [],
    );
    if (!fixture.sinkOnly) {
      expect(validatePrototypeSpec(fixture.spec, fixture.options)).toEqual({
        success: false,
        error: { path: fixture.expectedPath, message: fixture.expectedMessage },
      });
    }
  });
});
