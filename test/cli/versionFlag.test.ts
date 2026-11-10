import { beforeAll, describe, expect, test } from "bun:test";
import ts from "typescript";
import { getGlobalVersionOutput, hasGlobalVersionFlag } from "../../src/cli/versionFlag";
import {
  runVersionEntrypoint,
  type VersionEntrypointDeps,
} from "../../src/startup/versionEntrypoint";
import { callsTo, dynamicImports, ifStatements, parseSource } from "../helpers/entrypointOrder";

describe("version flag", () => {
  for (const flag of ["--version", "-v"] as const) {
    test(`${flag} returns the package version for fast-path output`, () => {
      expect(getGlobalVersionOutput([flag], "1.2.3")).toBe("1.2.3");
    });
  }

  test("ignores version-like values after the CLI argument boundary", () => {
    expect(hasGlobalVersionFlag(["--cli", "sendKeys", "--commands", "-v"])).toBe(false);
    expect(hasGlobalVersionFlag(["--debug", "--cli", "sendKeys", "--commands", "--version"])).toBe(
      false,
    );
    expect(hasGlobalVersionFlag(["--version", "--cli", "doctor"])).toBe(true);
    expect(hasGlobalVersionFlag(["-v", "--cli", "doctor"])).toBe(true);
  });

  test("ignores version-like values after the daemon command boundary", () => {
    expect(hasGlobalVersionFlag(["--daemon", "status", "-v"])).toBe(false);
    expect(hasGlobalVersionFlag(["--debug", "--daemon", "status", "--version"])).toBe(false);
    expect(hasGlobalVersionFlag(["--version", "--daemon", "status"])).toBe(true);
    expect(hasGlobalVersionFlag(["-v", "--daemon", "status"])).toBe(true);
  });
});

let entrypoint: ts.SourceFile;
let versionEntrypoint: ts.SourceFile;
beforeAll(async () => {
  entrypoint = parseSource(await Bun.file("src/index.ts").text(), "index.ts");
  versionEntrypoint = parseSource(
    await Bun.file("src/startup/versionEntrypoint.ts").text(),
    "versionEntrypoint.ts",
  );
});

/** `await` expressions outside every function: a top-level await breaks cjs/compile builds. */
function topLevelAwaits(source: ts.SourceFile): string[] {
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node)) {
      return;
    }
    if (ts.isAwaitExpression(node) || (ts.isForOfStatement(node) && node.awaitModifier)) {
      found.push(node.getText(source));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** The version branch must dispatch to the fast path; the server entry loads only otherwise. */
function versionBranchViolations(source: ts.SourceFile): string[] {
  const branch = ifStatements(source, "hasGlobalVersionFlag(rawArgs)")[0];
  if (!branch) {
    return ["missing hasGlobalVersionFlag(rawArgs) branch"];
  }
  const violations: string[] = [];
  if (dynamicImports(branch.thenStatement, "./startup/versionEntrypoint").length !== 1) {
    violations.push("version branch must import ./startup/versionEntrypoint");
  }
  if (callsTo(branch.thenStatement, "runVersionEntrypoint", "rawArgs").length !== 1) {
    violations.push("version branch must run runVersionEntrypoint(rawArgs)");
  }
  if (dynamicImports(branch.thenStatement, "./startup/serverEntry").length > 0) {
    violations.push("version branch must not import ./startup/serverEntry");
  }
  if (
    !branch.elseStatement ||
    dynamicImports(branch.elseStatement, "./startup/serverEntry").length !== 1
  ) {
    violations.push("only the non-version branch imports ./startup/serverEntry");
  }
  return violations;
}

test("the entrypoint dispatches the version flag before loading the server entry", () => {
  expect(versionBranchViolations(entrypoint)).toEqual([]);
  expect(topLevelAwaits(entrypoint)).toEqual([]);
});

test("the entry guards fail on a top-level await or a server import in the version branch", () => {
  const source = entrypoint.getFullText();
  const awaited = parseSource(`${source}\nawait Promise.resolve();\n`);
  expect(topLevelAwaits(awaited)).toEqual(["await Promise.resolve()"]);
  const eager = source.replace(
    'import("./startup/versionEntrypoint")',
    'import("./startup/serverEntry").then(() => import("./startup/versionEntrypoint"))',
  );
  expect(eager).not.toBe(source);
  expect(versionBranchViolations(parseSource(eager))).toContain(
    "version branch must not import ./startup/serverEntry",
  );
});

// The default resolver is the same settled (dirty-aware) probe the old inline branch awaited;
// resolver behavior is exercised with GitMetadataClient fakes in mcpVersion.test.
test("the version entry resolves the settled version", () => {
  expect(callsTo(versionEntrypoint, "getSettledMcpServerVersion")).toHaveLength(1);
});

describe("runVersionEntrypoint", () => {
  function fakeDeps(version: string): { deps: VersionEntrypointDeps; calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      deps: {
        bootstrapEnvironment: () => calls.push("bootstrap"),
        resolveVersion: async () => {
          calls.push("resolve");
          return version;
        },
        log: (message) => calls.push(`log:${message}`),
        exit: (code) => calls.push(`exit:${code}`),
      },
    };
  }

  for (const flag of ["--version", "-v"] as const) {
    test(`${flag} bootstraps the environment, prints the settled version and exits 0`, async () => {
      const { deps, calls } = fakeDeps("1.2.3+gabc.dirty.def");
      await runVersionEntrypoint([flag], deps);
      expect(calls).toEqual(["bootstrap", "resolve", "log:1.2.3+gabc.dirty.def", "exit:0"]);
    });
  }
});
