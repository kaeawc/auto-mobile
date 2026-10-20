import { beforeAll, describe, expect, test } from "bun:test";

import path from "node:path";
import { type Expression } from "oxc-parser";
import {
  parseGuardSource,
  relativePosix,
  typeScriptFiles,
  unwrapCallee,
  readGuardFile,
  GuardVisitor as Visitor,
} from "./astGuard";

const EXEMPT = new Set([
  "src/features/observe/DeviceServiceUtils.ts",
  "src/features/observe/DeviceServiceClient.ts",
]);

// Counts sum register and WebSocket send call expressions, not request pairs.
const ALLOWANCES: Readonly<Record<string, number>> = {
  // Screenshots retain capture bindings, stream suppression and post-dispatch abort bookkeeping.
  "src/features/observe/android/AndroidScreenshotRequester.ts": 2,
  // Observation-stream screenshot: stream suppression, capture binding and rate-limit stamp.
  "src/features/observe/android/AndroidScreenshotCapture.ts": 2,
  // Hierarchy streaming path: subscription, cancellation and one-shot dispatch.
  "src/features/observe/android/AndroidHierarchyRequestSender.ts": 3,
  // Hierarchy streaming path: deadline recompute, abort, preparation and cache shaping.
  "src/features/observe/ios/CtrlProxyHierarchy.ts": 2,
  // Mock-rules push uses sendMessage's disconnected warning and lastSendAt activity stamp.
  "src/features/observe/ios/CtrlProxyNetworkSync.ts": 1,
};

function memberName(expression: Expression): string | undefined {
  const node = unwrapCallee(expression);
  return node.type === "MemberExpression"
    ? !node.computed && node.property.type === "Identifier"
      ? node.property.name
      : node.property.type === "Literal" && typeof node.property.value === "string"
        ? node.property.value
        : undefined
    : undefined;
}

function receiverName(expression: Expression): string | undefined {
  const node = unwrapCallee(expression);
  return node.type === "Identifier" ? node.name : memberName(node);
}

function scan(file: string, source: string): number {
  if (EXEMPT.has(file)) {
    return 0;
  }
  let count = 0;
  new Visitor({
    CallExpression(node) {
      const callee = unwrapCallee(node.callee);
      if (callee.type !== "MemberExpression") {
        return;
      }
      const method = memberName(callee);
      const receiver = unwrapCallee(callee.object);
      // WebSockets in observe use ws, webSocket or socket holders (including member
      // holders), or getWebSocket(). Do not count arbitrary clients' send methods.
      const isSocket =
        ["ws", "webSocket", "socket"].includes(receiverName(receiver) ?? "") ||
        (receiver.type === "CallExpression" && receiverName(receiver.callee) === "getWebSocket");
      if (
        (method === "register" && receiverName(receiver) === "requestManager") ||
        (method === "send" && isSocket)
      ) {
        count++;
      }
    },
  }).visit(parseGuardSource(file, source));
  return count;
}

function violations(facts: ReadonlyMap<string, number>, allowances = ALLOWANCES): string[] {
  const files = new Set([...facts.keys(), ...Object.keys(allowances)]);
  return [...files].flatMap((file) => {
    const count = EXEMPT.has(file) ? 0 : (facts.get(file) ?? 0);
    const allowed = allowances[file] ?? 0;
    if (count > allowed) {
      return [`${file}: ${count} hand-rolled sites exceeds ${allowed}; use sendCommand`];
    }
    return count < allowed
      ? [`${file}: ${count} hand-rolled sites is below ${allowed}; lower the allowance`]
      : [];
  });
}

describe("CtrlProxy hand-rolled requests can only shrink", () => {
  const facts = new Map<string, number>();
  beforeAll(() => {
    const root = path.join(import.meta.dir, "../..");
    for (const file of typeScriptFiles(path.join(root, "src/features/observe"))) {
      const relative = relativePosix(root, file);
      if (!EXEMPT.has(relative)) {
        facts.set(relative, scan(relative, readGuardFile(file)));
      }
    }
  });

  test.each([
    "requestManager.register<T>(id);",
    "this.context.requestManager.register(id);",
    "context['requestManager']['register'](id);",
    "ws.send(message);",
    "ws?.send(message);",
    "this.ws!.send(message);",
    "this['ws']['send'](message);",
    "context.getWebSocket()?.send(message);",
    "socket.send(message);",
    "this.webSocket.send(message);",
  ])("counts %s", (source) => {
    expect(scan("fixture.ts", source)).toBe(1);
  });

  test("ignores comments, strings, references and unrelated methods", () => {
    expect(
      scan(
        "fixture.ts",
        `
      // ws.send(message); requestManager.register(id);
      const text = "ws.send(message)";
      client.send(message); manager.register(id);
      const send = ws.send;
    `,
      ),
    ).toBe(0);
  });

  test("remaining sites match their allowances", () => {
    expect(facts.size).toBeGreaterThan(0);
    expect(violations(facts)).toEqual([]);
  });

  test("allow-list has no entries for files without sites", () => {
    for (const file of Object.keys(ALLOWANCES)) {
      expect(facts.get(file), file).toBeGreaterThan(0);
    }
  });

  test("both owner files are skipped, even with unparseable content", () => {
    for (const file of EXEMPT) {
      expect(scan(file, "requestManager.register(; ws.send(")).toBe(0);
      expect(facts.has(file)).toBe(false);
      expect(violations(new Map([[file, 10]]), {})).toEqual([]);
    }
  });

  test("rejects new files and count growth and requires lowering stale allowances", () => {
    expect(violations(new Map([["new.ts", 1]]), {})).toEqual([
      "new.ts: 1 hand-rolled sites exceeds 0; use sendCommand",
    ]);
    expect(violations(new Map([["old.ts", 3]]), { "old.ts": 2 })).toHaveLength(1);
    for (const count of [0, 1]) {
      expect(violations(new Map([["old.ts", count]]), { "old.ts": 2 })).toEqual([
        `old.ts: ${count} hand-rolled sites is below 2; lower the allowance`,
      ]);
    }
    expect(violations(new Map(), { "deleted.ts": 1 })).toEqual([
      "deleted.ts: 0 hand-rolled sites is below 1; lower the allowance",
    ]);
  });
});
