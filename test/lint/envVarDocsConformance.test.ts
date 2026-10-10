import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import path, { resolve } from "node:path";
import ts from "typescript";
import { moduleExportResolver, resolveModule, toPosixPath } from "./moduleExportResolver";

const ROOT = resolve(import.meta.dir, "../..");
const NAME = /^(?:AUTOMOBILE_|AUTO_MOBILE_)[A-Z0-9_]+$/;

const INTERNAL: Record<string, string> = {
  AUTOMOBILE_MANAGED_SLOT_CONFIG:
    "Experimental managed-slot launch config (#11172); documented in managed-slots.md with #11180.",
  AUTOMOBILE_TEST_MODE: "ADB test fake activation, not a device configuration option.",
  AUTOMOBILE_ALLOW_IN_MEMORY_DB: "Test-only opt-in to a nonpersistent database.",
  AUTOMOBILE_ALLOW_REAL_CTRL_PROXY_WEBSOCKET: "Test-only opt-in to a real CtrlProxy WebSocket.",
  AUTOMOBILE_UNIT_TEST_ISOLATED_DATA_DIR:
    "Unit-test preload marker for the per-process data directory it assigned.",
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
    return /(?:env|environment)$/i.test(node.text);
  }
  return (
    ts.isPropertyAccessExpression(node) &&
    (node.getText() === "process.env" || /(?:env|environment)$/i.test(node.name.text))
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
function extractReads(sources: { path: string; text: string }[]): Set<string> {
  const texts = new Map(sources.map(({ path, text }) => [toPosixPath(resolve(path)), text]));
  const known = new Set(texts.keys());
  const files: ts.SourceFile[] = [];
  const parsed = new Set<string>();
  const parse = (path: string): void => {
    const text = texts.get(path);
    if (text === undefined || parsed.has(path)) {
      return;
    }
    parsed.add(path);
    files.push(ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true));
  };
  for (const [path, text] of texts) {
    if (
      text.toLowerCase().includes("env") ||
      text.includes("AUTOMOBILE_") ||
      text.includes("AUTO_MOBILE_")
    ) {
      parse(path);
    }
  }
  // Retain the entire dependency closure, including barrels with no environment text.
  for (const file of files) {
    for (const node of file.statements) {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        const path = resolveModule(file.fileName, node.moduleSpecifier.text, known);
        if (path) {
          parse(path);
        }
      }
    }
  }
  const resolver = moduleExportResolver(files);
  const locals = new Map<string, Map<string, ts.Expression>>();
  const typedEnvironments = new Map<string, Set<string>>();
  const nodes: ts.Node[] = [];
  for (const file of files) {
    // Dependency modules remain available; only potential env readers need traversal.
    if (
      !file.text.toLowerCase().includes("env") &&
      !file.text.includes("AUTOMOBILE_") &&
      !file.text.includes("AUTO_MOBILE_")
    ) {
      continue;
    }
    const bindings = new Map<string, ts.Expression>();
    locals.set(file.fileName, bindings);
    const typed = new Set<string>();
    typedEnvironments.set(file.fileName, typed);
    const visit = (node: ts.Node): void => {
      nodes.push(node);
      if (
        (ts.isParameter(node) ||
          ts.isVariableDeclaration(node) ||
          ts.isPropertyDeclaration(node) ||
          ts.isPropertySignature(node)) &&
        ts.isIdentifier(node.name) &&
        node.type &&
        ts.isTypeReferenceNode(node.type) &&
        /^(?:NodeJS\.)?ProcessEnv$/.test(node.type.typeName.getText())
      ) {
        typed.add(node.name.text);
      }
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        bindings.set(node.name.text, node.initializer);
      }
      if (ts.isPropertyDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        bindings.set(node.name.text, node.initializer);
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  const importedName = resolver.importedName;
  const values = (node: ts.Node | undefined, depth = 0): string[] => {
    if (!node || depth > 12) {
      return [];
    }
    if (ts.isStringLiteralLike(node)) {
      return [node.text];
    }
    if (ts.isIdentifier(node)) {
      return values(
        locals.get(node.getSourceFile().fileName)?.get(node.text) ??
          resolver.localValue(node) ??
          resolver.importedValue(node),
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
      const namespace = resolver.namespaceValue(node);
      if (namespace) {
        return values(namespace, depth + 1);
      }
      const binding = ts.isIdentifier(node.expression)
        ? (locals.get(node.getSourceFile().fileName)?.get(node.expression.text) ??
          resolver.localValue(node.expression) ??
          resolver.importedValue(node.expression))
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
  const environment = (node: ts.Node, depth = 0): boolean => {
    if (depth > 12) {
      return false;
    }
    if (isEnvironment(node)) {
      return true;
    }
    if (
      ts.isAsExpression(node) ||
      ts.isParenthesizedExpression(node) ||
      ts.isSatisfiesExpression(node)
    ) {
      return environment(node.expression, depth + 1);
    }
    const name = ts.isIdentifier(node)
      ? node.text
      : ts.isPropertyAccessExpression(node)
        ? node.name.text
        : undefined;
    if (name && typedEnvironments.get(node.getSourceFile().fileName)?.has(name)) {
      return true;
    }
    const initializer = name ? locals.get(node.getSourceFile().fileName)?.get(name) : undefined;
    return initializer ? environment(initializer, depth + 1) : false;
  };
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
        : ts.isIdentifier(node.expression)
          ? importedName(node.expression)
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

function tableCells(line: string): string[] {
  const cells: string[] = [];
  let start = 0;
  let escaped = false;
  for (let index = 0; index < line.length; index++) {
    const character = line[index];
    if (character === "|" && !escaped) {
      cells.push(line.slice(start, index));
      start = index + 1;
    }
    escaped = character === "\\" && !escaped;
  }
  cells.push(line.slice(start));
  return cells.slice(1, -1);
}

function tableViolations(markdown: string): string[] {
  const errors: string[] = [];
  let expected: number | undefined;
  let fenced = false;
  for (const [index, line] of markdown.split("\n").entries()) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
    }
    if (fenced || !line.startsWith("|")) {
      expected = undefined;
      continue;
    }
    const count = tableCells(line).length;
    expected ??= count;
    if (count !== expected) {
      errors.push(`Line ${index + 1}: expected ${expected} cells, found ${count}`);
    }
  }
  return errors;
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
      ? tableCells(line)[0]
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
  let markdown: string;
  // Parses the whole src/ tree: ~1s on a quiet machine, but Fast Validation runs this
  // alongside ten other checks on a 4-core runner, where a passing run already took ~11s and
  // a loaded one exceeded the old 15s hook cap. The scan is not a unit under the per-test budget.
  beforeAll(() => {
    reads = extractReads(
      sourceFiles(resolve(ROOT, "src")).map((path) => ({ path, text: readFileSync(path, "utf8") })),
    );
    markdown = readFileSync(resolve(ROOT, "docs/using/environment-variables.md"), "utf8");
    docs = documentedNames(markdown);
  }, 60_000);
  test("every source read is public documentation or explicitly internal", () => {
    expect(violations(reads, docs, INTERNAL)).toEqual([]);
    expect(Object.values(INTERNAL).every((reason) => reason.length > 0)).toBe(true);
  });
  test("every documentation table row has the header's cell count", () => {
    expect(tableViolations(markdown)).toEqual([]);
    expect(tableViolations("| A | B |\n| --- | --- |\n| x | `a \\|\\| b` |\n")).toEqual([]);
    expect(tableViolations("| A | B |\n| --- | --- |\n| x | `a || b` |\n")).toEqual([
      "Line 3: expected 2 cells, found 4",
    ]);
    expect(tableCells(String.raw`| x | even \\| y |`)).toHaveLength(3);
    expect(tableViolations("```\n| ignored |\n| x | y |\n```\n| A | B |\n| x | y |\n")).toEqual([]);
  });
  test("injected environment names, types and alias chains cover every access form", () => {
    const found = extractReads(
      [
        `
        function injected(processEnv: NodeJS.ProcessEnv, runtimeENV: unknown, configEnvironment: unknown) {
          processEnv["AUTOMOBILE_PARAM_BRACKET"];
          processEnv.AUTOMOBILE_PARAM_DOT;
          const { AUTOMOBILE_PARAM_DESTRUCTURED: renamed } = processEnv;
          runtimeENV.AUTOMOBILE_SUFFIX;
          configEnvironment["AUTOMOBILE_ENVIRONMENT_SUFFIX"];
          processEnv.AUTOMOBILE_PARAM_WRITE = "1";
          processEnv["AUTOMOBILE_BRACKET_WRITE"] = "1";
        }
        const settings: ProcessEnv = {};
        settings.AUTOMOBILE_TYPED;
        class Reader { private config: NodeJS.ProcessEnv; read() { return this.config.AUTOMOBILE_PROPERTY; } }
        class AliasReader { private settings = process.env; read() { return this.settings.AUTOMOBILE_PROPERTY_ALIAS; } }
        const first = process.env;
        const second = first;
        const third = (second as NodeJS.ProcessEnv);
        const KEY = "AUTOMOBILE_CHAIN";
        third[KEY];
        const { AUTOMOBILE_CHAIN_DESTRUCTURED } = third;
        third.AUTOMOBILE_CHAIN_WRITE = "1";
        const cycleA = cycleB;
        const cycleB = cycleA;
        cycleA.AUTOMOBILE_CYCLE;
        const ordinary = {};
        ordinary.AUTOMOBILE_NOT_ENV;
      `,
        `const settings = {}; settings.AUTOMOBILE_OTHER_FILE;`,
      ].map((text, index) => ({ path: `/virtual/${index === 0 ? "keys" : "consumer"}.ts`, text })),
    );
    expect([...found].sort()).toEqual([
      "AUTOMOBILE_CHAIN",
      "AUTOMOBILE_CHAIN_DESTRUCTURED",
      "AUTOMOBILE_ENVIRONMENT_SUFFIX",
      "AUTOMOBILE_PARAM_BRACKET",
      "AUTOMOBILE_PARAM_DESTRUCTURED",
      "AUTOMOBILE_PARAM_DOT",
      "AUTOMOBILE_PROPERTY",
      "AUTOMOBILE_PROPERTY_ALIAS",
      "AUTOMOBILE_SUFFIX",
      "AUTOMOBILE_TYPED",
    ]);
  });
  test("Windows module paths resolve files, directory indexes and JavaScript specifiers", () => {
    const known = new Set(["D:/virtual/b.ts", "D:/virtual/hop/index.ts"]);
    for (const [specifier, expected] of [
      ["./b", "D:/virtual/b.ts"],
      ["./hop", "D:/virtual/hop/index.ts"],
      ["./b.js", "D:/virtual/b.ts"],
      ["./b.ts", "D:/virtual/b.ts"],
    ]) {
      expect(resolveModule("D:\\virtual\\c.ts", specifier, known, path.win32)).toBe(expected);
    }
  });
  test("Windows-style source paths retain imported and re-exported environment reads", () => {
    const found = extractReads([
      {
        path: "D:\\virtual\\b.ts",
        text: 'export const KEY = "AUTOMOBILE_WINDOWS"; export const OTHER = "AUTOMOBILE_WINDOWS_NAMESPACE";',
      },
      { path: "D:\\virtual\\hop\\index.ts", text: 'export { KEY } from "../b.js";' },
      {
        path: "D:\\virtual\\c.ts",
        text: `import { KEY as RENAMED } from "./hop";
          import * as NS from "./b";
          process.env[RENAMED]; process.env[NS.OTHER];`,
      },
    ]);
    expect([...found].sort()).toEqual(["AUTOMOBILE_WINDOWS", "AUTOMOBILE_WINDOWS_NAMESPACE"]);
  });
  test("named and namespace imports resolve exported keys under local aliases", () => {
    const found = extractReads(
      [
        'export const KEY = "AUTOMOBILE_IMPORTED_ALIAS"; export const OTHER = "AUTOMOBILE_NAMESPACE";',
        `
        import { KEY as RENAMED } from "./keys";
        import * as C from "./keys";
        process.env[RENAMED];
        process.env[C.OTHER];
        process.env[C.OTHER] = "1";
      `,
      ].map((text, index) => ({ path: `/virtual/${index === 0 ? "keys" : "consumer"}.ts`, text })),
    );
    expect([...found].sort()).toEqual(["AUTOMOBILE_IMPORTED_ALIAS", "AUTOMOBILE_NAMESPACE"]);
  });
  test("imported helper aliases retain inferred reads and getEnvVar recognition", () => {
    const found = extractReads(
      [
        `export function readPositiveIntEnv(settings: NodeJS.ProcessEnv, key: string) { return settings[key]; }`,
        `
        import { readPositiveIntEnv as readInt, getEnvVar as getValue } from "./reader";
        import * as R from "./reader";
        readInt(process.env, "AUTOMOBILE_ALIASED_HELPER");
        R.readPositiveIntEnv(process.env, "AUTOMOBILE_NAMESPACE_HELPER");
        getValue("AUTOMOBILE_ALIASED_GET_ENV");
      `,
      ].map((text, index) => ({
        path: `/virtual/${index === 0 ? "reader" : "consumer"}.ts`,
        text,
      })),
    );
    expect([...found].sort()).toEqual([
      "AUTOMOBILE_ALIASED_GET_ENV",
      "AUTOMOBILE_ALIASED_HELPER",
      "AUTOMOBILE_NAMESPACE_HELPER",
    ]);
  });
  test("extractor recognizes reads and ignores writes, comments and messages", () => {
    const found = extractReads(
      [
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
      ].map((text, index) => ({ path: `/virtual/${index === 0 ? "keys" : "consumer"}.ts`, text })),
    );
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
    const found = extractReads(
      [
        'export const IMPORTED = "AUTOMOBILE_IMPORTED";',
        `
        import { IMPORTED } from "./keys";
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
      ].map((text, index) => ({ path: `/virtual/${index === 0 ? "keys" : "consumer"}.ts`, text })),
    );
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
  test("same-named exported constants resolve by source module", () => {
    const modules = [
      { path: "/virtual/b.ts", text: 'export const KEY = "AUTOMOBILE_UNDOCUMENTED";' },
      { path: "/virtual/a.ts", text: 'export const KEY = "AUTOMOBILE_DOCUMENTED";' },
    ];
    const consumer = (module: string, name: string) => ({
      path: `/virtual/${name}.ts`,
      text: `import { KEY } from "./${module}"; process.env[KEY];`,
    });
    const reads = extractReads([...modules, consumer("a", "c1"), consumer("b", "c2")]);
    expect([...reads].sort()).toEqual(["AUTOMOBILE_DOCUMENTED", "AUTOMOBILE_UNDOCUMENTED"]);
    expect(violations(reads, new Set(["AUTOMOBILE_DOCUMENTED"]), {})).toEqual([
      "Undocumented: AUTOMOBILE_UNDOCUMENTED",
    ]);
    expect([...extractReads([...modules, consumer("b", "c2")])]).toEqual([
      "AUTOMOBILE_UNDOCUMENTED",
    ]);
  });
  test("aliased imports ignore same-named exports from other modules", () => {
    expect([
      ...extractReads([
        { path: "/virtual/b.ts", text: 'export const KEY = "AUTOMOBILE_B";' },
        {
          path: "/virtual/a.ts",
          text: 'export const KEY = "AUTOMOBILE_A"; export const K = "AUTOMOBILE_K";',
        },
        { path: "/virtual/c.ts", text: 'import { KEY as K } from "./b"; process.env[K];' },
      ]),
    ]).toEqual(["AUTOMOBILE_B"]);
  });
  test("re-export chains resolve named, renamed, wildcard and local exports and terminate cycles", () => {
    for (const barrel of [
      'export { KEY } from "./b";',
      'export * from "./b";',
      'export { KEY as RENAMED } from "./b";',
      'import { KEY } from "./b"; export { KEY };',
      'const X = "AUTOMOBILE_B"; export { X as KEY };',
    ]) {
      const name = barrel.includes("RENAMED") ? "RENAMED" : "KEY";
      expect([
        ...extractReads([
          { path: "/virtual/b.ts", text: 'export const KEY = "AUTOMOBILE_B";' },
          { path: "/virtual/barrel.ts", text: barrel },
          { path: "/virtual/hop/index.ts", text: 'export * from "../barrel.js";' },
          {
            path: "/virtual/c.ts",
            text: `import { ${name} } from "./barrel"; process.env[${name}];`,
          },
          { path: "/virtual/d.ts", text: `import { ${name} } from "./hop"; process.env[${name}];` },
        ]),
      ]).toEqual(["AUTOMOBILE_B"]);
    }
    expect([
      ...extractReads([
        { path: "/virtual/a.ts", text: 'export * from "./b";' },
        { path: "/virtual/b.ts", text: 'export { KEY } from "./a";' },
        { path: "/virtual/decoy.ts", text: 'export const KEY = "AUTOMOBILE_DECOY";' },
        { path: "/virtual/c.ts", text: 'import { KEY } from "./a"; process.env[KEY];' },
      ]),
    ]).toEqual([]);
  });
  test("namespace imports resolve members in their source module", () => {
    expect([
      ...extractReads([
        { path: "/virtual/b.ts", text: 'export const KEY = "AUTOMOBILE_B";' },
        { path: "/virtual/a.ts", text: 'export const KEY = "AUTOMOBILE_A";' },
        { path: "/virtual/c.ts", text: 'import * as NS from "./b"; process.env[NS.KEY];' },
      ]),
    ]).toEqual(["AUTOMOBILE_B"]);
  });
  test("missing and package imports never fall back to unrelated exports", () => {
    for (const module of ["./missing", "package"]) {
      expect([
        ...extractReads([
          { path: "/virtual/a.ts", text: 'export const KEY = "AUTOMOBILE_A";' },
          {
            path: "/virtual/c.ts",
            text: `import { KEY } from "${module}"; import * as NS from "${module}"; process.env[KEY]; process.env[NS.KEY];`,
          },
        ]),
      ]).toEqual([]);
    }
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
