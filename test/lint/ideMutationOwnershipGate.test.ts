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

/**
 * What each top-level function of the source calls: `<receiver>.<name>(...)` as `<name>` for the
 * `deps` receiver, and a bare `name(...)` call as itself.
 */
export function callsByFunction(file: string, source: string): Map<string, Set<string>> {
  const program = parseGuardSource(file, source);
  const functions = new Map<string, Set<string>>();
  const stack: Set<string>[] = [];
  new Visitor({
    FunctionDeclaration(node) {
      const calls = new Set<string>();
      if (node.id) {
        functions.set(node.id.name, calls);
      }
      stack.push(calls);
    },
    "FunctionDeclaration:exit"() {
      stack.pop();
    },
    CallExpression(node) {
      const callee = node.callee;
      if (stack.length === 0) {
        return;
      }
      const calls = stack[stack.length - 1];
      if (callee.type === "Identifier") {
        calls.add(callee.name);
      } else if (
        callee.type === "MemberExpression" &&
        callee.object.type === "Identifier" &&
        callee.object.name === "deps" &&
        !callee.computed &&
        callee.property.type === "Identifier"
      ) {
        calls.add(callee.property.name);
      }
    },
  }).visit(program);
  return functions;
}

/** The handler function a route's table entry names (`ide/setKeyValue` -> `setKeyValue`). */
function handlerName(route: string): string {
  return route.slice("ide/".length);
}

describe("mutating ide/* routes reach the device ownership gate (#10827)", () => {
  let methods: Map<string, Set<string>>;

  beforeAll(() => {
    const file = join(
      import.meta.dir,
      "..",
      "..",
      "src",
      "daemon",
      "socketServer",
      "ideDeviceRoutes.ts",
    );
    methods = callsByFunction(file, readFileSync(file, "utf8"));
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
    const violating = callsByFunction(
      "fixture.ts",
      `async function updateService(deps) { const note = "deps.assertIdeMutationOwnership("; /* deps.assertIdeMutationOwnership() */ deps.other(); }
      async function setKeyValue() { resolveKeyValueMutationClient(); }`,
    );
    expect(violating.get("updateService")).not.toContain(GATE);
    expect(violating.get("setKeyValue")).toContain("resolveKeyValueMutationClient");
    const compliant = callsByFunction(
      "fixture.ts",
      "async function updateService(deps) { await deps.assertIdeMutationOwnership(1); }",
    );
    expect(compliant.get("updateService")).toContain(GATE);
  });
});
