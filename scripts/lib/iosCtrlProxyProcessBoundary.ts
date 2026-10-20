import { relative } from "node:path";
import ts from "typescript";
import { executionBoundaryAst } from "./executionBoundaryAst";

export const OWNER = "src/ctrlProxy/ios/IosCtrlProxyProcessClient.ts";
const PROCESS_TOOLS = new Set(["ps", "pgrep", "kill", "lsof"]);
const SHELLS = new Set(["sh", "/bin/sh", "bash", "/bin/bash", "zsh", "/bin/zsh"]);
export const EXCEPTIONS = new Map<string, string>([
  [
    "src/devices/hostEmulatorProcessStopper.ts",
    "Read-only ps probe of an Android emulator pid's process group; never touches the iOS runner.",
  ],
  [
    "src/features/performance/PerformanceMonitor.ts",
    "Collects app metrics, not CtrlProxy lifecycle state.",
  ],
  [
    "src/devices/bootAdmission/readHostProcessTable.ts",
    "Read-only ps snapshot for simulator fleet cost (#6696) and Android boot admission; never touches the iOS runner.",
  ],
  [
    "src/features/observe/android/CtrlProxyForwardClientProbe.ts",
    "Reads host TCP connections to an Android ADB forward; never touches the iOS runner.",
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
