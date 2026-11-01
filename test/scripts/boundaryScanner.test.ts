import { describe, expect, test } from "bun:test";
import { BOUNDARY_ROWS } from "../../scripts/lib/boundaryRows";
import {
  type BoundaryRow,
  parseUnifiedDiff,
  renderBoundaryResult,
  scanBoundary,
  treeTooSmallMessage,
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
    'spawn("xcrun", [...args]);',
    'spawn("xcrun", [tool, "list"]);',
    'spawn("xcrun", ["--sdk", "iphoneos", "simctl"]);',
  ])("flags %s", (line) => {
    expect(scan("simctl", [addedFile("src/x.ts", [line])])).toHaveLength(1);
  });

  test("allows an argv literal that names another xcrun tool", () => {
    const xctrace = addedFile("src/y.ts", ['spawn("xcrun", ["xctrace", "record", ...args]);']);
    expect(scan("simctl", [xctrace])).toEqual([]);
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

describe("tree rows", () => {
  const treeFile = (path: string, source: string) => ({
    path,
    addedLines: new Set<number>(),
    source,
  });

  test("plutil flags string and template literals at their start, not other mentions", () => {
    const file = treeFile(
      "src/x.ts",
      ['exec("plutil -p a");', "const t = `plutil -convert`;", 'const n = "plutilx";'].join("\n"),
    );

    expect(scan("plutil", [file]).map(({ line, column }) => [line, column])).toEqual([
      [1, 6],
      [2, 11],
    ]);
  });

  test("scans every hit regardless of added lines and skips the owner", () => {
    const owner = treeFile("src/utils/media/FfmpegClient.ts", 'spawn("ffmpeg");');
    const other = treeFile(
      "src/y.ts",
      'import { spawn } from "node:child_process"; spawn("ffmpeg");',
    );

    expect(scan("ffmpeg", [owner, other]).map(({ file }) => file)).toEqual(["src/y.ts"]);
  });

  test("simulator-tcc-sqlite flags shell-wrapped sqlite3", () => {
    const file = treeFile("src/y.ts", "exec(\"sh -c 'sqlite3 x'\");");

    expect(scan("simulator-tcc-sqlite", [file])).toHaveLength(1);
  });

  test("android-emulator only inspects files that mention the emulator", () => {
    const unrelated = treeFile(
      "src/a.ts",
      'import { spawn } from "node:child_process"; spawn("ls");',
    );
    const emulator = treeFile(
      "src/b.ts",
      'import { spawn } from "node:child_process"; spawn("emulator");',
    );

    expect(scan("android-emulator", [unrelated, emulator]).map(({ file }) => file)).toEqual([
      "src/b.ts",
    ]);
  });

  test("src-locations strips the src/ prefix; positions omit the snippet", () => {
    const violation = { file: "src/a/b.ts", line: 3, column: 4, text: "spawn()" };

    expect(renderBoundaryResult(row("ffmpeg"), [violation]).stderr).toBe(
      "error: FFmpeg execution must use src/utils/media/FfmpegClient.ts:\na/b.ts:3:4: spawn()\n",
    );
    expect(renderBoundaryResult(row("plutil"), [violation]).stderr).toBe(
      "Direct production plutil execution must go through PlistClient:\n  src/a/b.ts:3:4\n",
    );
  });
});

describe("exception-listed tree rows", () => {
  const treeFile = (path: string, source: string) => ({
    path,
    addedLines: new Set<number>(),
    source,
  });

  test("ios-ctrl-proxy-process skips documented exceptions and renders bare locations", () => {
    const pid = 'import { spawn } from "node:child_process"; spawn("ps", ["-p", "1"]);';
    const found = scan("ios-ctrl-proxy-process", [
      treeFile("src/devices/hostEmulatorProcessStopper.ts", pid),
      treeFile("src/y.ts", pid),
    ]);

    expect(found.map(({ file }) => file)).toEqual(["src/y.ts"]);
    expect(renderBoundaryResult(row("ios-ctrl-proxy-process"), found).stderr).toMatch(
      /^src\/y\.ts:1:\d+: spawn\("ps"/,
    );
  });

  test("app-bundle-metadata flags aliased codesign and skips the exception", () => {
    const source = 'const t = "codesign"; hostExec(t, []);';

    expect(
      scan("app-bundle-metadata", [
        treeFile("src/utils/ios-cmdline-tools/CtrlProxyCodesignVerifier.ts", source),
        treeFile("src/y.ts", source),
      ]).map(({ file }) => file),
    ).toEqual(["src/y.ts"]);
  });

  test("child-process-import allows listed importers and flags import, equals and require", () => {
    const source =
      'import a from "child_process"; import b = require("node:child_process"); require("child_process");';
    const found = scan("child-process-import", [
      treeFile("src/daemon/devicePool.ts", source),
      treeFile("src/utils/HostCommandExecutor.ts", source),
      treeFile("src/y.ts", source),
    ]);

    expect(found.map(({ file, column }) => [file, column])).toEqual([
      ["src/y.ts", 1],
      ["src/y.ts", 32],
      ["src/y.ts", 74],
    ]);
    expect(renderBoundaryResult(row("child-process-import"), found).stderr).toContain(
      "\nsrc/y.ts:1:1\nsrc/y.ts:1:32\n",
    );
  });

  test("an empty failureHeader prints the violations alone", () => {
    const result = renderBoundaryResult(row("ios-ctrl-proxy-process"), [
      { file: "src/a.ts", line: 1, column: 2, text: "t" },
    ]);

    expect(result.stderr).toBe("src/a.ts:1:2: t\n");
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

describe("archive-extraction row (#13219)", () => {
  const treeFile = (path: string, source: string) => ({
    path,
    addedLines: new Set<number>(),
    source,
  });
  const extract = 'spawn("tar", ["-xzf", archive]);\nexec("tar -xzf a.tar.gz -C d");';

  test("flags a file that runs tar extraction once and skips the owner", () => {
    const owner = treeFile("src/utils/ArchiveExtractor.ts", extract);
    const other = treeFile("src/y.ts", extract);
    const creates = treeFile("src/z.ts", 'spawn("tar", ["-czf", archive]);');

    expect(scan("archive-extraction", [owner, other, creates]).map(({ file }) => file)).toEqual([
      "src/y.ts",
    ]);
  });

  test("keeps the checker's per-file failure lines and success message byte for byte", () => {
    const violation = { file: "src/y.ts", line: 1, column: 1, text: "" };

    expect(renderBoundaryResult(row("archive-extraction"), [violation, violation]).stderr).toBe(
      "error: tar extraction must use src/utils/ArchiveExtractor.ts:\n" +
        "src/y.ts directly runs tar extraction; route it through src/utils/ArchiveExtractor.ts instead.\n",
    );
    expect(renderBoundaryResult(row("archive-extraction"), []).stdout).toBe(
      "archive-extraction-boundary: no direct production tar extraction.\n",
    );
  });

  test("refuses a tree scan that found too few files to mean anything", () => {
    expect(treeTooSmallMessage(row("archive-extraction"), 12)).toBe(
      "error: archive-extraction-boundary scanned only 12 files under src; expected the full source tree.",
    );
    expect(treeTooSmallMessage(row("archive-extraction"), 100)).toBeUndefined();
    expect(treeTooSmallMessage(row("ffmpeg"), 0)).toBeUndefined();
  });
});
