import { beforeAll, describe, expect, test } from "bun:test";

import { join } from "node:path";

import { parseGuardSource, readGuardFile, GuardVisitor as Visitor } from "./astGuard";

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
    methods = new Map();
    for (const relative of [
      "socketServer.ts",
      "socketServerParts/ClientRequestCancellation.ts",
      "socketServerParts/DaemonSocketQueueOverflowError.ts",
      "socketServerParts/McpBindings.ts",
      "socketServerParts/McpExecution.ts",
      "socketServerParts/McpRouting.ts",
      "socketServerParts/ReleasedBoundSessionError.ts",
      "socketServerParts/SocketAdmission.ts",
      "socketServerParts/SocketIdeRoutes.ts",
      "socketServerParts/SocketInput.ts",
      "socketServerParts/SocketLifecycle.ts",
      "socketServerParts/SocketServerRuntime.ts",
      "socketServerParts/SocketTextInput.ts",
      "socketServerParts/SocketTransport.ts",
      "socketServerParts/createSocketServerOperations.ts",
      "socketServerParts/socketServerContracts.ts",
      "socketServerParts/socketServerOperations.ts",

      "socketServer/ideDeviceRoutes.ts",
      "socketServer/inputDeviceGating.ts",
      "socketServer/inputStrokes.ts",
    ]) {
      const file = join(import.meta.dir, "..", "..", "src", "daemon", relative);
      for (const [name, calls] of thisCallsByMethod(file, readGuardFile(file))) {
        methods.set(name, calls);
      }
    }
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
