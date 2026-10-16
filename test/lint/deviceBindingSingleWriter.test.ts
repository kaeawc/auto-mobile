import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Visitor, type AssignmentTarget, type Expression, type MemberExpression } from "oxc-parser";
import {
  localBindings,
  parseGuardSource,
  relativePosix,
  typeScriptFiles,
  unwrapCallee,
} from "./astGuard";
import preChangeWriters from "./fixtures/deviceBindingWriters.json";

const ROOT = path.resolve(import.meta.dir, "../..");
const OWNER = "src/daemon/deviceBinding.ts";

// The type-aware pre-change inventory's 24 direct writes use device,
// replacementDevice and existing. Include the pooledDevice/entry aliases too,
// so new callers cannot evade ownership just by choosing those common names.
// fixtures/deviceBindingWriters.json freezes every write from inv11802/inv.ts
// at the pre-routing HEAD (661b243366); the coverage test parses each snippet.
const DEVICE_RECEIVERS = new Set([
  "device",
  "pooledDevice",
  "replacementDevice",
  "existing",
  "entry",
]);

// Shrink-only member-call inventory. Pool releases belong to the path-exempt
// releaseSessionAndDevice.ts funnel or DevicePool's own internal calls.
const RELEASE_DEVICE_ALLOWLIST: Readonly<Record<string, number>> = {
  // Includes the unrelated installed-apps cache write coordinator's releaseDevice call.
  "src/daemon/devicePool.ts": 7,
  // Unrelated APIs sharing the name: prototype agent registry, viewer connections,
  // events, and the installed-apps cache write coordinator. These counts do not
  // permit new DevicePool release callers.
  "src/features/prototype/ios/prototypeViewerAttach.ts": 1,
  "src/server/appTools.ts": 2,
  "src/server/deviceToolsShutdown.ts": 1,
  "src/server/prototypeTools.ts": 3,
};

function memberName(node: MemberExpression): string | undefined {
  if (!node.computed && node.property.type === "Identifier") {
    return node.property.name;
  }
  return node.computed &&
    node.property.type === "Literal" &&
    typeof node.property.value === "string"
    ? node.property.value
    : undefined;
}

function scan(file: string, source: string): { writes: string[]; releases: number } {
  const program = parseGuardSource(file, source);
  const binding = localBindings(program);
  const writes: string[] = [];
  let releases = 0;
  const functions: { start: number }[] = [program];
  const aliasFunctions = new Map<Expression, { start: number }>();

  // `existing` also names an ADB recovery reservation. Recognize that exact
  // initializer, not a whole-file/receiver exception that could hide a device.
  const isRecoveryReservation = (name: string, offset: number): boolean => {
    const initializer = binding(name, offset)?.initializer;
    if (!initializer) {
      return false;
    }
    const get = unwrapCallee(initializer);
    if (get.type !== "CallExpression") {
      return false;
    }
    const callee = unwrapCallee(get.callee);
    if (callee.type !== "MemberExpression" || memberName(callee) !== "get") {
      return false;
    }
    const collection = unwrapCallee(callee.object);
    if (collection.type !== "CallExpression") {
      return false;
    }
    const factory = unwrapCallee(collection.callee);
    return (
      factory.type === "MemberExpression" &&
      memberName(factory) === "getAdbServerResetRecoveryReservations"
    );
  };

  const isDeviceReceiver = (expression: Expression, offset: number, allowAlias = true): boolean => {
    const receiver = unwrapCallee(expression);
    if (receiver.type === "Identifier") {
      if (isRecoveryReservation(receiver.name, offset)) {
        return false;
      }
      if (DEVICE_RECEIVERS.has(receiver.name)) {
        return true;
      }
      const initializer = binding(receiver.name, offset)?.initializer;
      return !!(
        allowAlias &&
        initializer &&
        initializer.end <= offset &&
        aliasFunctions.get(initializer) === functions.at(-1) &&
        isDeviceReceiver(initializer, initializer.start, false)
      );
    }
    if (receiver.type === "MemberExpression") {
      return DEVICE_RECEIVERS.has(memberName(receiver) ?? "");
    }
    if (receiver.type !== "CallExpression") {
      return false;
    }
    const callee = unwrapCallee(receiver.callee);
    if (callee.type === "Identifier") {
      return callee.name === "getDevice";
    }
    if (callee.type !== "MemberExpression") {
      return false;
    }
    const collection = unwrapCallee(callee.object);
    return (
      memberName(callee) === "getDevice" ||
      (memberName(callee) === "get" &&
        (collection.type === "Identifier"
          ? collection.name === "devices"
          : collection.type === "MemberExpression" && memberName(collection) === "devices"))
    );
  };

  const reportWrite = (receiver: Expression, property: string, offset: number): void => {
    writes.push(
      `${file}:${source.slice(0, offset).split("\n").length}: route ${source.slice(receiver.start, receiver.end)}.${property} through ${OWNER}`,
    );
  };

  const checkTarget = (target: AssignmentTarget | Expression): void => {
    if (target.type === "ObjectPattern") {
      for (const property of target.properties) {
        const value = property.type === "RestElement" ? property.argument : property.value;
        checkTarget(value.type === "AssignmentPattern" ? value.left : value);
      }
      return;
    }
    if (target.type === "ArrayPattern") {
      for (const element of target.elements) {
        if (!element) {
          continue;
        }
        checkTarget(
          element.type === "RestElement"
            ? element.argument
            : element.type === "AssignmentPattern"
              ? element.left
              : element,
        );
      }
      return;
    }
    const member = unwrapCallee(target);
    if (
      member.type !== "MemberExpression" ||
      !["sessionId", "status", "health"].includes(memberName(member) ?? "")
    ) {
      return;
    }
    if (isDeviceReceiver(member.object, member.start)) {
      reportWrite(member.object, memberName(member)!, member.start);
    }
  };

  // Keep aliases lexical via localBindings, one hop only, and inside the
  // declaring function (including arrow callbacks and class methods).
  const enterFunction = (node: { start: number }): void => {
    functions.push(node);
  };
  const leaveFunction = (): void => {
    functions.pop();
  };
  new Visitor({
    FunctionDeclaration: enterFunction,
    "FunctionDeclaration:exit": leaveFunction,
    FunctionExpression: enterFunction,
    "FunctionExpression:exit": leaveFunction,
    ArrowFunctionExpression: enterFunction,
    "ArrowFunctionExpression:exit": leaveFunction,
    VariableDeclarator(node) {
      if (node.id.type === "Identifier" && node.init) {
        aliasFunctions.set(node.init, functions.at(-1)!);
      }
    },
    AssignmentExpression(node) {
      checkTarget(node.left);
    },
    UpdateExpression(node) {
      checkTarget(node.argument);
    },
    UnaryExpression(node) {
      if (node.operator === "delete") {
        checkTarget(node.argument);
      }
    },
    CallExpression(node) {
      const callee = unwrapCallee(node.callee);
      if (callee.type === "MemberExpression" && memberName(callee) === "releaseDevice") {
        releases++;
      }
      if (
        callee.type !== "MemberExpression" ||
        memberName(callee) !== "assign" ||
        callee.object.type !== "Identifier" ||
        callee.object.name !== "Object"
      ) {
        return;
      }
      const [target, ...sources] = node.arguments;
      if (!target || target.type === "SpreadElement" || !isDeviceReceiver(target, node.start)) {
        return;
      }
      for (const argument of sources) {
        if (argument.type === "SpreadElement") {
          continue;
        }
        const value = unwrapCallee(argument);
        if (value.type !== "ObjectExpression") {
          continue;
        }
        for (const property of value.properties) {
          if (property.type !== "Property") {
            continue;
          }
          const key = property.key;
          const name =
            !property.computed && key.type === "Identifier"
              ? key.name
              : key.type === "Literal" && typeof key.value === "string"
                ? key.value
                : undefined;
          if (name === "sessionId" || name === "status" || name === "health") {
            reportWrite(target, name, property.start);
          }
        }
      }
    },
  }).visit(program);
  return { writes, releases };
}

function releaseViolations(
  facts: ReadonlyMap<string, { releases: number }>,
  allowlist = RELEASE_DEVICE_ALLOWLIST,
): string[] {
  const violations: string[] = [];
  for (const file of new Set([...facts.keys(), ...Object.keys(allowlist)])) {
    if (file === "src/daemon/releaseSessionAndDevice.ts") {
      continue;
    }
    const releases = facts.get(file)?.releases ?? 0;
    const allowed = allowlist[file] ?? 0;
    if (releases > allowed) {
      violations.push(
        `${file}: ${releases} releaseDevice calls exceeds ${allowed}; route through the releaseSessionAndDevice owner`,
      );
    } else if (releases < allowed) {
      violations.push(
        `${file}: ${releases} releaseDevice calls is below ${allowed}; lower the constant`,
      );
    }
  }
  return violations;
}

describe("device binding single writer", () => {
  const facts = new Map<string, ReturnType<typeof scan>>();
  beforeAll(() => {
    for (const file of typeScriptFiles(path.join(ROOT, "src"))) {
      const relative = relativePosix(ROOT, file);
      facts.set(relative, scan(relative, readFileSync(file, "utf8")));
    }
  }, 20_000);

  test("receiver heuristic catches every direct write in the pre-change typed inventory", () => {
    expect(preChangeWriters).toHaveLength(24);
    for (const row of preChangeWriters) {
      expect(scan(row.file, row.source).writes, `${row.file}:${row.line}`).toHaveLength(1);
    }
  });

  test.each([
    'device.health = "error";',
    'device["health"] ||= "ok";',
    "delete (device!).health;",
    "({ verdict: device.health } = snapshot);",
    'device.sessionId = "owner";',
    'pooledDevice.status ||= "idle";',
    'replacementDevice["sessionId"] += "x";',
    "++existing.status;",
    'entry["status"]--;',
    "delete (device!).sessionId;",
    '(device as PooledDevice).status = "error";',
    "({ holder: device.sessionId } = snapshot);",
    "[device.status] = values;",
  ])("catches mutation %s", (source) => {
    expect(scan("fixture.ts", source).writes).toHaveLength(1);
  });

  test.each([
    'this.device.health = "ok";',
    'Object.assign(device, { health: "error" });',
    'function update(device) { const d = device; d.health = "ok"; }',
    'this.device.status = "idle";',
    "this.port.pooledDevice.sessionId = null;",
    'this.port["replacementDevice"].status = "idle";',
    'getDevice(id).status = "idle";',
    "this.port.getDevice(id)!.sessionId = null;",
    '(this.port.devices.get(id)!).status = "idle";',
    "(devices.get(id) as PooledDevice).sessionId = null;",
    "Object.assign(device, { sessionId: null });",
    'Object.assign(this.port.device, {}, { ["status"]: "idle" });',
    'Object.assign((this.port.devices.get(id)!), { "status": "idle" });',
    "function update(device) { const d = device; d.sessionId = null; }",
    'function update() { const d = this.port.device; d.status = "idle"; }',
    'const update = () => { const d = getDevice(id)!; d.status = "idle"; };',
    'function update(device) { const d = device; Object.assign(d, { status: "idle" }); }',
  ])("catches receiver or assign evasion %s", (source) => {
    expect(scan("fixture.ts", source).writes).toHaveLength(1);
  });

  test.each([
    'response.health = "ok";',
    'Object.assign(response, { health: "error" });',
    'response.status = "ok";',
    'this.port.response.status = "ok";',
    'this.port.sessions.get(id)!.status = "ok";',
    'getResponse(id).status = "ok";',
    'Object.assign(response, { status: "ok", sessionId: "other" });',
    'Object.assign(device, { name: "phone" });',
    'function update(response) { const d = response; d.status = "ok"; }',
    'function update(device) { const d = device; { const d = response; d.status = "ok"; } }',
    'function first(device) { const d = device; } function second() { d.status = "ok"; }',
    'function outer(device) { const d = device; function inner(d) { d.status = "ok"; } }',
    'function outer(device) { const d = device; const inner = () => { d.status = "ok"; }; }',
  ])("ignores benign receivers and out-of-function aliases %s", (source) => {
    expect(scan("fixture.ts", source).writes).toEqual([]);
  });

  test("ignores reads, construction, unrelated holders and reservation records", () => {
    expect(
      scan(
        "fixture.ts",
        `
      const entry = { sessionId: null, status: "idle" };
      const holder = device.sessionId;
      if (device.status === "busy") session.sessionId = "owner";
      const existing = pool.getAdbServerResetRecoveryReservations().get(name);
      existing.sessionId = record.sessionId;
      { const existing = pool.getDevice(id); existing.status = "error"; }
    `,
      ).writes,
    ).toHaveLength(1);
  });

  test("binding fields are mutated only by the owner module", () => {
    expect(facts.size).toBeGreaterThan(0);
    expect(facts.has("src/daemon/deviceAllocation.ts")).toBe(true);
    expect([...facts].flatMap(([file, fact]) => (file === OWNER ? [] : fact.writes))).toEqual([]);
  });

  test("releaseDevice member calls outside the release owner can only shrink", () => {
    expect(facts.size).toBeGreaterThan(0);
    expect(facts.has("src/daemon/deviceAllocation.ts")).toBe(true);
    expect(releaseViolations(facts)).toEqual([]);
  });

  test.each([1, 0, undefined])(
    "requires lowering the constant when calls drop to %s",
    (releases) => {
      const facts = new Map(releases === undefined ? [] : [["fixture.ts", { releases }]]);
      expect(releaseViolations(facts, { "fixture.ts": 2 })).toEqual([
        `fixture.ts: ${releases ?? 0} releaseDevice calls is below 2; lower the constant`,
      ]);
    },
  );

  test("accepts exact counts and still rejects increases and new callers", () => {
    expect(
      releaseViolations(new Map([["fixture.ts", { releases: 2 }]]), { "fixture.ts": 2 }),
    ).toEqual([]);
    expect(
      releaseViolations(new Map([["fixture.ts", { releases: 3 }]]), { "fixture.ts": 2 }),
    ).toEqual([
      "fixture.ts: 3 releaseDevice calls exceeds 2; route through the releaseSessionAndDevice owner",
    ]);
    expect(releaseViolations(new Map([["fixture.ts", { releases: 1 }]]), {})).toHaveLength(1);
    expect(
      releaseViolations(new Map([["src/daemon/releaseSessionAndDevice.ts", { releases: 9 }]]), {}),
    ).toEqual([]);
  });

  test.each([
    "src/daemon/cli/runDaemonCommand.ts",
    "src/daemon/daemon.ts",
    "src/daemon/daemonRequestHandlers.ts",
    "src/daemon/deviceRecoveryCoordinator.ts",
    "src/daemon/explicitDeviceBind.ts",
    "src/server/deviceTools.ts",
  ])("migrated caller %s has no member-call allowance", (file) => {
    expect(RELEASE_DEVICE_ALLOWLIST[file]).toBeUndefined();
    expect(releaseViolations(new Map([[file, { releases: 1 }]]))).toContain(
      `${file}: 1 releaseDevice calls exceeds 0; route through the releaseSessionAndDevice owner`,
    );
  });
});
