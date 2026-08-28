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
const OPAQUE_ARGUMENT = "\u0001";
const ANALYSIS_OVERFLOW = "\u0002";
const MAX_ARGV_ALTERNATIVES = 256;

function commandName(value: string): string {
  return value.split(/[\\/]/).at(-1)?.toLowerCase() ?? "";
}

function containsXcodebuildCommand(value: string): boolean {
  return /(?:^|[\s;&|])(?:[^\s;&|]*[/\\])?xcodebuild(?:\s|$)/i.test(value);
}

function splitEnvPayload(value: string): string[] {
  const words: string[] = [];
  let word = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (const character of value) {
    if (escaped) {
      word += character;
      escaped = false;
    } else if (character === "\\" && quote !== "'") {
      escaped = true;
    } else if (quote) {
      if (character === quote) {
        quote = null;
      } else {
        word += character;
      }
    } else if (character === "'" || character === '"') {
      quote = character;
    } else if (/\s/.test(character)) {
      if (word) {
        words.push(word);
        word = "";
      }
    } else {
      word += character;
    }
  }
  if (escaped) {
    word += "\\";
  }
  if (word) {
    words.push(word);
  }
  return words;
}

function envDelegatesToXcodebuild(argv: readonly string[]): boolean {
  const pending = argv.slice(1);
  let optionsTerminated = false;
  while (pending.length > 0) {
    const argument = pending.shift()!;
    if (argument === OPAQUE_ARGUMENT) {
      // The value may be another environment assignment. Keep scanning known
      // later slots so an unresolved value cannot hide a prohibited command.
      continue;
    }
    if (!optionsTerminated && argument === "--") {
      optionsTerminated = true;
      continue;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(argument)) {
      continue;
    }
    if (optionsTerminated) {
      return commandName(argument) === "xcodebuild";
    }
    if (["-i", "--ignore-environment", "-0", "--null"].includes(argument)) {
      continue;
    }
    if (["-u", "--unset", "-C", "--chdir", "-P"].includes(argument)) {
      pending.shift();
      continue;
    }
    if (["-S", "--split-string"].includes(argument)) {
      pending.unshift(...splitEnvPayload(pending.shift() ?? ""));
      continue;
    }
    if (argument.startsWith("-S") && argument.length > 2) {
      pending.unshift(...splitEnvPayload(argument.slice(2)));
      continue;
    }
    if (/^--(?:unset|chdir)=/.test(argument)) {
      continue;
    }
    if (argument.startsWith("--split-string=")) {
      pending.unshift(...splitEnvPayload(argument.slice("--split-string=".length)));
      continue;
    }
    if (argument.startsWith("-")) {
      // Unknown env flags are skipped conservatively. If they take an operand,
      // treating that operand as the command can only make the boundary louder.
      continue;
    }
    return commandName(argument) === "xcodebuild";
  }
  return false;
}

function argumentSlotAlternatives(
  ast: ReturnType<typeof executionBoundaryAst>,
  node: ts.Expression,
) {
  const values = ast.strings(node);
  if (values.length === 0) {
    return [OPAQUE_ARGUMENT];
  }
  return values.includes("\u0000") ? [values.join("")] : values;
}

function argvAlternatives(
  ast: ReturnType<typeof executionBoundaryAst>,
  items: readonly ts.Expression[],
): string[][] {
  let alternatives: string[][] = [[]];
  for (const item of items) {
    const values = argumentSlotAlternatives(ast, item);
    if (alternatives.length * values.length > MAX_ARGV_ALTERNATIVES) {
      return [[ANALYSIS_OVERFLOW]];
    }
    alternatives = alternatives.flatMap((prefix) => values.map((value) => [...prefix, value]));
  }
  return alternatives;
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
    let possibleArgv = firstArrayAlternatives
      ? firstArrayAlternatives.flatMap((items) => argvAlternatives(ast, items))
      : ast
          .strings(first)
          .flatMap((command) =>
            (argumentArrayAlternatives ?? [[]]).flatMap((items) =>
              argvAlternatives(ast, items).map((arguments_) => [command, ...arguments_]),
            ),
          );
    if (possibleArgv.length > MAX_ARGV_ALTERNATIVES) {
      possibleArgv = [[ANALYSIS_OVERFLOW]];
    }
    const directValues = possibleArgv.flatMap((argv) => argv.slice(0, 1));
    const direct = possibleArgv.some(
      (argv) =>
        argv.includes(ANALYSIS_OVERFLOW) ||
        argv[0] === OPAQUE_ARGUMENT ||
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
