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
const ENV_WRAPPERS = new Set(["env"]);

function commandName(value: string): string {
  return value.split(/[\\/]/).at(-1)?.toLowerCase() ?? "";
}

function containsXcodebuildCommand(value: string): boolean {
  return /(?:^|[\s;&|])(?:[^\s;&|]*[/\\])?xcodebuild(?:\s|$)/i.test(value);
}

function envDelegatesToXcodebuild(argv: readonly string[]): boolean {
  let index = 1;
  let optionsTerminated = false;
  while (index < argv.length) {
    const argument = argv[index];
    if (!optionsTerminated && argument === "--") {
      optionsTerminated = true;
      index++;
      continue;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(argument)) {
      index++;
      continue;
    }
    if (optionsTerminated) {
      return commandName(argument) === "xcodebuild";
    }
    if (["-i", "--ignore-environment", "-0", "--null"].includes(argument)) {
      index++;
      continue;
    }
    if (["-u", "--unset", "-C", "--chdir", "-P"].includes(argument)) {
      index += 2;
      continue;
    }
    if (["-S", "--split-string"].includes(argument)) {
      return containsXcodebuildCommand(argv[index + 1] ?? "");
    }
    if (argument.startsWith("-S") && argument.length > 2) {
      return containsXcodebuildCommand(argument.slice(2));
    }
    if (/^--(?:unset|chdir)=/.test(argument)) {
      index++;
      continue;
    }
    if (argument.startsWith("--split-string=")) {
      return containsXcodebuildCommand(argument.slice("--split-string=".length));
    }
    if (argument.startsWith("-")) {
      // Unknown env flags are skipped conservatively. If they take an operand,
      // treating that operand as the command can only make the boundary louder.
      index++;
      continue;
    }
    return commandName(argument) === "xcodebuild";
  }
  return false;
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
    const firstArrayAlternatives = ast.arrayAlternatives(first);
    const argumentArrayAlternatives = ast.arrayAlternatives(call.arguments[1]);
    const argvAlternatives = firstArrayAlternatives
      ? firstArrayAlternatives.map((items) => items.flatMap((item) => ast.strings(item)))
      : ast
          .strings(first)
          .flatMap((command) =>
            (argumentArrayAlternatives ?? [[]]).map((items) => [
              command,
              ...items.flatMap((item) => ast.strings(item)),
            ]),
          );
    const directValues = argvAlternatives.flatMap((argv) => argv.slice(0, 1));
    const direct = argvAlternatives.some(
      (argv) =>
        commandName(argv[0] ?? "") === "xcodebuild" ||
        (ENV_WRAPPERS.has(commandName(argv[0] ?? "")) && envDelegatesToXcodebuild(argv)),
    );
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
