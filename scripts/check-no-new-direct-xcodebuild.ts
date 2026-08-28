import { readFileSync } from "node:fs";
import ts from "typescript";
import { executionBoundaryAst } from "./lib/executionBoundaryAst";

export interface XcodebuildViolation {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly text: string;
}

const SHELLS = new Set(["sh", "/bin/sh", "bash", "/bin/bash", "zsh", "/bin/zsh"]);

function commandName(value: string): string {
  return value.split(/[\\/]/).at(-1)?.toLowerCase() ?? "";
}

function containsXcodebuildCommand(value: string): boolean {
  return /(?:^|[\s;&|])(?:[^\s;&|]*[/\\])?xcodebuild(?:\s|$)/i.test(value);
}

export function findDirectXcodebuildCalls(file: string, source: string): XcodebuildViolation[] {
  if (!source.toLowerCase().includes("xcodebuild")) {
    return [];
  }
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const ast = executionBoundaryAst(source);
  return ast.calls.flatMap((call) => {
    if (!ast.isLauncher(call) && !ast.isExecutionSeam(call)) {
      return [];
    }
    const first = call.arguments[0];
    const arrayCommands =
      ast
        .arrayAlternatives(first)
        ?.flatMap((items) => (items.length > 0 ? ast.strings(items[0]) : [])) ?? [];
    const directValues = [...ast.strings(first), ...arrayCommands];
    const direct = directValues.some((value) => commandName(value) === "xcodebuild");
    const shell = directValues.some((value) => SHELLS.has(value.toLowerCase()));
    const shellPayloads = call.arguments.slice(1).flatMap((argument) => ast.strings(argument));
    const embedded =
      (shell || ["exec", "execSync"].includes(ast.calleeName(call) ?? "")) &&
      [...directValues, ...shellPayloads].some(containsXcodebuildCommand);
    if (!direct && !embedded) {
      return [];
    }
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(call.getStart(sourceFile));
    return [
      {
        file,
        line: line + 1,
        column: character + 1,
        text: call.getText(sourceFile),
      },
    ];
  });
}

if (import.meta.main) {
  const violations = process.argv
    .slice(2)
    .flatMap((file) => findDirectXcodebuildCalls(file, readFileSync(file, "utf8")));
  if (violations.length > 0) {
    console.error("New production xcodebuild execution must go through XcodebuildClient:");
    for (const violation of violations) {
      console.error(`  ${violation.file}:${violation.line}:${violation.column}: ${violation.text}`);
    }
    process.exit(1);
  }
  console.log("xcodebuild-boundary: no new direct production xcodebuild invocations.");
}
