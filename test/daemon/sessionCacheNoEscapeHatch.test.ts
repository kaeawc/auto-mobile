import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Visitor, type Expression, type PropertyKey } from "oxc-parser";
import { parseGuardSource, relativePosix, typeScriptFiles } from "../lint/astGuard";

/**
 * Setter-bypass guard (issue #3219, follow-up to #2973).
 *
 * The no-escape-hatch half of #2973 (typed `keepScreenAwake` / `deviceLabels` slots, no
 * `customData` bag) is a compile-time check in `sessionCacheNoEscapeHatch.typecheck.ts`.
 * What types cannot express is that `updateSessionCache` is public, so a caller could write
 * a setter-only slot directly instead of going through `setKeepScreenAwake` /
 * `setDeviceLabels`. This guard walks the parsed `src/` modules (oxc AST, not source text,
 * so comments, strings and formatting cannot satisfy or trip it, #11867) and fails on
 * either bypass in production code. Tests may still write the slots through the public,
 * compile-checked `updateSessionCache`.
 */
describe("production code writes SessionCacheData setter-only slots via setters (issue #3219)", () => {
  const root = path.resolve(import.meta.dir, "../..");
  const SESSION_MANAGER = "src/daemon/sessionManager.ts";
  const SETTER_ONLY_SLOTS = ["keepScreenAwake", "deviceLabels"] as const;
  type Slot = (typeof SETTER_ONLY_SLOTS)[number];

  const isSlot = (name: string | undefined): name is Slot =>
    SETTER_ONLY_SLOTS.some((slot) => slot === name);

  function memberName(node: Expression): string | undefined {
    if (node.type !== "MemberExpression") {
      return undefined;
    }
    if (!node.computed) {
      return node.property.type === "Identifier" ? node.property.name : undefined;
    }
    return node.property.type === "Literal" && typeof node.property.value === "string"
      ? node.property.value
      : undefined;
  }

  function propertyKey(key: PropertyKey): string | undefined {
    if (key.type === "Identifier") {
      return key.name;
    }
    return key.type === "Literal" ? String(key.value) : undefined;
  }

  function calledName(callee: Expression): string | undefined {
    return callee.type === "Identifier" ? callee.name : memberName(callee);
  }

  /** `file: slot (kind)` for every direct assignment to, or `updateSessionCache` key of, a slot. */
  function bypasses(file: string, source: string): string[] {
    const found: string[] = [];
    const rel = relativePosix(root, file);
    new Visitor({
      AssignmentExpression(node) {
        const name = node.left.type === "MemberExpression" ? memberName(node.left) : undefined;
        if (isSlot(name)) {
          found.push(`${rel}: .${name} assigned directly`);
        }
      },
      CallExpression(node) {
        if (calledName(node.callee) !== "updateSessionCache") {
          return;
        }
        const keys = node.arguments.flatMap((arg) =>
          arg.type === "ObjectExpression"
            ? arg.properties.map((prop) =>
                prop.type === "Property" && !prop.computed ? propertyKey(prop.key) : undefined,
              )
            : [],
        );
        for (const key of keys.filter(isSlot)) {
          found.push(`${rel}: ${key} passed to updateSessionCache`);
        }
      },
    }).visit(parseGuardSource(file, source));
    return found;
  }

  // Reading every `src/` file is tree-scan IO, not the guard itself: do it once in beforeAll.
  // A file that never names a slot cannot bypass, so only those are parsed.
  const TREE_SCAN_HOOK_TIMEOUT_MS = 20_000;
  let violations: string[] = [];
  beforeAll(() => {
    const manager = path.join(root, SESSION_MANAGER);
    violations = typeScriptFiles(path.join(root, "src"))
      .filter((file) => file !== manager && !file.endsWith(".d.ts"))
      .flatMap((file) => {
        const source = readFileSync(file, "utf8");
        return SETTER_ONLY_SLOTS.some((slot) => source.includes(slot))
          ? bypasses(file, source)
          : [];
      });
  }, TREE_SCAN_HOOK_TIMEOUT_MS);

  test("no src module bypasses SessionManager.setKeepScreenAwake / setDeviceLabels", () => {
    expect(violations).toEqual([]);
  });

  test("the detector flags a direct assignment and an updateSessionCache bypass", () => {
    const file = path.join(root, "src/example.ts");
    const source = `
      session.cacheData.deviceLabels = labels;
      manager.updateSessionCache(id, { keepScreenAwake: state });
      updateSessionCache(id, { "deviceLabels": labels });
      // session.cacheData.deviceLabels = ignored in a comment
      const ok = session.cacheData.deviceLabels === labels;
      manager.updateSessionCache(id, { lastObserveTime: 1 });
    `;
    expect(bypasses(file, source)).toEqual([
      "src/example.ts: .deviceLabels assigned directly",
      "src/example.ts: keepScreenAwake passed to updateSessionCache",
      "src/example.ts: deviceLabels passed to updateSessionCache",
    ]);
  });
});
