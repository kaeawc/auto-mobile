import { readFileSync } from "node:fs";
import ts from "typescript";
import {
  DYNAMIC_BOUNDARY,
  executionBoundaryAst,
  STRING_ANALYSIS_OVERFLOW,
} from "./lib/executionBoundaryAst";

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

function shellCommandPayloads(argv: readonly string[]): string[] {
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === OPAQUE_ARGUMENT) {
      return [OPAQUE_ARGUMENT];
    }
    if (argument === "--") {
      return [];
    }
    if (argument === "-c" || argument === "--command") {
      return [argv[index + 1] ?? OPAQUE_ARGUMENT];
    }
    if (argument.startsWith("-") && !argument.startsWith("--")) {
      const commandFlagIndex = argument.indexOf("c", 1);
      if (commandFlagIndex >= 1) {
        return [argv[index + 1] ?? OPAQUE_ARGUMENT];
      }
    }
  }
  return [];
}

function splitEnvPayload(value: string): string[] {
  const words: string[] = [];
  const withOpaqueExpansions = (values: string[]): string[] =>
    values.map((candidate) =>
      /\$\{[A-Za-z_][A-Za-z0-9_]*\}/.test(candidate) ? OPAQUE_ARGUMENT : candidate,
    );
  let word = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (const character of value) {
    if (escaped) {
      if (character === "c") {
        if (word) {
          words.push(word);
        }
        return withOpaqueExpansions(words);
      }
      if (["_", "t", "n", "v", "f", "r"].includes(character)) {
        if (quote === '"') {
          const whitespace =
            character === "t"
              ? "\t"
              : character === "n"
                ? "\n"
                : character === "v"
                  ? "\v"
                  : character === "f"
                    ? "\f"
                    : character === "r"
                      ? "\r"
                      : " ";
          word += whitespace;
        } else if (word) {
          words.push(word);
          word = "";
        }
      } else {
        word += character;
      }
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
  return withOpaqueExpansions(words);
}

function envDelegatesToXcodebuild(argv: readonly string[]): boolean {
  const pending = argv.slice(1);
  let optionsTerminated = false;
  let splitStringSeen = false;
  let unknownFlagSeen = false;
  while (pending.length > 0) {
    const argument = pending.shift()!;
    if (argument === OPAQUE_ARGUMENT) {
      // The value may itself be the command, so skipping it would fail open.
      return true;
    }
    if (!optionsTerminated && argument === "--") {
      optionsTerminated = true;
      continue;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(argument)) {
      continue;
    }
    if (optionsTerminated) {
      const command = commandName(argument);
      if (command === "xcodebuild") {
        return true;
      }
      if (SHELLS.has(command)) {
        return shellCommandPayloads(pending).some(containsXcodebuildCommand);
      }
      if (ENV_WRAPPERS.has(command)) {
        return envDelegatesToXcodebuild([argument, ...pending]);
      }
      return splitStringSeen && [argument, ...pending].some(containsXcodebuildCommand);
    }
    if (["-", "-i", "--ignore-environment", "-0", "--null", "-v", "--debug"].includes(argument)) {
      continue;
    }
    if (argument === "--list-signal-handling") {
      continue;
    }
    if (/^--(?:block-signal|default-signal|ignore-signal)$/.test(argument)) {
      continue;
    }
    if (/^--(?:block-signal|default-signal|ignore-signal)=/.test(argument)) {
      continue;
    }
    if (["-u", "--unset", "-C", "--chdir", "-P"].includes(argument)) {
      pending.shift();
      continue;
    }
    if (/^-(?:u|C|P).+/.test(argument)) {
      continue;
    }
    if (["-S", "--split-string"].includes(argument)) {
      splitStringSeen = true;
      pending.unshift(...splitEnvPayload(pending.shift() ?? ""));
      continue;
    }
    if (argument.startsWith("-S") && argument.length > 2) {
      splitStringSeen = true;
      pending.unshift(...splitEnvPayload(argument.slice(2)));
      continue;
    }
    if (/^--(?:unset|chdir)=/.test(argument)) {
      continue;
    }
    if (argument.startsWith("--split-string=")) {
      splitStringSeen = true;
      pending.unshift(...splitEnvPayload(argument.slice("--split-string=".length)));
      continue;
    }
    if (argument.startsWith("-")) {
      // Unknown flags may bundle -S or consume an operand. Remember them so a
      // later unrecognized word cannot make the boundary silently fail open.
      unknownFlagSeen = true;
      continue;
    }
    const command = commandName(argument);
    if (command === "xcodebuild") {
      return true;
    }
    if (SHELLS.has(command)) {
      return shellCommandPayloads(pending).some(containsXcodebuildCommand);
    }
    if (ENV_WRAPPERS.has(command)) {
      return envDelegatesToXcodebuild([argument, ...pending]);
    }
    return (
      (unknownFlagSeen || splitStringSeen) && [argument, ...pending].some(containsXcodebuildCommand)
    );
  }
  return false;
}

function argumentSlotAlternatives(
  ast: ReturnType<typeof executionBoundaryAst>,
  node: ts.Expression,
) {
  const values = ast.stringAlternatives(node);
  if (values.length === 0) {
    return [OPAQUE_ARGUMENT];
  }
  return values.map((value) => {
    if (value === STRING_ANALYSIS_OVERFLOW) {
      return ANALYSIS_OVERFLOW;
    }
    if (!value.includes(DYNAMIC_BOUNDARY)) {
      return value;
    }
    const assignmentPrefix = value.slice(0, value.indexOf(DYNAMIC_BOUNDARY));
    return /^[A-Za-z_][A-Za-z0-9_]*=$/.test(assignmentPrefix) ? value : OPAQUE_ARGUMENT;
  });
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
    const commandAlternatives = firstArrayAlternatives ? [] : ast.stringAlternatives(first);
    const unresolvedLauncherCommand =
      !firstArrayAlternatives && commandAlternatives.length === 0 && ast.isLauncher(call);
    let possibleArgv = firstArrayAlternatives
      ? firstArrayAlternatives.flatMap((items) => argvAlternatives(ast, items))
      : (commandAlternatives.length > 0
          ? commandAlternatives
          : unresolvedLauncherCommand
            ? [OPAQUE_ARGUMENT]
            : []
        ).flatMap((command) =>
          (argumentArrayAlternatives ?? [[]]).flatMap((items) =>
            argvAlternatives(ast, items).map((arguments_) => [
              command === STRING_ANALYSIS_OVERFLOW
                ? ANALYSIS_OVERFLOW
                : command.includes(DYNAMIC_BOUNDARY)
                  ? OPAQUE_ARGUMENT
                  : command,
              ...arguments_,
            ]),
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
