import ts from "typescript";
import { type BoundaryRow, type BoundarySpan, spanOf } from "./boundaryScanner";
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

// Block all direct xcrun argv calls outside the owner: variable argv values
// cannot be proven to be non-simctl statically, and the conservative boundary
// prevents an easy bypass.
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
      firstText.startsWith("xcrun");
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
];
