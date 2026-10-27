import { beforeAll, describe, expect, test } from "bun:test";

import path from "node:path";
import { parseGuardSource, relativePosix, typeScriptFiles, readGuardFile } from "./astGuard";
import { bootAdmissionServicesInstalled } from "../../src/devices/bootAdmissionServices";
import { ctrlProxyManagerHostInstalled } from "../../src/ctrlProxy/ctrlProxyManagerHost";

/**
 * The devices tier boots through `BootAdmissionServices`, which is ungated until a composition
 * root installs the real gates, and the CtrlProxy manager fails loudly until its host is
 * installed. Every production process entry must import both wirings before any module that can
 * reach a boot or CtrlProxy path, or that process would boot ungated or fail device work.
 */
const ROOT = path.resolve(import.meta.dir, "../..");
const WIRINGS = ["./daemon/bootAdmissionWiring", "./daemon/ctrlProxyManagerHostWiring"];
// Imports allowed to precede the wiring: they never reach a boot path.
const BEFORE_WIRING = new Set([
  "./runtime/bunRuntimeGuard",
  "./daemon/processEntry",
  // Decorator metadata must initialise before anything else loads (see test/package/webrtcRuntimeMetadata).
  "./runtime/reflectMetadata",
]);

function importSpecifiersInOrder(file: string): string[] {
  const program = parseGuardSource(file, readGuardFile(file));
  return program.body.flatMap((node) =>
    node.type === "ImportDeclaration" ? [node.source.value] : [],
  );
}

describe("boot admission wiring at process entries", () => {
  test("src/index.ts is the only process entry in src/", () => {
    const entries = typeScriptFiles(path.join(ROOT, "src"))
      .filter((file) => readGuardFile(file).includes("import.meta.main"))
      .map((file) => relativePosix(ROOT, file));
    // A new entry must install the boot admission wiring and be added here deliberately.
    expect(entries).toEqual(["src/index.ts"]);
  });

  test("src/index.ts imports the wiring before any module that can boot a device", () => {
    const specifiers = importSpecifiersInOrder(path.join(ROOT, "src/index.ts"));
    const allowedBefore = new Set([...BEFORE_WIRING, ...WIRINGS]);
    for (const wiring of WIRINGS) {
      const wiringAt = specifiers.indexOf(wiring);
      expect(wiringAt, `${wiring} must be imported by src/index.ts`).toBeGreaterThanOrEqual(0);
      expect(specifiers.slice(0, wiringAt).every((spec) => allowedBefore.has(spec))).toBe(true);
    }
  });

  // Importing the wiring loads the shared gates, so it runs in the hook, not a 100 ms test.
  beforeAll(async () => {
    await import("../../src/daemon/bootAdmissionWiring");
    await import("../../src/daemon/ctrlProxyManagerHostWiring");
  });

  test("importing the wirings installs the real services", () => {
    expect(bootAdmissionServicesInstalled()).toBe(true);
    expect(ctrlProxyManagerHostInstalled()).toBe(true);
  });
});
