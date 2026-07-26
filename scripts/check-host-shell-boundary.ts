import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { relative } from "node:path";
import ts from "typescript";

const SOURCE_ROOT = "src";
const SHELL_APIS = new Set(["exec", "execSync"]);
const ARGV_APIS = new Set(["execFile", "execFileSync", "spawn", "spawnSync"]);
const CHILD_PROCESS_MODULES = new Set(["child_process", "node:child_process"]);
const SHELL_EXECUTABLES = new Set(["sh", "bash", "zsh", "dash", "ksh", "cmd", "cmd.exe", "powershell", "powershell.exe", "pwsh"]);

/**
 * The Windows daemon inspection uses PowerShell's own `-Command` pipeline for
 * a structured process-table query. It is a diagnostic-only exception; all
 * ordinary host command execution must use argv through HostCommandExecutor.
 */
const EXCEPTIONS = new Map<string, string>([
  ["src/daemon/manager.ts", "Diagnostic PowerShell process-table query; the pipeline is a single reviewed -Command argument."],
]);

export interface Violation {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly text: string;
}

export function repositoryPath(file: string): string {
  return relative(".", file).replaceAll("\\", "/");
}

type GitRunner = (file: string, args: string[]) => string;

const runGit: GitRunner = (file, args) => execFileSync(file, args, { encoding: "utf8" });

export function resolveBaseRef(
  requestedBaseRef: string,
  environment: NodeJS.ProcessEnv = process.env,
  runner: GitRunner = runGit
): string {
  let baseRef = requestedBaseRef;
  try {
    runner("git", ["rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`]);
  } catch {
    if (baseRef === "origin/main" && environment.GITHUB_ACTIONS === "true" && environment.GITHUB_BASE_REF) {
      baseRef = `origin/${environment.GITHUB_BASE_REF}`;
      runner("git", ["fetch", "--no-tags", "--depth=1", "origin", `refs/heads/${environment.GITHUB_BASE_REF}:refs/remotes/origin/${environment.GITHUB_BASE_REF}`]);
    }
    try {
      runner("git", ["rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`]);
    } catch {
      throw new Error(`Cannot check new host shell execution: base ref ${baseRef} does not exist.`);
    }
  }
  return baseRef;
}

export function findViolationsInSource(file: string, source: string): Violation[] {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const importedShellApis = new Set<string>();
  const importedArgvApis = new Set<string>();
  const childProcessNamespaces = new Set<string>();
  const shellExecutableVariables = new Set<string>();
  const violations: Violation[] = [];

  const isChildProcessModule = (moduleSpecifier: ts.Expression): boolean =>
    ts.isStringLiteral(moduleSpecifier) && CHILD_PROCESS_MODULES.has(moduleSpecifier.text);

  const isDynamicChildProcessImport = (expression: ts.Expression): boolean =>
    ts.isCallExpression(expression) &&
    expression.expression.kind === ts.SyntaxKind.ImportKeyword &&
    isChildProcessModule(expression.arguments[0]);

  const isChildProcessRequire = (expression: ts.Expression): boolean =>
    ts.isCallExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === "require" &&
    isChildProcessModule(expression.arguments[0]);

  const isChildProcessLoader = (expression: ts.Expression): boolean =>
    isDynamicChildProcessImport(expression) || isChildProcessRequire(expression);

  const recordImportedApi = (imported: string, local: string): void => {
    if (SHELL_APIS.has(imported)) {importedShellApis.add(local);}
    if (ARGV_APIS.has(imported)) {importedArgvApis.add(local);}
  };

  const isShellWrapper = (node: ts.CallExpression): boolean => {
    const executable = node.arguments[0];
    return (ts.isStringLiteral(executable) && SHELL_EXECUTABLES.has(executable.text.replace(/^.*\//, "").toLowerCase())) ||
      (ts.isIdentifier(executable) && shellExecutableVariables.has(executable.text));
  };

  const record = (node: ts.Node): void => {
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    violations.push({ file, line: line + 1, column: character + 1, text: node.getText(sourceFile) });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && isChildProcessModule(node.moduleSpecifier)) {
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const specifier of bindings.elements) {
          const imported = specifier.propertyName?.text ?? specifier.name.text;
          recordImportedApi(imported, specifier.name.text);
        }
      }
      if (bindings && ts.isNamespaceImport(bindings)) {childProcessNamespaces.add(bindings.name.text);}
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer &&
      ((ts.isAwaitExpression(node.initializer) && isChildProcessLoader(node.initializer.expression)) ||
        isChildProcessRequire(node.initializer))
    ) {
      for (const element of node.name.elements) {
        const imported = element.propertyName?.getText(sourceFile) ?? element.name.getText(sourceFile);
        if (ts.isIdentifier(element.name)) {
          recordImportedApi(imported, element.name.text);
        }
      }
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ((ts.isAwaitExpression(node.initializer) && isChildProcessLoader(node.initializer.expression)) ||
        isChildProcessRequire(node.initializer))
    ) {childProcessNamespaces.add(node.name.text);}
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isStringLiteral(node.initializer) &&
      SHELL_EXECUTABLES.has(node.initializer.text.replace(/^.*\//, "").toLowerCase())
    ) {shellExecutableVariables.add(node.name.text);}
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isPropertyAccessExpression(node.initializer) &&
      ts.isIdentifier(node.initializer.expression) &&
      childProcessNamespaces.has(node.initializer.expression.text)
    ) {recordImportedApi(node.initializer.name.text, node.name.text);}
    if (ts.isCallExpression(node)) {
      const localApi = ts.isIdentifier(node.expression) ? node.expression.text : undefined;
      const namespaceApi = ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        childProcessNamespaces.has(node.expression.expression.text)
        ? node.expression.name.text
        : undefined;
      const api = localApi ?? namespaceApi;
      if ((localApi !== undefined && importedShellApis.has(localApi)) ||
        (namespaceApi !== undefined && SHELL_APIS.has(namespaceApi)) ||
        (api !== undefined &&
          ((localApi !== undefined && importedArgvApis.has(localApi)) ||
            (namespaceApi !== undefined && ARGV_APIS.has(namespaceApi))) &&
          isShellWrapper(node))) {
        record(node);
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return violations;
}

function changedSourceFiles(baseRef: string): string[] {
  if (!existsSync(".git")) {return [];}
  const resolvedBaseRef = resolveBaseRef(baseRef);
  return execFileSync("git", ["diff", "--name-only", resolvedBaseRef, "--", SOURCE_ROOT], { encoding: "utf8" })
    .split("\n")
    .filter(file => file.endsWith(".ts") && existsSync(file));
}

export function findViolations(baseRef = "origin/main"): Violation[] {
  return changedSourceFiles(baseRef)
    .filter(file => !EXCEPTIONS.has(repositoryPath(file)))
    .flatMap(file => findViolationsInSource(file, readFileSync(file, "utf8")));
}

if (import.meta.main) {
  const violations = findViolations(process.argv[2]);
  if (violations.length > 0) {
    console.error("New production shell execution must be reviewed and listed in check-host-shell-boundary.ts:");
    for (const violation of violations) {
      console.error(`${violation.file}:${violation.line}:${violation.column}: ${violation.text}`);
    }
    process.exit(1);
  }
  console.log("host-shell-boundary: no new direct production shell execution.");
}
