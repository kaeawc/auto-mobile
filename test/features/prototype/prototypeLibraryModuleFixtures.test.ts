import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { validatePrototypeSpec } from "../../../src/features/prototype/prototypeValidation";

/** R1 fixtures shared with the Kotlin validator: a library spec uses no sensitive module. */
interface LibraryModuleFixture {
  spec: unknown;
  options: { library: true };
  expectedPath?: string;
  expectedMessage?: string;
}

const directory = join(import.meta.dir, "../../fixtures/prototype-spec/library-modules");
const files = readdirSync(directory)
  .filter((name) => name.endsWith(".json"))
  .sort();

describe("shared library module fixtures", () => {
  test("cover refused calls, a refused handler and accepted modules", () => {
    expect(files.filter((name) => name.startsWith("valid-"))).toHaveLength(3);
    expect(files.filter((name) => !name.startsWith("valid-"))).toHaveLength(4);
  });

  test.each(files)("%s", (name) => {
    const fixture = JSON.parse(readFileSync(join(directory, name), "utf8")) as LibraryModuleFixture;
    expect(fixture.options).toEqual({ library: true });
    expect(fixture.expectedPath === undefined).toBe(name.startsWith("valid-"));
    expect(validatePrototypeSpec(fixture.spec).success).toBe(true);
    expect(validatePrototypeSpec(fixture.spec, { library: false }).success).toBe(true);
    expect(validatePrototypeSpec(fixture.spec, fixture.options)).toEqual(
      fixture.expectedPath === undefined
        ? expect.objectContaining({ success: true })
        : {
            success: false,
            error: { path: fixture.expectedPath, message: fixture.expectedMessage },
          },
    );
  });
});
