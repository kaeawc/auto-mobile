import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Visitor } from "oxc-parser";
import { parseGuardSource } from "./astGuard";

/**
 * #11837: tap dispatch belongs behind `TapStrategy`, so `TapOnElement.ts` must not branch on
 * the device platform. Each `<expr>.platform ===|!==|==|!= "android"|"ios"` comparison (and
 * each `case "android"|"ios"` of a `switch (<expr>.platform)`) is counted against
 * TAP_ON_ELEMENT_PLATFORM_COMPARISONS. The number may only shrink: lower it in the PR that
 * moves a branch into `strategies/`. Target is 0-1.
 */
export const TAP_ON_ELEMENT_PLATFORM_COMPARISONS = 16;

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

function isPlatformLiteral(node: unknown): boolean {
  const n = node as Node | undefined;
  return n?.type === "Literal" && typeof n.value === "string" && PLATFORMS.has(n.value);
}

export function countPlatformComparisons(file: string, source: string): number {
  let count = 0;
  new Visitor({
    BinaryExpression(node) {
      if (!["===", "!==", "==", "!="].includes(node.operator)) {
        return;
      }
      const sides = [node.left, node.right];
      if (sides.some(isPlatformAccess) && sides.some(isPlatformLiteral)) {
        count += 1;
      }
    },
    SwitchStatement(node) {
      if (isPlatformAccess(node.discriminant)) {
        count += node.cases.filter((c) => isPlatformLiteral(c.test)).length;
      }
    },
  }).visit(parseGuardSource(file, source));
  return count;
}

describe("TapOnElement platform branch ratchet", () => {
  let actual: number;
  // The AST scan runs in the hook so the per-test 100 ms budget is not spent on it.
  beforeAll(() => {
    actual = countPlatformComparisons(FILE, readFileSync(path.join(ROOT, FILE), "utf8"));
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

  test("does not grow past the committed baseline", () => {
    expect(actual).toBeLessThanOrEqual(TAP_ON_ELEMENT_PLATFORM_COMPARISONS);
  });

  test("baseline is tight so a shrink must lower it", () => {
    expect(actual).toBe(TAP_ON_ELEMENT_PLATFORM_COMPARISONS);
  });
});
