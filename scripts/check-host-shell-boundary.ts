import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import ts from "typescript";

const SOURCE_ROOT = "src";
const SHELL_APIS = new Set(["exec", "execSync"]);
const ARGV_APIS = new Set(["execFile", "execFileSync", "spawn", "spawnSync"]);
const CHILD_PROCESS_MODULES = new Set(["child_process", "node:child_process"]);
const SHELL_EXECUTABLES = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "cmd",
  "cmd.exe",
  "powershell",
  "powershell.exe",
  "pwsh",
]);

export interface Violation {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly text: string;
}

type CommandRunner = (file: string, args: string[]) => string;

const runCommand: CommandRunner = (file, args) => execFileSync(file, args, { encoding: "utf8" });

export function resolveBaseRef(
  requestedBaseRef: string,
  environment: NodeJS.ProcessEnv = process.env,
  runner: CommandRunner = runCommand,
): string {
  let baseRef = requestedBaseRef;
  try {
    runner("git", ["rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`]);
  } catch {
    if (
      baseRef === "origin/main" &&
      environment.GITHUB_ACTIONS === "true" &&
      environment.GITHUB_BASE_REF
    ) {
      baseRef = `origin/${environment.GITHUB_BASE_REF}`;
      runner("git", [
        "fetch",
        "--no-tags",
        "--depth=1",
        "origin",
        `refs/heads/${environment.GITHUB_BASE_REF}:refs/remotes/origin/${environment.GITHUB_BASE_REF}`,
      ]);
    }
    try {
      runner("git", ["rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`]);
    } catch {
      throw new Error(`Cannot check new host shell execution: base ref ${baseRef} does not exist.`);
    }
  }
  return baseRef;
}

export function resolveJjBaseRef(
  requestedBaseRef: string,
  runner: CommandRunner = runCommand,
): string {
  const baseRef = requestedBaseRef === "origin/main" ? "main@origin" : requestedBaseRef;
  try {
    runner("jj", ["log", "-r", baseRef, "--no-graph", "-T", ""]);
  } catch {
    throw new Error(`Cannot check new host shell execution: base ref ${baseRef} does not exist.`);
  }
  return baseRef;
}

export function findViolationsInSource(file: string, source: string): Violation[] {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
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

  const unwrapExpression = (expression: ts.Expression): ts.Expression =>
    ts.isParenthesizedExpression(expression) ? unwrapExpression(expression.expression) : expression;

  const isChildProcessLoaderExpression = (expression: ts.Expression): boolean => {
    const unwrapped = unwrapExpression(expression);
    return (
      (ts.isAwaitExpression(unwrapped) && isChildProcessLoader(unwrapped.expression)) ||
      isChildProcessRequire(unwrapped)
    );
  };

  // A child_process value source: either an inline require()/dynamic import, or
  // an identifier already registered as a child_process namespace. This lets
  // `const { exec: run } = cp;` (destructured from a namespace) be recognized.
  const isChildProcessSource = (expression: ts.Expression): boolean => {
    if (isChildProcessLoaderExpression(expression)) {
      return true;
    }
    const unwrapped = unwrapExpression(expression);
    return ts.isIdentifier(unwrapped) && childProcessNamespaces.has(unwrapped.text);
  };

  const recordImportedApi = (imported: string, local: string): void => {
    if (SHELL_APIS.has(imported)) {
      importedShellApis.add(local);
    }
    if (ARGV_APIS.has(imported)) {
      importedArgvApis.add(local);
    }
  };

  const isShellWrapper = (node: ts.CallExpression): boolean => {
    const executable = node.arguments[0];
    return (
      (ts.isStringLiteral(executable) &&
        SHELL_EXECUTABLES.has(executable.text.replace(/^.*\//, "").toLowerCase())) ||
      (ts.isIdentifier(executable) && shellExecutableVariables.has(executable.text))
    );
  };

  const hasShellOption = (node: ts.CallExpression): boolean =>
    node.arguments.some(
      (argument) =>
        ts.isObjectLiteralExpression(argument) &&
        argument.properties.some(
          (property) =>
            ts.isPropertyAssignment(property) &&
            ((ts.isIdentifier(property.name) && property.name.text === "shell") ||
              (ts.isStringLiteral(property.name) && property.name.text === "shell")) &&
            property.initializer.kind !== ts.SyntaxKind.FalseKeyword,
        ),
    );

  const childProcessApiFromMember = (expression: ts.Expression): string | undefined => {
    const receiver =
      ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)
        ? unwrapExpression(expression.expression)
        : undefined;
    const isChildProcessReceiver =
      receiver &&
      ((ts.isIdentifier(receiver) && childProcessNamespaces.has(receiver.text)) ||
        isChildProcessLoaderExpression(receiver));
    if (!isChildProcessReceiver) {
      return undefined;
    }
    if (ts.isPropertyAccessExpression(expression)) {
      return expression.name.text;
    }
    return ts.isElementAccessExpression(expression) &&
      ts.isStringLiteral(expression.argumentExpression)
      ? expression.argumentExpression.text
      : undefined;
  };

  const record = (node: ts.Node): void => {
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    violations.push({
      file,
      line: line + 1,
      column: character + 1,
      text: node.getText(sourceFile),
    });
  };

  const isDeclarationName = (node: ts.Identifier): boolean => {
    const { parent } = node;
    if (ts.isImportSpecifier(parent)) {
      return true;
    }
    if (
      (ts.isBindingElement(parent) ||
        ts.isVariableDeclaration(parent) ||
        ts.isParameter(parent) ||
        ts.isPropertyDeclaration(parent)) &&
      parent.name === node
    ) {
      return true;
    }
    // Non-computed property/method names (e.g. `{ exec: false }`, `exec() {}`)
    // are declaration positions, not references to the imported API. Shorthand
    // `{ exec }` is a ShorthandPropertyAssignment and is intentionally excluded
    // here so it stays detectable as a value reference.
    return (
      (ts.isPropertyAssignment(parent) ||
        ts.isMethodDeclaration(parent) ||
        ts.isGetAccessorDeclaration(parent) ||
        ts.isSetAccessorDeclaration(parent)) &&
      parent.name === node
    );
  };

  // An identifier used purely in a type position (`typeof exec`,
  // `type X = exec`) does not execute the shell API at runtime.
  const isTypePositionReference = (node: ts.Identifier): boolean => {
    let current: ts.Node = node;
    let parent = current.parent;
    while (parent && ts.isQualifiedName(parent)) {
      current = parent;
      parent = current.parent;
    }
    return !!parent && (ts.isTypeQueryNode(parent) || ts.isTypeReferenceNode(parent));
  };

  const bindingIntroducesName = (binding: ts.BindingName, name: string): boolean => {
    if (ts.isIdentifier(binding)) {
      return binding.text === name;
    }
    return binding.elements.some(
      (element) => ts.isBindingElement(element) && bindingIntroducesName(element.name, name),
    );
  };

  // A local binding whose initializer is itself a child_process value source
  // (`const { exec } = require(...)`, `const { exec: run } = cp`, `const run =
  // cp.exec`) is the API's origin, not a shadow of it.
  const isApiSourceInitializer = (initializer: ts.Expression | undefined): boolean =>
    initializer !== undefined &&
    (isChildProcessSource(initializer) || childProcessApiFromMember(initializer) !== undefined);

  const scopeDeclaresName = (scope: ts.Node, name: string): boolean => {
    if (
      ts.isFunctionLike(scope) &&
      scope.parameters.some((p) => bindingIntroducesName(p.name, name))
    ) {
      return true;
    }
    const statements =
      ts.isSourceFile(scope) || ts.isBlock(scope) || ts.isModuleBlock(scope)
        ? scope.statements
        : undefined;
    if (!statements) {
      return false;
    }
    // Import declarations and API-source locals are the origin binding for the
    // shell API, not a shadow of it.
    return statements.some(
      (statement) =>
        (ts.isVariableStatement(statement) &&
          statement.declarationList.declarations.some(
            (d) => bindingIntroducesName(d.name, name) && !isApiSourceInitializer(d.initializer),
          )) ||
        (ts.isFunctionDeclaration(statement) && statement.name?.text === name) ||
        (ts.isClassDeclaration(statement) && statement.name?.text === name),
    );
  };

  // Resolve the identifier by lexical binding: a closer parameter/local of the
  // same name shadows the imported shell API, so the reference is not the API.
  const isLexicallyShadowed = (node: ts.Identifier): boolean => {
    let current: ts.Node | undefined = node.parent;
    while (current) {
      if (scopeDeclaresName(current, node.text)) {
        return true;
      }
      current = current.parent;
    }
    return false;
  };

  const visit = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      isChildProcessModule(node.moduleSpecifier) &&
      // `import type { exec }` introduces no runtime binding.
      node.importClause?.isTypeOnly !== true
    ) {
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const specifier of bindings.elements) {
          // `import { type exec }` is likewise type-only, not a runtime import.
          if (specifier.isTypeOnly) {
            continue;
          }
          const imported = specifier.propertyName?.text ?? specifier.name.text;
          recordImportedApi(imported, specifier.name.text);
        }
      }
      if (bindings && ts.isNamespaceImport(bindings)) {
        childProcessNamespaces.add(bindings.name.text);
      }
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer &&
      isChildProcessSource(node.initializer)
    ) {
      for (const element of node.name.elements) {
        const imported =
          element.propertyName?.getText(sourceFile) ?? element.name.getText(sourceFile);
        if (ts.isIdentifier(element.name)) {
          recordImportedApi(imported, element.name.text);
        }
      }
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      isChildProcessSource(node.initializer)
    ) {
      childProcessNamespaces.add(node.name.text);
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isStringLiteral(node.initializer) &&
      SHELL_EXECUTABLES.has(node.initializer.text.replace(/^.*\//, "").toLowerCase())
    ) {
      shellExecutableVariables.add(node.name.text);
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      childProcessApiFromMember(node.initializer)
    ) {
      const memberApi = childProcessApiFromMember(node.initializer)!;
      if (SHELL_APIS.has(memberApi)) {
        record(node);
      } else {
        recordImportedApi(memberApi, node.name.text);
      }
    }
    if (
      ts.isIdentifier(node) &&
      importedShellApis.has(node.text) &&
      !isDeclarationName(node) &&
      !isTypePositionReference(node) &&
      !isLexicallyShadowed(node) &&
      !(ts.isCallExpression(node.parent) && node.parent.expression === node)
    ) {
      record(node);
    }
    if (
      (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
      SHELL_APIS.has(childProcessApiFromMember(node) ?? "") &&
      !(ts.isCallExpression(node.parent) && node.parent.expression === node) &&
      !(ts.isVariableDeclaration(node.parent) && node.parent.initializer === node)
    ) {
      record(node);
    }
    if (ts.isCallExpression(node)) {
      const localCallee = ts.isIdentifier(node.expression) ? node.expression : undefined;
      // A locally shadowed callee (e.g. a parameter named `exec`) is not the API.
      const localApi =
        localCallee && !isLexicallyShadowed(localCallee) ? localCallee.text : undefined;
      const namespaceApi = childProcessApiFromMember(node.expression);
      const api = localApi ?? namespaceApi;
      if (
        (localApi !== undefined && importedShellApis.has(localApi)) ||
        (namespaceApi !== undefined && SHELL_APIS.has(namespaceApi)) ||
        (api !== undefined &&
          ((localApi !== undefined && importedArgvApis.has(localApi)) ||
            (namespaceApi !== undefined && ARGV_APIS.has(namespaceApi))) &&
          (isShellWrapper(node) || hasShellOption(node)))
      ) {
        record(node);
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return violations;
}

export function changedSourceFiles(
  baseRef: string,
  hasGitDirectory = existsSync(".git"),
  hasJjDirectory = existsSync(".jj"),
  runner: CommandRunner = runCommand,
): string[] {
  if (!hasGitDirectory && !hasJjDirectory) {
    throw new Error(
      "Cannot check new host shell execution: this directory is not a Git or Jujutsu worktree.",
    );
  }
  const useJj = hasJjDirectory && !hasGitDirectory;
  const resolvedBaseRef = useJj
    ? resolveJjBaseRef(baseRef, runner)
    : resolveBaseRef(baseRef, process.env, runner);
  const changedFiles = useJj
    ? runner("jj", ["diff", "--from", resolvedBaseRef, "--to", "@", "--name-only", SOURCE_ROOT])
    : runner("git", ["diff", "--name-only", resolvedBaseRef, "--", SOURCE_ROOT]);
  return changedFiles.split("\n").filter((file) => file.endsWith(".ts") && existsSync(file));
}

export function findViolations(baseRef = "origin/main"): Violation[] {
  return changedSourceFiles(baseRef).flatMap((file) =>
    findViolationsInSource(file, readFileSync(file, "utf8")),
  );
}

if (import.meta.main) {
  const violations = findViolations(process.argv[2]);
  if (violations.length > 0) {
    console.error(
      "New production shell execution must be reviewed and listed in check-host-shell-boundary.ts:",
    );
    for (const violation of violations) {
      console.error(`${violation.file}:${violation.line}:${violation.column}: ${violation.text}`);
    }
    process.exit(1);
  }
  console.log("host-shell-boundary: no new direct production shell execution.");
}
