import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { executionBoundaryAst } from "./lib/executionBoundaryAst";

const SOURCE_ROOT = "src";
const OWNER = "src/utils/ios/IOSCtrlProxyProcessClient.ts";
const PROCESS_TOOLS = new Set(["ps", "pgrep", "kill", "lsof"]);
const SHELLS = new Set(["sh", "/bin/sh", "bash", "/bin/bash", "zsh", "/bin/zsh"]);
const EXCEPTIONS = new Map<string, string>([
  [
    "src/features/performance/PerformanceMonitor.ts",
    "Collects app metrics, not CtrlProxy lifecycle state.",
  ],
]);

export function repositoryPath(file: string): string {
  return relative(".", file).replaceAll("\\", "/");
}

export interface Violation {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly text: string;
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : entry.name.endsWith(".ts") ? [path] : [];
  });
}

function commandName(value: string): string {
  return value.split(/[\\/]/).at(-1)?.toLowerCase() ?? "";
}

function shellTextExecutesProcessTool(value: string): boolean {
  return [...PROCESS_TOOLS].some((tool) =>
    new RegExp(`(?:^|[\\s;&|])(?:[^\\s;&|]*[/\\\\])?${tool}(?:\\s|$)`, "i").test(value),
  );
}

export function findViolationsInSource(file: string, source: string): Violation[] {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const ast = executionBoundaryAst(source);
  const violations: Violation[] = [];
  for (const node of ast.calls) {
    if (!ast.isLauncher(node) && !ast.isExecutionSeam(node)) {
      continue;
    }
    const first = node.arguments[0];
    const arrayCommands =
      ast
        .arrayAlternatives(first)
        ?.flatMap((items) => (items.length > 0 ? ast.strings(items[0]) : [])) ?? [];
    const directCommands = [...ast.strings(first), ...arrayCommands];
    const executesDirectly = directCommands.some((value) => PROCESS_TOOLS.has(commandName(value)));
    const invokesShell = directCommands.some((value) => SHELLS.has(value.toLowerCase()));
    const shellPayloads = node.arguments.slice(1).flatMap((argument) => ast.strings(argument));
    const executesViaShell =
      (invokesShell || ["exec", "execSync"].includes(ast.calleeName(node) ?? "")) &&
      [...directCommands, ...shellPayloads].some(shellTextExecutesProcessTool);
    if (!executesDirectly && !executesViaShell) {
      continue;
    }
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    violations.push({
      file,
      line: line + 1,
      column: character + 1,
      text: node.getText(sourceFile),
    });
  }
  return violations;
}

export function findViolations(): Violation[] {
  return sourceFiles(SOURCE_ROOT)
    .filter((file) => repositoryPath(file) !== OWNER && !EXCEPTIONS.has(repositoryPath(file)))
    .flatMap((file) => findViolationsInSource(file, readFileSync(file, "utf8")));
}

if (import.meta.main) {
  const violations = findViolations();
  if (violations.length > 0) {
    for (const violation of violations) {
      console.error(`${violation.file}:${violation.line}:${violation.column}: ${violation.text}`);
    }
    process.exit(1);
  }
  console.log("ios-ctrl-proxy-process-boundary: no direct production PID tooling.");
}
