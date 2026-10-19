import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseGuardSource, relativePosix, typeScriptFiles } from "./astGuard";
import { bootAdmissionServicesInstalled } from "../../src/devices/bootAdmissionServices";

/**
 * The devices tier boots through `BootAdmissionServices`, which is ungated until a composition
 * root installs the real gates. Every production process entry must import the wiring before any
 * module that can reach a boot path, or that process would boot devices without admission gates.
 */
const ROOT = path.resolve(import.meta.dir, "../..");
const WIRING = "./daemon/bootAdmissionWiring";
// Imports allowed to precede the wiring: they never reach a boot path.
const BEFORE_WIRING = new Set(["./runtime/bunRuntimeGuard", "./daemon/processEntry"]);

function importSpecifiersInOrder(file: string): string[] {
  const program = parseGuardSource(file, readFileSync(file, "utf8"));
  return program.body.flatMap((node) =>
    node.type === "ImportDeclaration" ? [node.source.value] : [],
  );
}

describe("boot admission wiring at process entries", () => {
  test("src/index.ts is the only process entry in src/", () => {
    const entries = typeScriptFiles(path.join(ROOT, "src"))
      .filter((file) => readFileSync(file, "utf8").includes("import.meta.main"))
      .map((file) => relativePosix(ROOT, file));
    // A new entry must install the boot admission wiring and be added here deliberately.
    expect(entries).toEqual(["src/index.ts"]);
  });

  test("src/index.ts imports the wiring before any module that can boot a device", () => {
    const specifiers = importSpecifiersInOrder(path.join(ROOT, "src/index.ts"));
    const wiringAt = specifiers.indexOf(WIRING);
    expect(wiringAt).toBeGreaterThanOrEqual(0);
    expect(specifiers.slice(0, wiringAt).every((spec) => BEFORE_WIRING.has(spec))).toBe(true);
  });

  // Importing the wiring loads the shared gates, so it runs in the hook, not a 100 ms test.
  beforeAll(async () => {
    await import("../../src/daemon/bootAdmissionWiring");
  });

  test("importing the wiring installs the real gates", () => {
    expect(bootAdmissionServicesInstalled()).toBe(true);
  });
});
