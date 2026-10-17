import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Visitor } from "oxc-parser";
import { parseGuardSource } from "./astGuard";

/**
 * Every device-mutating `ide/*` socket route must reach the ownership check (#10827), as `input/*`
 * does. An AST scan: "check ownership before acting" is an ordering obligation no signature
 * can express. Reads (watching) are deliberately absent from this list.
 */
const GATE = "assertIdeMutationOwnership";

/** `this.<method>(...)` callees reachable inside each class method of the source. */
export function thisCallsByMethod(file: string, source: string): Map<string, Set<string>> {
  const program = parseGuardSource(file, source);
  const methods = new Map<string, Set<string>>();
  const stack: Set<string>[] = [];
  new Visitor({
    MethodDefinition(node) {
      const calls = new Set<string>();
      if (node.key.type === "Identifier") {
        methods.set(node.key.name, calls);
      }
      stack.push(calls);
    },
    "MethodDefinition:exit"() {
      stack.pop();
    },
    CallExpression(node) {
      const callee = node.callee;
      if (
        stack.length > 0 &&
        callee.type === "MemberExpression" &&
        callee.object.type === "ThisExpression" &&
        !callee.computed &&
        callee.property.type === "Identifier"
      ) {
        stack[stack.length - 1].add(callee.property.name);
      }
    },
  }).visit(program);
  return methods;
}

/** The handler method a route's table entry names (`ide/setKeyValue` -> `ideSetKeyValue`). */
function handlerName(route: string): string {
  return `ide${route.slice("ide/".length).replace(/^./, (c) => c.toUpperCase())}`;
}

describe("mutating ide/* routes reach the device ownership gate (#10827)", () => {
  let methods: Map<string, Set<string>>;

  beforeAll(() => {
    const file = join(import.meta.dir, "..", "..", "src", "daemon", "socketServer.ts");
    methods = thisCallsByMethod(file, readFileSync(file, "utf8"));
  });

  function calls(method: string): Set<string> {
    const found = methods.get(method);
    expect(found).toBeDefined();
    return found ?? new Set();
  }

  test("ide/updateService calls the gate", () => {
    expect(calls(handlerName("ide/updateService"))).toContain(GATE);
  });

  test("key-value mutation routes resolve through the gated client resolver", () => {
    for (const route of ["ide/setKeyValue", "ide/removeKeyValue", "ide/clearKeyValueFile"]) {
      expect(calls(handlerName(route))).toContain("resolveKeyValueMutationClient");
    }
    expect(calls("resolveKeyValueMutationClient")).toContain(GATE);
  });

  test("a handler that drops the gate call, or only mentions it, is detected", () => {
    const violating = thisCallsByMethod(
      "fixture.ts",
      `class S {
        async ideUpdateService() { const note = "this.assertIdeMutationOwnership("; /* this.assertIdeMutationOwnership() */ this.other(); }
        async ideSetKeyValue() { this.resolveKeyValueMutationClient(); }
      }`,
    );
    expect(violating.get("ideUpdateService")).not.toContain(GATE);
    expect(violating.get("ideSetKeyValue")).toContain("resolveKeyValueMutationClient");
    const compliant = thisCallsByMethod(
      "fixture.ts",
      "class S { async ideUpdateService() { await this.assertIdeMutationOwnership(1); } }",
    );
    expect(compliant.get("ideUpdateService")).toContain(GATE);
  });
});
