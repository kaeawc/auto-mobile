import ts from "typescript";
import { type BoundaryHit, type BoundaryRow, type BoundarySpan, spanOf } from "./boundaryScanner";
import * as appBundle from "./appBundleMetadataBoundary";
import * as archiveExtraction from "./archiveExtractionBoundary";
import { ALLOWED_IMPORTERS, findChildProcessImports } from "./childProcessImportBoundary";
import * as daemonLauncher from "./daemonLauncherBoundary";
import { findViolationsInSource as findHostShellCalls } from "./hostShellBoundary";
import * as sdkManager from "./sdkManagerExecutionBoundary";
import * as iosCtrlProxy from "./iosCtrlProxyProcessBoundary";
import { findDirectEmulatorCalls } from "./androidEmulatorBoundary";
import { findDirectFfmpegCalls } from "./ffmpegBoundary";
import { findDirectSqliteCalls } from "./simulatorTccSqliteBoundary";
import { findDirectXcodebuildCalls } from "./xcodebuildBoundary";

function parse(source: string, file: string): ts.SourceFile {
  return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

/** Text of a string-like node up to its first substitution, or undefined for other nodes. */
function literalText(node: ts.Node): string | undefined {
  if (ts.isStringLiteralLike(node)) {
    return node.text;
  }
  if (ts.isTemplateHead(node)) {
    return node.text;
  }
  return undefined;
}

function calleeName(call: ts.CallExpression): string | undefined {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) {
    return callee.text;
  }
  return ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined;
}

// The conservative literal check covers argv, shell, absolute-path, Bun.spawn,
// and constructed-path forms without guessing which launch API receives it.
const SECURITY_COMMAND = /^(?:\/usr\/bin\/)?security(?:\s|$)/;
const SECURITY_TEMPLATE_HEAD = /^(?:\/usr\/bin\/)?security\s/;

function detectSecurity(source: string, file: string): BoundarySpan[] {
  const sourceFile = parse(source, file);
  const hits: BoundarySpan[] = [];
  walk(sourceFile, (node) => {
    const text = literalText(node);
    if (text === undefined) {
      return;
    }
    const pattern = ts.isTemplateHead(node) ? SECURITY_TEMPLATE_HEAD : SECURITY_COMMAND;
    if (pattern.test(text)) {
      hits.push(spanOf(sourceFile, node));
    }
  });
  return hits;
}

const SIMCTL_ARGV_LAUNCHERS = new Set(["spawn", "spawnSync", "execFile", "execFileSync"]);
const SIMCTL_SHELL_LAUNCHERS = new Set(["exec", "execSync"]);

function stringsIn(node: ts.Node): string[] {
  const found: string[] = [];
  walk(node, (child) => {
    const text = literalText(child);
    if (text !== undefined) {
      found.push(text);
    }
  });
  return found;
}

/**
 * An argv array literal whose first element is a string literal naming another
 * xcrun tool (`["xctrace", …]`) cannot run simctl, so it is outside this row.
 */
function provablyOtherXcrunTool(argv: ts.Expression | undefined): boolean {
  if (!argv || !ts.isArrayLiteralExpression(argv)) {
    return false;
  }
  const tool = argv.elements[0] ? literalText(argv.elements[0]) : undefined;
  return tool !== undefined && tool !== "simctl" && !tool.startsWith("-");
}

// Block all other direct xcrun argv calls outside the owner: variable argv
// values cannot be proven to be non-simctl statically, and the conservative
// boundary prevents an easy bypass.
function detectSimctl(source: string, file: string): BoundarySpan[] {
  const sourceFile = parse(source, file);
  const hits: BoundarySpan[] = [];
  walk(sourceFile, (node) => {
    if (!ts.isCallExpression(node)) {
      return;
    }
    const name = calleeName(node);
    const first = node.arguments[0];
    const firstText = first ? literalText(first) : undefined;
    const argvXcrun =
      name !== undefined &&
      SIMCTL_ARGV_LAUNCHERS.has(name) &&
      firstText !== undefined &&
      firstText.startsWith("xcrun") &&
      !provablyOtherXcrunTool(node.arguments[1]);
    const shellXcrun =
      name !== undefined &&
      SIMCTL_SHELL_LAUNCHERS.has(name) &&
      node.arguments.some((argument) =>
        stringsIn(argument).some((text) => text.startsWith("xcrun simctl")),
      );
    const binShXcrun =
      node.arguments.some((argument) => literalText(argument) === "/bin/sh") &&
      stringsIn(node).some((text) => text.includes("xcrun simctl"));
    if (argvXcrun || shellXcrun || binShXcrun) {
      hits.push(spanOf(sourceFile, node));
    }
  });
  return hits;
}

function detectXcodebuild(source: string, file: string): BoundarySpan[] {
  return findDirectXcodebuildCalls(file, source).map((violation) => ({
    line: violation.line,
    column: violation.column,
    endLine: violation.line + violation.text.split("\n").length - 1,
    text: violation.text,
  }));
}

// Cheap prefilter: a file with no "plutil" substring cannot contain a `plutil`
// command, so skip parsing it (issue #5121).
function detectPlutil(source: string, file: string): BoundarySpan[] {
  if (!source.includes("plutil")) {
    return [];
  }
  const sourceFile = parse(source, file);
  const hits: BoundarySpan[] = [];
  walk(sourceFile, (node) => {
    if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      /(?:^|\s)plutil(?:\s|$)/.test(node.text)
    ) {
      hits.push(spanOf(sourceFile, node));
    }
  });
  return hits;
}

function fromViolations(
  find: (file: string, source: string) => readonly BoundaryHit[],
): (source: string, file: string) => BoundarySpan[] {
  return (source, file) =>
    find(file, source).map((violation) => ({
      ...violation,
      endLine: violation.line + violation.text.split("\n").length - 1,
    }));
}

export const BOUNDARY_ROWS: readonly BoundaryRow[] = [
  {
    id: "security",
    owner: "src/utils/ios-cmdline-tools/SecurityClient.ts",
    skipPrefixes: [],
    scope: "added-lines",
    report: "files",
    failureHeader: "New production security execution must go through SecurityClient:",
    detect: detectSecurity,
  },
  {
    id: "simctl",
    owner: "src/utils/ios-cmdline-tools/SimCtlClient.ts",
    skipPrefixes: ["test/"],
    scope: "added-lines",
    report: "files",
    failureHeader: "New production xcrun simctl execution must go through SimCtlClient:",
    detect: detectSimctl,
  },
  {
    id: "xcodebuild",
    owner: "src/utils/ios-cmdline-tools/XcodebuildClient.ts",
    skipPrefixes: ["test/"],
    scope: "whole-file",
    report: "locations",
    failureHeader: "New production xcodebuild execution must go through XcodebuildClient:",
    successMessage: "xcodebuild-boundary: no new direct production xcodebuild invocations.",
    detect: detectXcodebuild,
  },
  {
    id: "plutil",
    owner: "src/utils/ios-cmdline-tools/PlistClient.ts",
    skipPrefixes: [],
    scope: "tree",
    report: "positions",
    failureHeader: "Direct production plutil execution must go through PlistClient:",
    detect: detectPlutil,
  },
  {
    id: "ffmpeg",
    owner: "src/utils/media/FfmpegClient.ts",
    skipPrefixes: [],
    scope: "tree",
    report: "src-locations",
    failureHeader: "error: FFmpeg execution must use src/utils/media/FfmpegClient.ts:",
    successMessage: "ffmpeg-execution-boundary: no direct production FFmpeg invocations.",
    detect: fromViolations(findDirectFfmpegCalls),
  },
  {
    id: "simulator-tcc-sqlite",
    owner: "src/utils/ios-cmdline-tools/SimulatorTccSqliteClient.ts",
    // A production diagnostic exception must be listed here with its rationale
    // before it can bypass the simulator-TCC owner.
    skipPrefixes: [],
    scope: "tree",
    report: "src-locations",
    failureHeader: "error: simulator TCC sqlite3 execution must use SimulatorTccSqliteClient:",
    successMessage: "simulator-tcc-sqlite-boundary: no direct production sqlite3 invocations.",
    detect: fromViolations(findDirectSqliteCalls),
  },
  {
    id: "android-emulator",
    owner: "src/utils/android-cmdline-tools/AndroidEmulatorClient.ts",
    skipPrefixes: [],
    scope: "tree",
    report: "src-locations",
    failureHeader: "error: Android emulator execution must use AndroidEmulatorClient:",
    successMessage: "android-emulator-boundary: no direct production emulator invocations.",
    detect: fromViolations(findDirectEmulatorCalls),
  },
  {
    id: "ios-ctrl-proxy-process",
    owner: iosCtrlProxy.OWNER,
    skipPrefixes: [],
    skipFiles: [...iosCtrlProxy.EXCEPTIONS.keys()],
    scope: "tree",
    report: "bare-locations",
    failureHeader: "",
    successMessage: "ios-ctrl-proxy-process-boundary: no direct production PID tooling.",
    detect: fromViolations((file, source) => iosCtrlProxy.findViolationsInSource(file, source)),
  },
  {
    id: "app-bundle-metadata",
    owner: appBundle.OWNER,
    skipPrefixes: [],
    skipFiles: [...appBundle.EXCEPTIONS.keys()],
    scope: "tree",
    report: "bare-locations",
    failureHeader: "error: codesign execution must use AppBundleMetadataClient:",
    successMessage: "app-bundle-metadata-boundary: no direct production codesign invocations.",
    detect: (source, file) =>
      appBundle.directlyExecutesCodesign(file, source).map((hit) => ({
        ...hit,
        endLine: hit.line + hit.text.split("\n").length - 1,
      })),
  },
  {
    id: "child-process-import",
    owner: ALLOWED_IMPORTERS[0]!,
    skipPrefixes: [],
    skipFiles: ALLOWED_IMPORTERS.slice(1),
    extensions: [".ts", ".tsx", ".mts", ".cts"],
    scope: "tree",
    report: "bare-positions",
    failureHeader: "error: child_process imports are restricted to the reviewed allowlist:",
    successMessage: "child-process-import-boundary: no unlisted production imports.",
    detect: (source, file) =>
      findChildProcessImports(file, source).map((hit) => ({ ...hit, endLine: hit.line })),
  },
  {
    id: "archive-extraction",
    owner: archiveExtraction.OWNER,
    skipPrefixes: [],
    skipFiles: [...archiveExtraction.EXCEPTIONS.keys()],
    scope: "tree",
    report: "file-messages",
    failureHeader: `error: tar extraction must use ${archiveExtraction.OWNER}:`,
    fileMessage: (file) =>
      `${file} directly runs tar extraction; route it through ${archiveExtraction.OWNER} instead.`,
    successMessage: "archive-extraction-boundary: no direct production tar extraction.",
    minTreeFiles: 100,
    // The detector answers per file, so the hit marks the file rather than a call site.
    detect: (source) =>
      archiveExtraction.directlyExtractsTar(source)
        ? [{ line: 1, column: 1, endLine: 1, text: "" }]
        : [],
  },
  {
    id: "sdkmanager-execution",
    owner: sdkManager.OWNER,
    skipPrefixes: [],
    skipFiles: [...sdkManager.EXCEPTIONS.keys()],
    scope: "tree",
    report: "file-messages",
    failureHeader: `error: sdkmanager execution must use ${sdkManager.OWNER}:`,
    fileMessage: (file) =>
      `${file} directly executes sdkmanager; route it through ${sdkManager.OWNER} instead.`,
    successMessage: "sdkmanager-execution-boundary: no direct production sdkmanager invocations.",
    minTreeFiles: 100,
    // The detector answers per file, so the hit marks the file rather than a call site.
    detect: (source) =>
      sdkManager.directlyExecutesSdkManager(source)
        ? [{ line: 1, column: 1, endLine: 1, text: "" }]
        : [],
  },
  {
    id: "daemon-launcher",
    owner: daemonLauncher.OWNER,
    skipPrefixes: [],
    treeRoot: daemonLauncher.SOURCE_ROOT,
    scope: "tree",
    report: "root-locations",
    failureHeader: "error: daemon execution must use DaemonLauncher:",
    successMessage: "daemon-launcher-boundary: no direct production daemon invocations.",
    detect: (source, file) =>
      daemonLauncher
        .findViolationsInSource(file, source)
        .map(({ line, column, text }) => ({ line, column, endLine: line, text })),
  },
  {
    id: "host-shell",
    // No production file may run a host shell, so the owner is the checker itself (outside src/).
    owner: "scripts/check-host-shell-boundary.ts",
    skipPrefixes: [],
    scope: "whole-file",
    report: "bare-locations",
    failureHeader:
      "New production shell execution must be reviewed and listed in check-host-shell-boundary.ts:",
    successMessage: "host-shell-boundary: no new direct production shell execution.",
    detect: (source, file) =>
      findHostShellCalls(file, source).map((hit) => ({ ...hit, endLine: hit.line })),
  },
];
