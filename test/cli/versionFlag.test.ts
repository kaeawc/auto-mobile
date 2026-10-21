import { beforeAll, describe, expect, test } from "bun:test";
import ts from "typescript";
import { getGlobalVersionOutput, hasGlobalVersionFlag } from "../../src/cli/versionFlag";

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

let entrypoint: import("typescript").SourceFile;
beforeAll(async () => {
  entrypoint = ts.createSourceFile(
    "index.ts",
    await Bun.file("src/index.ts").text(),
    ts.ScriptTarget.Latest,
    true,
  );
});

// Verify the real entrypoint keeps settlement inside the version-only branch;
// resolver behavior is exercised with GitMetadataClient fakes in mcpVersion.test.
test("entrypoint awaits the refined version only for the global version flag", () => {
  const source = entrypoint;
  const branch = source.statements.find(
    (node): node is import("typescript").IfStatement =>
      ts.isIfStatement(node) &&
      ts.isCallExpression(node.expression) &&
      node.expression.expression.getText(source) === "hasGlobalVersionFlag",
  );
  expect(branch).toBeDefined();
  if (!branch) {
    return;
  }
  const awaited: string[] = [];
  const visit = (node: import("typescript").Node): void => {
    if (ts.isAwaitExpression(node)) {
      awaited.push(node.expression.getText(source));
    }
    ts.forEachChild(node, visit);
  };
  visit(branch.thenStatement);
  expect(awaited).toContain("getSettledMcpServerVersion()");
  expect(branch.thenStatement.getText(source)).toContain("getGlobalVersionOutput(");
  expect(branch.thenStatement.getText(source)).toContain("process.exit(0)");
});
