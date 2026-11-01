import ts from "typescript";

// The host-shell execution boundary detector (issue #4068). Its row in boundaryRows.ts (issue
// #13219) and test/lint/hostShellBoundary.test.ts both use `findViolationsInSource` from here so
// there is exactly one detector. It reports a child_process shell API (`exec`, `execSync`), or an
// argv API given a shell executable or a truthy `shell` option.
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

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && isChildProcessModule(node.moduleSpecifier)) {
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const specifier of bindings.elements) {
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
      isChildProcessLoaderExpression(node.initializer)
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
      isChildProcessLoaderExpression(node.initializer)
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
      recordImportedApi(childProcessApiFromMember(node.initializer)!, node.name.text);
    }
    if (ts.isCallExpression(node)) {
      const localApi = ts.isIdentifier(node.expression) ? node.expression.text : undefined;
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
