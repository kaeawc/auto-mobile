import { beforeAll, describe, expect, test } from "bun:test";

import path from "node:path";
import { type Program } from "oxc-parser";
import { parseGuardSource, unwrapCallee, readGuardFile, GuardVisitor as Visitor } from "./astGuard";

/**
 * #11837: `TapOnElement.ts` must not branch on the device platform. Platform behavior lives in
 * `strategies/` (`TapStrategy` and the `tapPlatformTraits` table). Any
 * `<expr>.platform ===|!==|==|!= "android"|"ios"` comparison, membership check, or
 * `case "android"|"ios"` of a `switch (<expr>.platform)` fails the guard.
 */

const FILE = "src/features/action/TapOnElement.ts";
const ROOT = path.resolve(import.meta.dir, "../..");
const PLATFORMS = new Set(["android", "ios"]);

type Node = { type: string; [key: string]: unknown };

function isPlatformAccess(node: unknown): boolean {
  const n = node as Node | undefined;
  if (!n) {
    return false;
  }
  if (n.type === "Identifier") {
    return n.name === "platform";
  }
  return (
    n.type === "MemberExpression" &&
    (n.property as Node).type === "Identifier" &&
    (n.property as Node).name === "platform"
  );
}

function literalString(node: unknown): string | undefined {
  const n = node as Node | undefined;
  if (n?.type === "Literal" && typeof n.value === "string") {
    return n.value;
  }
  const quasis = n?.quasis as Array<{ value: { cooked: string } }> | undefined;
  return n?.type === "TemplateLiteral" && (n.expressions as unknown[]).length === 0
    ? quasis?.[0].value.cooked
    : undefined;
}

/** `const IOS = "ios"` style aliases, so a renamed literal still counts as a platform name. */
function platformAliases(program: Program): Set<string> {
  const aliases = new Set<string>();
  new Visitor({
    VariableDeclarator(node) {
      const value = literalString(node.init);
      if (node.id.type === "Identifier" && value !== undefined && PLATFORMS.has(value)) {
        aliases.add(node.id.name);
      }
    },
  }).visit(program);
  return aliases;
}

export function countPlatformComparisons(file: string, source: string): number {
  let count = 0;
  const program = parseGuardSource(file, source);
  const aliases = platformAliases(program);
  const isPlatformName = (node: unknown): boolean => {
    const value = literalString(node);
    if (value !== undefined) {
      return PLATFORMS.has(value);
    }
    const n = node as Node | undefined;
    return n?.type === "Identifier" && aliases.has(n.name as string);
  };
  new Visitor({
    BinaryExpression(node) {
      if (!["===", "!==", "==", "!="].includes(node.operator)) {
        return;
      }
      const sides = [node.left, node.right];
      if (sides.some(isPlatformAccess) && sides.some(isPlatformName)) {
        count += 1;
      }
    },
    CallExpression(node) {
      // `["ios", "android"].includes(x.platform)` / `new Set([...]).has(x.platform)` branch too.
      const callee = unwrapCallee(node.callee);
      if (
        callee.type !== "MemberExpression" ||
        callee.computed ||
        callee.property.type !== "Identifier" ||
        !["includes", "has"].includes(callee.property.name) ||
        !node.arguments.some(isPlatformAccess)
      ) {
        return;
      }
      const container = JSON.stringify(callee.object, (key, value) =>
        key === "start" || key === "end" ? undefined : value,
      );
      const mentionsPlatform =
        [...PLATFORMS].some((name) => container.includes(`"${name}"`)) ||
        [...aliases].some((name) => container.includes(`"${name}"`));
      if (mentionsPlatform) {
        count += 1;
      }
    },
    SwitchStatement(node) {
      if (isPlatformAccess(node.discriminant)) {
        count += node.cases.filter((c) => c.test && isPlatformName(c.test)).length;
      }
    },
  }).visit(program);
  return count;
}

describe("TapOnElement platform branch guard", () => {
  let actual: number;
  // The AST scan runs in the hook so the per-test 100 ms budget is not spent on it.
  beforeAll(() => {
    actual = countPlatformComparisons(FILE, readGuardFile(path.join(ROOT, FILE)));
  });

  test("counts comparisons, switch cases and ignores unrelated code", () => {
    const source = [
      'if (a.platform === "ios") {}',
      'if ("android" !== platform) {}',
      'switch (d.platform) { case "android": break; case "ios": break; default: break; }',
      "if (a.platform === other) {}",
      'if (a.kind === "ios") {}',
    ].join("\n");
    expect(countPlatformComparisons("x.ts", source)).toBe(4);
  });

  test("counts aliased literals, template literals and includes/has membership checks", () => {
    const source = [
      'const IOS = "ios"; const DROID = `android`;',
      "if (a.platform === IOS) {}",
      "if (DROID !== a.platform) {}",
      'if (["ios", "android"].includes(a.platform)) {}',
      'if (new Set(["ios"]).has(platform)) {}',
      "switch (d.platform) { case IOS: break; default: break; }",
      "if (list.includes(a.platform)) {}",
      "if (a.platform === other) {}",
    ].join("\n");
    expect(countPlatformComparisons("x.ts", source)).toBe(5);
  });

  test("TapOnElement.ts has no platform comparisons", () => {
    expect(actual, `Move the ${FILE} platform branch into strategies/tapPlatformTraits.ts`).toBe(0);
  });
});
