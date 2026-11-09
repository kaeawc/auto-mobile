import { beforeAll, describe, expect, test } from "bun:test";

import path from "node:path";
import ts from "typescript";
import { parseGuardSource, relativePosix, typeScriptFiles, readGuardFile } from "./astGuard";
import { dynamicImports, parseSource } from "../helpers/entrypointOrder";
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

// src/index.ts may additionally import this pure argv check: it decides between the two entries.
const INDEX_STATIC = new Set([...BEFORE_WIRING, "./cli/versionFlag"]);
// src/index.ts loads everything else lazily (#17684): the `--version` fast path, or the server
// entry, which imports the wirings first.
const INDEX_DYNAMIC = ["./startup/versionEntrypoint", "./startup/serverEntry"];
const SERVER_ENTRY_WIRINGS = WIRINGS.map((wiring) => wiring.replace("./", "../"));
// The version fast path never reaches a boot or CtrlProxy path, so it may run without the wirings.
const VERSION_ENTRY_IMPORTS = new Set([
  "../cli/versionFlag",
  "../utils/envBootstrap",
  "../utils/mcpVersion",
]);

function importSpecifiersInOrder(file: string, source = readGuardFile(file)): string[] {
  const program = parseGuardSource(file, source);
  return program.body.flatMap((node) =>
    node.type === "ImportDeclaration" ? [node.source.value] : [],
  );
}

function dynamicSpecifiers(source: string): string[] {
  return dynamicImports(parseSource(source)).map((call) => {
    const [arg] = call.arguments;
    return arg && ts.isStringLiteralLike(arg) ? arg.text : call.getText();
  });
}

/** Violations of the entry wiring contract, given the three entry sources. */
function entryWiringViolations(index: string, serverEntry: string, versionEntry: string): string[] {
  const violations: string[] = [];
  const indexFile = path.join(ROOT, "src/index.ts");
  for (const spec of importSpecifiersInOrder(indexFile, index)) {
    if (!INDEX_STATIC.has(spec)) {
      violations.push(`src/index.ts must not statically import ${spec}`);
    }
  }
  const indexDynamic = dynamicSpecifiers(index);
  if (JSON.stringify(indexDynamic) !== JSON.stringify(INDEX_DYNAMIC)) {
    violations.push(`src/index.ts dynamic imports are ${indexDynamic.join(", ")}`);
  }
  const serverSpecs = importSpecifiersInOrder(
    path.join(ROOT, "src/startup/serverEntry.ts"),
    serverEntry,
  );
  for (const wiring of SERVER_ENTRY_WIRINGS) {
    const wiringAt = serverSpecs.indexOf(wiring);
    if (wiringAt < 0) {
      violations.push(`${wiring} must be imported by src/startup/serverEntry.ts`);
    } else if (!serverSpecs.slice(0, wiringAt).every((s) => SERVER_ENTRY_WIRINGS.includes(s))) {
      violations.push(`${wiring} must precede every other src/startup/serverEntry.ts import`);
    }
  }
  const versionSpecs = [
    ...importSpecifiersInOrder(path.join(ROOT, "src/startup/versionEntrypoint.ts"), versionEntry),
    ...dynamicSpecifiers(versionEntry),
  ];
  for (const spec of versionSpecs) {
    if (!VERSION_ENTRY_IMPORTS.has(spec)) {
      violations.push(`src/startup/versionEntrypoint.ts must not import ${spec}`);
    }
  }
  return violations;
}

describe("boot admission wiring at process entries", () => {
  // Reading every file under src/ grows with the tree, so the scan runs in the hook (which the
  // 100 ms budget excludes) and the test only asserts on its result.
  let entries: string[] = [];
  beforeAll(() => {
    entries = typeScriptFiles(path.join(ROOT, "src"))
      .filter((file) => readGuardFile(file).includes("import.meta.main"))
      .map((file) => relativePosix(ROOT, file));
  });

  test("src/index.ts is the only process entry in src/", () => {
    // A new entry must install the boot admission wiring and be added here deliberately.
    expect(entries).toEqual(["src/index.ts"]);
  });

  let sources: [string, string, string] = ["", "", ""];
  beforeAll(() => {
    sources = [
      readGuardFile(path.join(ROOT, "src/index.ts")),
      readGuardFile(path.join(ROOT, "src/startup/serverEntry.ts")),
      readGuardFile(path.join(ROOT, "src/startup/versionEntrypoint.ts")),
    ];
  });

  test("every server path imports the wiring before any module that can boot a device", () => {
    expect(entryWiringViolations(...sources)).toEqual([]);
  });

  test("the wiring guard fails on an eager index import, a late wiring or a heavy version path", () => {
    const [index, serverEntry, versionEntry] = sources;
    const eager = index.replace(
      'import { hasGlobalVersionFlag } from "./cli/versionFlag";',
      'import { hasGlobalVersionFlag } from "./cli/versionFlag";\nimport "./startup/runStartup";',
    );
    expect(eager).not.toBe(index);
    expect(entryWiringViolations(eager, serverEntry, versionEntry)).toContain(
      "src/index.ts must not statically import ./startup/runStartup",
    );
    const late = serverEntry.replace(
      'import "../daemon/ctrlProxyManagerHostWiring";',
      'import "../utils/logger";\nimport "../daemon/ctrlProxyManagerHostWiring";',
    );
    expect(late).not.toBe(serverEntry);
    expect(entryWiringViolations(index, late, versionEntry)).toContain(
      "../daemon/ctrlProxyManagerHostWiring must precede every other src/startup/serverEntry.ts import",
    );
    const heavy = `${versionEntry}\nexport const lazy = () => import("../server");\n`;
    expect(entryWiringViolations(index, serverEntry, heavy)).toContain(
      "src/startup/versionEntrypoint.ts must not import ../server",
    );
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
