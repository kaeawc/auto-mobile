import { beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import ts from "typescript";
import { typeScriptFiles, relativePosix, readGuardFile } from "./astGuard";

const ROOT = join(import.meta.dir, "../..");
const RESOLVER = "src/utils/ios-cmdline-tools/simulatorOwnContainer.ts";
const EXEMPT: Readonly<Record<string, string>> = {
  "src/utils/ios-cmdline-tools/DeviceAppManager.ts":
    "Read-only app bundle lookup, never a data container.",
  "src/features/utility/DeepLinkManager.ts": "Read-only app bundle metadata lookup.",
  "src/features/observe/IosPackageSigningInspector.ts": "Read-only app bundle signing inspection.",
  "src/daemon/sessionBroker/mutations/iosResetPort.ts":
    "Groups listing; deletion already requires the target device's own AppGroup directory.",
};

/** Inspect cooked strings, including constant expressions and shell command prefixes. */
function mayContainCommand(source: string): boolean {
  return source.includes("container") || source.includes("\\u") || source.includes("\\x");
}

function constantString(node: ts.Node): string | undefined {
  if (ts.isStringLiteralLike(node)) {
    return node.text;
  }
  if (ts.isParenthesizedExpression(node)) {
    return constantString(node.expression);
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = constantString(node.left);
    const right = constantString(node.right);
    return left === undefined || right === undefined ? undefined : left + right;
  }
  if (ts.isTemplateExpression(node)) {
    let value = node.head.text;
    for (const span of node.templateSpans) {
      const part = constantString(span.expression);
      if (part === undefined) {
        return undefined;
      }
      value += part + span.literal.text;
    }
    return value;
  }
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === "join" &&
    ts.isArrayLiteralExpression(node.expression.expression) &&
    node.arguments.length === 1
  ) {
    const separator = constantString(node.arguments[0]!);
    const parts = node.expression.expression.elements.map(constantString);
    if ((separator === "" || separator === "_") && parts.every((part) => part !== undefined)) {
      return parts.join(separator);
    }
  }
  return undefined;
}
function scan(source: string, exempt = false): number[] {
  if (!mayContainCommand(source)) {
    return [];
  }
  const ast = ts.createSourceFile("guard.ts", source, ts.ScriptTarget.Latest, true);
  const violations: number[] = [];
  const visit = (node: ts.Node): void => {
    const value =
      constantString(node) ??
      (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)
        ? node.text
        : undefined);
    if (value !== undefined && /get_app_container/.test(value)) {
      const parent = node.parent;
      const kind = ts.isArrayLiteralExpression(parent) ? parent.elements[3] : undefined;
      const allowed =
        exempt &&
        ts.isArrayLiteralExpression(parent) &&
        parent.elements[0] === node &&
        ts.isStringLiteralLike(node) &&
        value === "get_app_container" &&
        kind &&
        ts.isStringLiteralLike(kind) &&
        (kind.text === "app" || kind.text === "groups");
      if (!allowed) {
        violations.push(ast.getLineAndCharacterOfPosition(node.getStart()).line + 1);
      }
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return violations;
}

describe("simulator container command scanner", () => {
  test.each([
    '"get_app" + "_container"',
    '"get_" + "app_container"',
    '`get${"_"}app_container`',
    '["get_app", "container"].join("_")',
    '["get_", "app_container"].join("")',

    '["get_app_container", id, bundle, "data"]',
    "`get_app_container ${id} ${bundle} data`",
    '"get_app_container"',
    "\"'get_app_container' id bundle data\"",
    '\"get_app_\" + \"container\"',
    '\"xcrun simctl get_app_container id bundle data\"',
    "`$" + "{prefix} get_app_container id bundle data`",
    '\"get\\u005fapp_container\"',
    '\"get\\x5fapp_container\"',
  ])("rejects %s", (source) => {
    expect(scan(source)).toEqual([1]);
  });
  test("ignores comments and unrelated literals", () => {
    expect(scan('// "get_app_container"\nconst text = "unrelated command";')).toEqual([]);
  });
  test("exemptions only permit app and groups array commands", () => {
    expect(scan('["get_app_container", id, bundle, "app"]', true)).toEqual([]);
    expect(scan('["get_app_container", id, bundle, "groups"]', true)).toEqual([]);
    expect(scan('["get_app_container", id, bundle, "data"]', true)).toEqual([1]);
    expect(scan("`get_app_container ${id} ${bundle} app`", true)).toEqual([1]);
    expect(scan('["xcrun simctl get_app_container", id, bundle, "app"]', true)).toEqual([1]);
  });
});

describe("all simulator data container consumers use the ownership resolver", () => {
  const offenders: string[] = [];
  const used = new Set<string>();
  beforeAll(() => {
    for (const file of typeScriptFiles(join(ROOT, "src"))) {
      const source = readGuardFile(file);
      if (!mayContainCommand(source)) {
        continue;
      }
      const relative = relativePosix(ROOT, file);
      if (relative === RESOLVER) {
        continue;
      }
      if (relative in EXEMPT && scan(source).length) {
        used.add(relative);
      }
      for (const line of scan(source, relative in EXEMPT)) {
        offenders.push(`${relative}:${line}`);
      }
    }
  }, 30_000);
  test("no raw data container commands remain", () => {
    expect(offenders).toEqual([]);
  });
  test("exemptions are used and explained", () => {
    expect(
      Object.entries(EXEMPT).filter(([file, reason]) => !used.has(file) || !reason.trim()),
    ).toEqual([]);
  });
});
