import { describe, expect, test } from "bun:test";
import { BOUNDARY_ROWS } from "../../scripts/lib/boundaryRows";
import {
  type BoundaryRow,
  parseUnifiedDiff,
  renderBoundaryResult,
  scanBoundary,
} from "../../scripts/lib/boundaryScanner";

function row(id: string): BoundaryRow {
  const found = BOUNDARY_ROWS.find((candidate) => candidate.id === id);
  if (!found) {
    throw new Error(`missing row ${id}`);
  }
  return found;
}

function addedFile(path: string, lines: readonly string[]) {
  return {
    path,
    addedLines: new Set(lines.map((_, index) => index + 1)),
    source: lines.join("\n"),
  };
}

function scan(id: string, files: ReturnType<typeof addedFile>[]) {
  const sources = new Map(files.map((file) => [file.path, file.source]));
  return scanBoundary(row(id), files, { readSource: (path) => sources.get(path) });
}

describe("parseUnifiedDiff", () => {
  const diff = [
    "diff --git a/src/a.ts b/src/a.ts",
    "index 1..2 100644",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,2 +1,4 @@",
    " keep",
    "+added one",
    "-removed",
    "+added two",
    " tail",
    "diff --git a/src/gone.ts b/src/gone.ts",
    "--- a/src/gone.ts",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-x",
    "diff --git a/src/b.ts b/src/b.ts",
    "--- a/src/b.ts",
    "+++ b/src/b.ts",
    "@@ -5,0 +6,1 @@",
    "+only",
  ].join("\n");

  test("tracks new-side added line numbers and drops deleted files", () => {
    const files = parseUnifiedDiff(diff);

    expect(files.map((file) => file.path)).toEqual(["src/a.ts", "src/b.ts"]);
    expect([...files[0]!.addedLines]).toEqual([2, 3]);
    expect([...files[1]!.addedLines]).toEqual([6]);
  });

  test("does not mistake an added line starting with ++ for a file header", () => {
    const files = parseUnifiedDiff(
      ["diff --git a/src/c.ts b/src/c.ts", "@@ -0,0 +1,1 @@", "+++ counter"].join("\n"),
    );

    expect([...files[0]!.addedLines]).toEqual([1]);
  });
});

describe("security row", () => {
  test.each([
    'execFile("security", ["find-identity"]);',
    "execFileSync(`security`, []);",
    'execSync("security cms -D");',
    'execFile("/usr/bin/security", []);',
    'execFile(/* signing */ "security", []);',
    'Bun.spawn(["security", "find-identity"]);',
  ])("flags %s", (line) => {
    expect(scan("security", [addedFile("src/x.ts", [line])])).toHaveLength(1);
  });

  test("flags a multiline call once per file", () => {
    const lines = ["execFile(", '  "security",', "  [],", ");"];

    expect(scan("security", [addedFile("src/x.ts", lines)])).toHaveLength(1);
  });

  test("ignores the owner and unrelated strings", () => {
    const owner = addedFile("src/utils/ios-cmdline-tools/SecurityClient.ts", [
      'execFile("security", []);',
    ]);
    const unrelated = addedFile("src/y.ts", ['const a = "securityLevel";']);

    expect(scan("security", [owner, unrelated])).toEqual([]);
  });

  test("ratchets: a hit on a line not added in the diff is tolerated", () => {
    const file = {
      path: "src/x.ts",
      addedLines: new Set([2]),
      source: ['execFile("security", []);', "const added = 1;"].join("\n"),
    };

    expect(scan("security", [file])).toEqual([]);
  });
});

describe("simctl row", () => {
  test.each([
    'execFile("xcrun", ["simctl", "list"]);',
    "spawnSync(`xcrun`, variableArgs);",
    'execSync("xcrun simctl list");',
    'execFile("/bin/sh", ["-c", "xcrun simctl boot"]);',
  ])("flags %s", (line) => {
    expect(scan("simctl", [addedFile("src/x.ts", [line])])).toHaveLength(1);
  });

  test("skips the owner and test paths, allows non-xcrun launches", () => {
    const owner = addedFile("src/utils/ios-cmdline-tools/SimCtlClient.ts", [
      'execFile("xcrun", ["simctl"]);',
    ]);
    const tests = addedFile("test/x.ts", ['execFile("xcrun", ["simctl"]);']);
    const other = addedFile("src/z.ts", ['execFile("ls", ["-l"]);']);

    expect(scan("simctl", [owner, tests, other])).toEqual([]);
  });
});

describe("xcodebuild row", () => {
  test("is whole-file and reports file:line:column", () => {
    const file = {
      path: "src/x.ts",
      addedLines: new Set([1]),
      source: ["const a = 1;", 'spawn("xcodebuild", ["test"]);'].join("\n"),
    };

    const violations = scan("xcodebuild", [file]);

    expect(violations.map(({ file: path, line, column }) => [path, line, column])).toEqual([
      ["src/x.ts", 2, 1],
    ]);
  });
});

describe("renderBoundaryResult", () => {
  test("lists each violating file once for file-report rows", () => {
    const result = renderBoundaryResult(row("security"), [
      { file: "src/a.ts", line: 1, column: 1, text: "t" },
      { file: "src/a.ts", line: 2, column: 1, text: "t" },
      { file: "src/b.ts", line: 1, column: 1, text: "t" },
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(
      "New production security execution must go through SecurityClient:\n  src/a.ts\n  src/b.ts\n",
    );
  });

  test("is silent on success unless the row has a success message", () => {
    expect(renderBoundaryResult(row("security"), [])).toEqual({
      exitCode: 0,
      stdout: "",
      stderr: "",
    });
    expect(renderBoundaryResult(row("xcodebuild"), []).stdout).toContain("xcodebuild-boundary:");
  });
});
