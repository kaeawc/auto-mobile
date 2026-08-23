import { readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import ts from "typescript";

// The single home of the sdkmanager execution-boundary guard (issue #4052, hardened in
// #4339 and #4341). Both the fast-validate check and test/lint/sdkManagerExecutionBoundary.test.ts
// import `directlyExecutesSdkManager` from here so there is exactly one detector.
export const SOURCE_ROOT = "src";
export const OWNER = "src/utils/android-cmdline-tools/SdkManagerClient.ts";
// Keep production diagnostics out of this list unless they genuinely cannot use the client.
export const EXCEPTIONS = new Map<string, string>();

const LAUNCHER_NAMES = new Set([
  "spawn",
  "spawnSync",
  "spawnCommand",
  "exec",
  "execSync",
  "execFile",
  "execFileSync",
]);

// Array-iteration methods that bind a callback's parameters to the receiver's elements. When the
// receiver carries an sdkmanager literal, those parameters are tainted just like a named
// function's parameters at a call site (issue #4368) — there is no explicit call site to key on.
const ITERATION_METHODS = new Set([
  "forEach",
  "map",
  "flatMap",
  "filter",
  "find",
  "findIndex",
  "findLast",
  "some",
  "every",
  "reduce",
  "reduceRight",
]);

function functionLikeName(node: ts.Node): string | undefined {
  if (
    (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) &&
    node.name &&
    ts.isIdentifier(node.name)
  ) {
    return node.name.text;
  }
  if (ts.isFunctionExpression(node) || ts.isArrowFunction(node)) {
    const parent = node.parent;
    if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
      return parent.name.text;
    }
    if (parent && ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) {
      return parent.name.text;
    }
    // `obj.run = (bin) => ...` binds the arrow to a member expression, not a variable or
    // object-literal property; key it by the property name so its call sites are found (#4368).
    if (
      parent &&
      ts.isBinaryExpression(parent) &&
      parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(parent.left)
    ) {
      return parent.left.name.text;
    }
  }
  return undefined;
}

function calleeName(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) {
    return expression.text;
  }
  if (ts.isPropertyAccessExpression(expression)) {
    return expression.name.text;
  }
  return undefined;
}

function returnExpressions(fn: ts.FunctionLikeDeclaration): ts.Expression[] {
  const body = fn.body;
  if (!body) {
    return [];
  }
  if (!ts.isBlock(body)) {
    return [body];
  }
  const returns: ts.Expression[] = [];
  const walk = (node: ts.Node): void => {
    // Stop at a nested function boundary so an inner function's returns are not misattributed.
    if (node !== fn && ts.isFunctionLike(node)) {
      return;
    }
    if (ts.isReturnStatement(node) && node.expression) {
      returns.push(node.expression);
    }
    ts.forEachChild(node, walk);
  };
  ts.forEachChild(body, walk);
  return returns;
}

export function directlyExecutesSdkManager(source: string): boolean {
  const lowerSource = source.toLowerCase();
  if (!lowerSource.includes("sdk") || !lowerSource.includes("manager")) {
    return false;
  }

  const sourceFile = ts.createSourceFile(
    "sdkmanager-boundary.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const launcherAliases = new Set(LAUNCHER_NAMES);
  const initializers = new Map<string, ts.Expression[]>();
  const declarations: ts.VariableDeclaration[] = [];
  // Interprocedural bookkeeping (issue #4341): functions keyed by bare name, the arguments seen
  // at each call site, and the two monotonic taint sets derived from them below. Bindings are
  // keyed by bare name, not by scope, and every value bound to a name is consulted — so a name
  // bound anywhere in the file poisons every use of that name. That errs toward over-detection
  // deliberately: a false CI failure is loud and fixable, a missed `spawn(sdkmanager)` is not.
  const functionsByName = new Map<string, ts.FunctionLikeDeclaration[]>();
  const returnsByName = new Map<string, ts.Expression[]>();
  const callSites: { name: string; args: readonly ts.Expression[] }[] = [];
  // Iteration-method callbacks paired with the receiver whose elements bind their parameters, e.g.
  // `["sdkmanager"].forEach(bin => spawn(bin))`. If the receiver mentions sdkmanager the fixpoint
  // taints the callback's parameters (issue #4368).
  const iterationCallbacks: { receiver: ts.Expression; callback: ts.FunctionLikeDeclaration }[] =
    [];
  // Three monotonic taint sets, all filled by the fixpoint after collection: parameter names
  // that receive an sdkmanager-ish argument at some call site, function names whose return value
  // carries sdkmanager, and variable names whose (transitive) initializer carries sdkmanager.
  // `taintedNames` memoizes what a `seen`-guarded recursive walk of `initializers` would compute,
  // but as an O(1) membership test — without it, a chain of repeated-reference bindings
  // (`a1 = a0 + a0; a2 = a1 + a1; ...`) makes the walk re-descend exponentially.
  const sdkManagerParams = new Set<string>();
  const returnsSdkManager = new Set<string>();
  const taintedNames = new Set<string>();

  const bindValue = (name: string, value: ts.Expression): void => {
    initializers.set(name, [...(initializers.get(name) ?? []), value]);
  };

  const collect = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      ["child_process", "node:child_process"].includes(node.moduleSpecifier.text)
    ) {
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          const importedName = element.propertyName?.text ?? element.name.text;
          if (LAUNCHER_NAMES.has(importedName)) {
            launcherAliases.add(element.name.text);
          }
        }
      }
    }
    if (ts.isVariableDeclaration(node)) {
      declarations.push(node);
      if (ts.isIdentifier(node.name) && node.initializer) {
        bindValue(node.name.text, node.initializer);
      }
      if (ts.isObjectBindingPattern(node.name)) {
        for (const element of node.name.elements) {
          const propertyName =
            element.propertyName && ts.isIdentifier(element.propertyName)
              ? element.propertyName.text
              : ts.isIdentifier(element.name)
                ? element.name.text
                : undefined;
          if (propertyName && LAUNCHER_NAMES.has(propertyName) && ts.isIdentifier(element.name)) {
            launcherAliases.add(element.name.text);
          }
          // `const { path } = await this.resolve()` carries the resolved binary through a
          // destructured name; bind it to the initializer so return-taint can flow across it.
          if (node.initializer && ts.isIdentifier(element.name)) {
            bindValue(element.name.text, node.initializer);
          }
        }
      }
    }
    // `let command: string; command = ...;` carries no declaration initializer, so the
    // deferred assignment is the only place the value is visible.
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left)
    ) {
      bindValue(node.left.text, node.right);
    }
    // `private bin = "sdkmanager"` is a PropertyDeclaration; bind its initializer by the field
    // name so a `this.bin` reference at a launcher call site resolves through the value flow,
    // mirroring the local-variable handling above (issue #4368).
    if (ts.isPropertyDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      bindValue(node.name.text, node.initializer);
    }
    // `receiver.map(bin => ...)` binds `bin` to the receiver's elements; record the pairing so the
    // fixpoint can taint the callback parameters when the receiver mentions sdkmanager (#4368).
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ITERATION_METHODS.has(node.expression.name.text)
    ) {
      const receiver = node.expression.expression;
      for (const argument of node.arguments) {
        if (ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)) {
          iterationCallbacks.push({ receiver, callback: argument });
        }
      }
    }
    if (ts.isFunctionLike(node)) {
      const name = functionLikeName(node);
      if (name) {
        functionsByName.set(name, [...(functionsByName.get(name) ?? []), node]);
        returnsByName.set(name, [...(returnsByName.get(name) ?? []), ...returnExpressions(node)]);
      }
    }
    if (ts.isCallExpression(node)) {
      const name = calleeName(node.expression);
      if (name) {
        callSites.push({ name, args: node.arguments });
      }
    }
    ts.forEachChild(node, collect);
  };
  collect(sourceFile);

  // `promisify(execFile)` is the dominant launcher idiom in src/, so both the stored alias
  // (`const run = promisify(exec); run(...)`) and the immediate call (`promisify(exec)(...)`)
  // have to read as launcher references.
  const isPromisifiedLauncher = (node: ts.Expression): boolean => {
    if (!ts.isCallExpression(node) || node.arguments.length !== 1) {
      return false;
    }
    const callee = node.expression;
    const name = ts.isIdentifier(callee)
      ? callee.text
      : ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : undefined;
    return name === "promisify" && isLauncherReference(node.arguments[0]);
  };
  const isLauncherReference = (node: ts.Expression): boolean => {
    if (ts.isIdentifier(node)) {
      return launcherAliases.has(node.text);
    }
    if (ts.isCallExpression(node)) {
      return isPromisifiedLauncher(node);
    }
    return ts.isPropertyAccessExpression(node) && LAUNCHER_NAMES.has(node.name.text);
  };
  let aliasesChanged = true;
  while (aliasesChanged) {
    aliasesChanged = false;
    for (const declaration of declarations) {
      if (
        !ts.isIdentifier(declaration.name) ||
        !declaration.initializer ||
        !isLauncherReference(declaration.initializer) ||
        launcherAliases.has(declaration.name.text)
      ) {
        continue;
      }
      launcherAliases.add(declaration.name.text);
      aliasesChanged = true;
    }
  }

  const staticText = (node: ts.Expression): string | undefined => {
    if (ts.isStringLiteralLike(node)) {
      return node.text;
    }
    if (ts.isParenthesizedExpression(node)) {
      return staticText(node.expression);
    }
    // Join the static chunks of a template with a separator no identifier can contain, so
    // `sdkmanager` is only matched when it sits wholly inside one chunk.
    if (ts.isTemplateExpression(node)) {
      return [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(
        "\u0000",
      );
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = staticText(node.left);
      const right = staticText(node.right);
      return left === undefined || right === undefined ? undefined : left + right;
    }
    return undefined;
  };
  // Consults the three taint sets, which the fixpoint below grows monotonically. Every branch is
  // an O(1) set membership test; the only recursion is a single walk of the node's own AST
  // subtree (a tree, so it terminates without a visited set). Initializer chains are resolved by
  // `taintedNames`, not by re-descending into bindings, so this is linear in the node size.
  const mentionsSdkManager = (node: ts.Node): boolean => {
    if (ts.isExpression(node) && staticText(node)?.toLowerCase().includes("sdkmanager")) {
      return true;
    }
    // `exec(`${sdkmanagerPath} --version`)` hides the tool name in the identifier, not in any
    // static chunk of the template.
    if (ts.isIdentifier(node) && node.text.toLowerCase().includes("sdkmanager")) {
      return true;
    }
    // A parameter carrying an sdkmanager-ish argument from some caller (issue #4341).
    if (ts.isIdentifier(node) && sdkManagerParams.has(node.text)) {
      return true;
    }
    // A variable whose initializer (transitively) carries sdkmanager — the memoized replacement
    // for a recursive walk of `initializers`.
    if (ts.isIdentifier(node) && taintedNames.has(node.text)) {
      return true;
    }
    // A call to a function whose return value carries sdkmanager (issue #4341).
    if (ts.isCallExpression(node)) {
      const name = calleeName(node.expression);
      if (name && returnsSdkManager.has(name)) {
        return true;
      }
    }
    let found = false;
    ts.forEachChild(node, (child) => {
      if (!found && mentionsSdkManager(child)) {
        found = true;
      }
    });
    return found;
  };

  // Fixpoint over the three taint sets. All only grow and are bounded by the finite sets of
  // parameter, function, and variable names in the file, so this terminates; each round is a
  // linear pass over the bindings, call sites, and function returns.
  let taintChanged = true;
  while (taintChanged) {
    taintChanged = false;
    for (const [name, boundValues] of initializers) {
      if (!taintedNames.has(name) && boundValues.some((value) => mentionsSdkManager(value))) {
        taintedNames.add(name);
        taintChanged = true;
      }
    }
    for (const { name, args } of callSites) {
      const targets = functionsByName.get(name);
      if (!targets) {
        continue;
      }
      for (const target of targets) {
        target.parameters.forEach((parameter, index) => {
          const argument = args[index];
          if (
            argument &&
            ts.isIdentifier(parameter.name) &&
            !sdkManagerParams.has(parameter.name.text) &&
            mentionsSdkManager(argument)
          ) {
            sdkManagerParams.add(parameter.name.text);
            taintChanged = true;
          }
        });
      }
    }
    for (const [name, returns] of returnsByName) {
      if (
        !returnsSdkManager.has(name) &&
        returns.some((expression) => mentionsSdkManager(expression))
      ) {
        returnsSdkManager.add(name);
        taintChanged = true;
      }
    }
    for (const { receiver, callback } of iterationCallbacks) {
      if (!mentionsSdkManager(receiver)) {
        continue;
      }
      for (const parameter of callback.parameters) {
        if (ts.isIdentifier(parameter.name) && !sdkManagerParams.has(parameter.name.text)) {
          sdkManagerParams.add(parameter.name.text);
          taintChanged = true;
        }
      }
    }
  }

  // `Bun.$`sdkmanager --list`` and the bare `$`...`` shell tag are never CallExpressions with a
  // launcher callee, so isLauncherReference never sees them (issue #4341).
  const isShellTag = (tag: ts.Expression): boolean =>
    (ts.isIdentifier(tag) && tag.text === "$") ||
    (ts.isPropertyAccessExpression(tag) && tag.name.text === "$");

  let directExecution = false;
  const inspect = (node: ts.Node): void => {
    if (directExecution) {
      return;
    }
    if (
      ts.isCallExpression(node) &&
      isLauncherReference(node.expression) &&
      node.arguments.some((argument) => mentionsSdkManager(argument))
    ) {
      directExecution = true;
      return;
    }
    if (
      ts.isTaggedTemplateExpression(node) &&
      isShellTag(node.tag) &&
      mentionsSdkManager(node.template)
    ) {
      directExecution = true;
      return;
    }
    ts.forEachChild(node, inspect);
  };
  inspect(sourceFile);
  return directExecution;
}

export function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(path);
    }
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

/**
 * Scan `<root>/src` for files that execute sdkmanager outside the owning client. Returns one
 * message per offender; an empty array means the boundary holds. Files are read in parallel so
 * the whole-tree scan stays fast enough for a bun test running under coverage instrumentation.
 */
export async function findOffenders(root: string): Promise<string[]> {
  const sources = await Promise.all(
    sourceFiles(join(root, SOURCE_ROOT)).map(async (file) => ({
      // `relative` yields OS separators (backslashes on Windows), but OWNER/EXCEPTIONS are keyed
      // with forward slashes — normalize so the owner exclusion matches and messages are portable.
      repoPath: relative(root, file).replace(/\\/g, "/"),
      source: await readFile(file, "utf8"),
    })),
  );
  return sources.flatMap(({ repoPath, source }) =>
    repoPath !== OWNER && !EXCEPTIONS.has(repoPath) && directlyExecutesSdkManager(source)
      ? [`${repoPath} directly executes sdkmanager; route it through ${OWNER} instead.`]
      : [],
  );
}

if (import.meta.main) {
  const root = process.cwd();
  const files = sourceFiles(join(root, SOURCE_ROOT));
  // A silently-empty scan yields zero offenders and passes green while checking nothing.
  if (files.length < 100) {
    console.error(
      `error: sdkmanager-execution-boundary scanned only ${files.length} files under ${SOURCE_ROOT}; expected the full source tree.`,
    );
    process.exit(1);
  }
  const offenders = await findOffenders(root);
  if (offenders.length > 0) {
    console.error(`error: sdkmanager execution must use ${OWNER}:`);
    for (const offender of offenders) {
      console.error(offender);
    }
    process.exit(1);
  }
  console.log("sdkmanager-execution-boundary: no direct production sdkmanager invocations.");
}
