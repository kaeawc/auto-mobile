import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";

const ROOT = resolve(import.meta.dir, "../..");
const NAME = /^(?:AUTOMOBILE_|AUTO_MOBILE_)[A-Z0-9_]+$/;

const INTERNAL: Record<string, string> = {
  AUTOMOBILE_TEST_MODE: "ADB test fake activation, not a device configuration option.",
  AUTOMOBILE_ALLOW_IN_MEMORY_DB: "Test-only opt-in to a nonpersistent database.",
  AUTOMOBILE_ACCEPTANCE_LIVE: "Live acceptance harness activation.",
  AUTOMOBILE_ACCEPTANCE_DISCOVERY_ORDER: "Acceptance harness discovery ordering.",
  AUTOMOBILE_ACCEPTANCE_DISCOVERY_CAPABILITY:
    "Private acceptance discovery capability between processes.",
  AUTOMOBILE_DAEMON_LIVE_ACCEPTANCE_STARTUP_SECRET: "Private live acceptance startup secret.",
  AUTOMOBILE_DAEMON_LAUNCH_CWD:
    "Manager-injected caller working directory for child path resolution.",
  AUTOMOBILE_DAEMON_LAUNCH_LOG_PATH: "Manager-injected child launch log ownership marker.",
  AUTOMOBILE_STARTUP_BENCHMARK: "Startup benchmark harness activation.",
  AUTO_MOBILE_STARTUP_BENCHMARK: "Legacy startup benchmark harness activation.",
  AUTOMOBILE_STARTUP_BENCHMARK_OUTPUT: "Startup benchmark harness output file.",
  AUTO_MOBILE_STARTUP_BENCHMARK_OUTPUT: "Legacy startup benchmark harness output file.",
  AUTOMOBILE_STARTUP_BENCHMARK_LABEL: "Startup benchmark harness sample label.",
  AUTO_MOBILE_STARTUP_BENCHMARK_LABEL: "Legacy startup benchmark harness sample label.",
};

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : entry.name.endsWith(".ts") ? [path] : [];
  });
}

type FunctionNode =
  | ts.FunctionDeclaration
  | ts.ArrowFunction
  | ts.MethodDeclaration
  | ts.FunctionExpression;
function enclosingFunction(node: ts.Node): FunctionNode | undefined {
  let parent = node.parent;
  while (parent) {
    if (
      ts.isFunctionDeclaration(parent) ||
      ts.isArrowFunction(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isFunctionExpression(parent)
    ) {
      return parent;
    }
    parent = parent.parent;
  }
  return undefined;
}
function functionName(node: FunctionNode): string {
  if (node.name) {
    return node.name.getText();
  }
  return ts.isVariableDeclaration(node.parent) ? node.parent.name.getText() : "";
}
function isEnvironment(node: ts.Node): boolean {
  if (ts.isIdentifier(node)) {
    return /^(env|environment|childEnv)$/.test(node.text);
  }
  return (
    ts.isPropertyAccessExpression(node) &&
    (node.getText() === "process.env" || /^(env|environment)$/.test(node.name.text))
  );
}
function isWrite(node: ts.Node): boolean {
  return (
    ts.isBinaryExpression(node.parent) &&
    node.parent.left === node &&
    node.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
  );
}

/** Syntax-only constant resolution: no imports execute and no application state is opened. */
function extractReads(sources: string[]): Set<string> {
  const files = sources
    .filter(
      (source) =>
        source.includes("env") || source.includes("AUTOMOBILE_") || source.includes("AUTO_MOBILE_"),
    )
    .map((source) => ts.createSourceFile("env.ts", source, ts.ScriptTarget.Latest, true));
  const exported = new Map<string, ts.Expression>();
  const locals = new Map<ts.SourceFile, Map<string, ts.Expression>>();
  const nodes: ts.Node[] = [];
  for (const file of files) {
    const bindings = new Map<string, ts.Expression>();
    locals.set(file, bindings);
    const visit = (node: ts.Node): void => {
      nodes.push(node);
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        bindings.set(node.name.text, node.initializer);
        if (
          ts.isVariableDeclarationList(node.parent) &&
          ts.isVariableStatement(node.parent.parent) &&
          node.parent.parent.modifiers?.some(
            (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
          )
        ) {
          exported.set(node.name.text, node.initializer);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  const values = (node: ts.Node | undefined, depth = 0): string[] => {
    if (!node || depth > 12) {
      return [];
    }
    if (ts.isStringLiteralLike(node)) {
      return [node.text];
    }
    if (ts.isIdentifier(node)) {
      return values(
        locals.get(node.getSourceFile())?.get(node.text) ?? exported.get(node.text),
        depth + 1,
      );
    }
    if (
      ts.isAsExpression(node) ||
      ts.isParenthesizedExpression(node) ||
      ts.isSatisfiesExpression(node)
    ) {
      return values(node.expression, depth + 1);
    }
    if (ts.isArrayLiteralExpression(node)) {
      return node.elements.flatMap((entry) => values(entry, depth + 1));
    }
    if (ts.isConditionalExpression(node)) {
      return [...values(node.whenTrue, depth + 1), ...values(node.whenFalse, depth + 1)];
    }
    if (ts.isPropertyAccessExpression(node)) {
      const binding = ts.isIdentifier(node.expression)
        ? (locals.get(node.getSourceFile())?.get(node.expression.text) ??
          exported.get(node.expression.text))
        : undefined;
      const object = binding && ts.isAsExpression(binding) ? binding.expression : binding;
      if (object && ts.isObjectLiteralExpression(object)) {
        return object.properties.flatMap((property) =>
          ts.isPropertyAssignment(property) && property.name.getText() === node.name.text
            ? values(property.initializer, depth + 1)
            : [],
        );
      }
    }
    if (ts.isBinaryExpression(node)) {
      const left = values(node.left, depth + 1);
      const right = values(node.right, depth + 1);
      return node.operatorToken.kind === ts.SyntaxKind.PlusToken
        ? left.flatMap((a) => right.map((b) => a + b))
        : [...left, ...right];
    }
    return [];
  };
  const environmentAliases = new Set<ts.Node>();
  for (const node of nodes) {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      isEnvironment(node.initializer)
    ) {
      environmentAliases.add(node.name);
    }
  }
  const environment = (node: ts.Node): boolean =>
    isEnvironment(node) ||
    (ts.isIdentifier(node) &&
      [...environmentAliases].some(
        (alias) => alias.getSourceFile() === node.getSourceFile() && alias.getText() === node.text,
      ));
  const reads = new Set<string>();
  const add = (names: string[]): void => {
    for (const name of names) {
      if (NAME.test(name)) {
        reads.add(name);
      }
    }
  };
  // Infer wrappers from their actual env-index reads, then propagate parameter positions
  // through wrapper calls (e.g. navigationRetention.resolve -> readPositiveIntEnv).
  const helpers = new Map<string, Set<number>>();
  const parameterRead = (node: ts.Node, key: ts.Node): void => {
    const fn = enclosingFunction(node);
    if (!fn) {
      return;
    }
    const index = fn.parameters.findIndex(
      (parameter) => parameter.name.getText() === key.getText(),
    );
    if (index < 0) {
      return;
    }
    const name = functionName(fn);
    const indices = helpers.get(name) ?? new Set<number>();
    indices.add(index);
    helpers.set(name, indices);
  };
  for (const node of nodes) {
    if (ts.isPropertyAccessExpression(node) && environment(node.expression) && !isWrite(node)) {
      add([node.name.text]);
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer &&
      environment(node.initializer)
    ) {
      add(
        node.name.elements.map((element) =>
          (element.propertyName ?? element.name).getText().replaceAll('"', ""),
        ),
      );
    }
    if (!ts.isElementAccessExpression(node) || !environment(node.expression) || isWrite(node)) {
      continue;
    }
    add(values(node.argumentExpression));
    parameterRead(node, node.argumentExpression);
    // for (const key of keys) env[key]: propagate the array-valued parameter.
    let parent: ts.Node | undefined = node.parent;
    while (parent && !ts.isSourceFile(parent)) {
      if (
        ts.isForOfStatement(parent) &&
        ts.isVariableDeclarationList(parent.initializer) &&
        parent.initializer.declarations.some(
          (declaration) => declaration.name.getText() === node.argumentExpression.getText(),
        )
      ) {
        add(values(parent.expression));
        // FfmpegResolverOptions.environmentKeys supplies the names consumed by env[key].
        if (
          ts.isBinaryExpression(parent.expression) &&
          parent.expression.left.getText() === "options.environmentKeys"
        ) {
          for (const candidate of nodes) {
            if (
              ts.isPropertyAssignment(candidate) &&
              candidate.name.getText() === "environmentKeys"
            ) {
              add(values(candidate.initializer));
            }
          }
        }
        parameterRead(node, parent.expression);
      }
      parent = parent.parent;
    }
    // The only platform-composed read; IOSCtrlProxyPlatform = "device" | "simulator".
    if (
      ts.isTemplateExpression(node.argumentExpression) &&
      node.argumentExpression.head.text === "AUTOMOBILE_IOS_CTRL_PROXY_APP_HASH_"
    ) {
      add([
        "AUTOMOBILE_IOS_CTRL_PROXY_APP_HASH_DEVICE",
        "AUTOMOBILE_IOS_CTRL_PROXY_APP_HASH_SIMULATOR",
      ]);
    }
    // OutputReductionFlagSpec.env is the typed table consumed by env[spec.env].
    if (node.argumentExpression.getText() === "spec.env") {
      for (const candidate of nodes.filter(
        (candidate) => candidate.getSourceFile() === node.getSourceFile(),
      )) {
        if (ts.isPropertyAssignment(candidate) && candidate.name.getText() === "env") {
          add(values(candidate.initializer));
        }
      }
    }
  }
  let previousSize = -1;
  const helperSize = (): number =>
    [...helpers.values()].reduce((sum, indices) => sum + indices.size, 0);
  while (previousSize !== helperSize()) {
    previousSize = helperSize();
    for (const node of nodes) {
      if (!ts.isCallExpression(node)) {
        continue;
      }
      const name = ts.isPropertyAccessExpression(node.expression)
        ? node.expression.name.text
        : node.expression.getText();
      const indices = helpers.get(name);
      if (indices) {
        for (const index of indices) {
          add(values(node.arguments[index]));
          if (node.arguments[index]) {
            parameterRead(node, node.arguments[index]);
          }
        }
      }
      if (
        name === "getEnvVar" ||
        (name === "get" &&
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.expression.getText() === "this.environment")
      ) {
        add(values(node.arguments[0]));
      }
    }
  }
  return reads;
}

/** Only first cells of table rows and headings declare variables; examples/prose do not. */
function documentedNames(markdown: string): Set<string> {
  const names = new Set<string>();
  let fenced = false;
  for (const line of markdown.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) {
      continue;
    }
    const declaration = line.startsWith("|")
      ? line.split("|")[1]
      : /^#{1,6}\s/.test(line)
        ? line
        : "";
    for (const match of declaration.matchAll(/`((?:AUTOMOBILE_|AUTO_MOBILE_)[A-Z0-9_]+)`/g)) {
      names.add(match[1]);
    }
  }
  return names;
}
function violations(
  reads: Set<string>,
  docs: Set<string>,
  internal: Record<string, string>,
): string[] {
  return [
    ...[...reads]
      .filter((name) => !docs.has(name) && !Object.hasOwn(internal, name))
      .map((name) => `Undocumented: ${name}`),
    ...[...docs].filter((name) => !reads.has(name)).map((name) => `Stale documentation: ${name}`),
    ...Object.keys(internal)
      .filter((name) => !reads.has(name))
      .map((name) => `Stale internal: ${name}`),
    ...Object.keys(internal)
      .filter((name) => docs.has(name))
      .map((name) => `Ambiguous: ${name}`),
  ].sort();
}

describe("environment variable documentation", () => {
  let reads: Set<string>;
  let docs: Set<string>;
  beforeAll(() => {
    reads = extractReads(
      sourceFiles(resolve(ROOT, "src")).map((file) => readFileSync(file, "utf8")),
    );
    docs = documentedNames(
      readFileSync(resolve(ROOT, "docs/using/environment-variables.md"), "utf8"),
    );
  }, 15_000);
  test("every source read is public documentation or explicitly internal", () => {
    expect(violations(reads, docs, INTERNAL)).toEqual([]);
    expect(Object.values(INTERNAL).every((reason) => reason.length > 0)).toBe(true);
  });
  test("extractor recognizes reads and ignores writes, comments and messages", () => {
    const found = extractReads([
      `
      const KEY = "AUTOMOBILE_KEY";
      function read(name: string) { return process.env[name]; }
      const env = process.env;
      process.env.AUTOMOBILE_DIRECT;
      process.env["AUTO_MOBILE_BRACKET"];
      const { AUTOMOBILE_DESTRUCTURED: renamed } = env;
      read(KEY);
      env.AUTOMOBILE_INJECTED;
      this.environment.getEnvVar("AUTOMOBILE_HELPER");
      process.env.AUTOMOBILE_WRITE = "1";
      // process.env.AUTOMOBILE_COMMENT
      const message = "AUTOMOBILE_MESSAGE";
    `,
    ]);
    expect([...found].sort()).toEqual([
      "AUTOMOBILE_DESTRUCTURED",
      "AUTOMOBILE_DIRECT",
      "AUTOMOBILE_HELPER",
      "AUTOMOBILE_INJECTED",
      "AUTOMOBILE_KEY",
      "AUTO_MOBILE_BRACKET",
    ]);
    expect(violations(found, new Set(), {})).toContain("Undocumented: AUTOMOBILE_KEY");
    expect(violations(new Set(), new Set(["AUTOMOBILE_STALE"]), {})).toEqual([
      "Stale documentation: AUTOMOBILE_STALE",
    ]);
  });
  test("constant tables, imported keys and composed names remain covered", () => {
    const found = extractReads([
      'export const IMPORTED = "AUTOMOBILE_IMPORTED";',
      `
        function first(env: NodeJS.ProcessEnv, keys: string[]) {
          for (const key of keys) { if (env[key]) return env[key]; }
        }
        function nested(keys: string[]) { return first(process.env, keys); }
        nested(["AUTOMOBILE_ARRAY"]);
        const settings = process.env;
        settings.AUTOMOBILE_ALIAS;
        process.env[IMPORTED];
        const suffix = "STATIC";
        process.env["AUTOMOBILE_" + suffix];
        process.env[\`AUTOMOBILE_IOS_CTRL_PROXY_APP_HASH_\${envPlatform}\`];
        const specs = [{ env: "AUTOMOBILE_SPEC" }];
        for (const spec of specs) { env[spec.env]; }
      `,
    ]);
    expect([...found].sort()).toEqual([
      "AUTOMOBILE_ALIAS",
      "AUTOMOBILE_ARRAY",
      "AUTOMOBILE_IMPORTED",
      "AUTOMOBILE_IOS_CTRL_PROXY_APP_HASH_DEVICE",
      "AUTOMOBILE_IOS_CTRL_PROXY_APP_HASH_SIMULATOR",
      "AUTOMOBILE_SPEC",
      "AUTOMOBILE_STATIC",
    ]);
  });
  test("markdown declarations exclude prose and code fences; internal entries cannot drift", () => {
    expect([
      ...documentedNames(
        "| `AUTOMOBILE_ROW` | effect | default |\n## `AUTOMOBILE_HEADING`\nProse `AUTOMOBILE_PROSE`\n```\n| `AUTOMOBILE_EXAMPLE` |\n```",
      ),
    ]).toEqual(["AUTOMOBILE_ROW", "AUTOMOBILE_HEADING"]);
    expect(
      violations(new Set(["AUTOMOBILE_INTERNAL"]), new Set(["AUTOMOBILE_INTERNAL"]), {
        AUTOMOBILE_INTERNAL: "private",
        AUTOMOBILE_STALE: "removed",
      }),
    ).toEqual(["Ambiguous: AUTOMOBILE_INTERNAL", "Stale internal: AUTOMOBILE_STALE"]);
  });
});
