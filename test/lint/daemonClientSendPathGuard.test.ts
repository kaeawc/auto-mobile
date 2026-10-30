import { describe, expect, test } from "bun:test";
import path from "node:path";
import type { Expression, MethodDefinition } from "oxc-parser";
import { GuardVisitor, parseGuardSource, readGuardFile } from "./astGuard";

/**
 * #11817: `DaemonClient` delivers request frames through one private `send(frame, policy)`
 * (`sendDaemonFrame` in `clientSend.ts`). `sendRequest` and `callDaemonMethod` are thin
 * policies over it, so the client itself never registers a pending request or writes a
 * request frame.
 */
const CLIENT = path.join(import.meta.dir, "..", "..", "src", "daemon", "client", "client.ts");

function isThisMember(expression: Expression, ...names: string[]): boolean {
  let current: Expression = expression;
  for (const name of names.toReversed()) {
    if (
      current.type !== "MemberExpression" ||
      current.computed ||
      current.property.type !== "Identifier" ||
      current.property.name !== name
    ) {
      return false;
    }
    current = current.object;
  }
  return current.type === "ThisExpression";
}

/** For each `this.<names>(...)` call, the name of the class method it is written in. */
export function methodsCalling(source: string, ...names: string[]): string[] {
  const methods: string[] = [];
  const open: string[] = [];
  const methodName = (node: MethodDefinition) =>
    node.key.type === "Identifier" || node.key.type === "PrivateIdentifier" ? node.key.name : "?";
  new GuardVisitor({
    MethodDefinition: (node) => open.push(methodName(node)),
    "MethodDefinition:exit": () => open.pop(),
    CallExpression: (node) => {
      if (isThisMember(node.callee, ...names)) {
        methods.push(open.at(-1) ?? "<top level>");
      }
    },
  }).visit(parseGuardSource("client.ts", source));
  return methods;
}

describe("DaemonClient send path", () => {
  const source = readGuardFile(CLIENT);

  test("detector attributes this-member calls to their enclosing method", () => {
    const fixture = [
      "class C {",
      "  a() { this.pendingRequests.set(1, 2); other.pendingRequests.set(1, 2); }",
      "  b() { const f = () => this.socket.write('x'); this.send(); }",
      "}",
    ].join("\n");
    expect(methodsCalling(fixture, "pendingRequests", "set")).toEqual(["a"]);
    expect(methodsCalling(fixture, "socket", "write")).toEqual(["b"]);
    expect(methodsCalling(fixture, "send")).toEqual(["b"]);
  });

  test("no client method registers a pending request or writes a request frame itself", () => {
    expect(methodsCalling(source, "pendingRequests", "set")).toEqual([]);
    expect(methodsCalling(source, "socket", "write")).toEqual([]);
  });

  test("both public request kinds go through send", () => {
    expect(methodsCalling(source, "send").sort()).toEqual(["callDaemonMethod", "sendRequest"]);
  });
});
