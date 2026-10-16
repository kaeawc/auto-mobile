import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  Visitor,
  type Expression,
  type MemberExpression,
  type ParamPattern,
  type AssignmentTarget,
} from "oxc-parser";
import {
  localBindings,
  parseGuardSource,
  relativePosix,
  typeScriptFiles,
  unwrapCallee,
} from "./astGuard";
import preChangeReaders from "./fixtures/deviceBindingReaders.json";

const ROOT = path.resolve(import.meta.dir, "../..");
const OWNER = "src/daemon/deviceBinding.ts";

// bun test has no type-aware guard: this is a syntactic receiver/comparison
// heuristic with a per-file shrink-only count ratchet, not a proof of types.
const DEVICE_NAME =
  /device|pooled|candidate|replacement|existing|entry|runtime|exact|target|restored/i;
// Freeze all 196 typed reads from scratch/inv11802c/readers2.tsv. Fixture
// sources are origin/main (4460fdd3b5) lines; snippet only adds syntax
// around an otherwise unparseable statement fragment, preserving the full line.
// Three reads are missed: d/held are not device-like names and their one-line
// fixtures omit the declaration context. Keep this exact missed set shrink-only.
const MISSED_PRE_CHANGE_READS = [
  "src/daemon/devicePool.ts:8211:d.sessionId",
  "src/daemon/devicePool.ts:8285:d.sessionId",
  "src/daemon/managedSlots/managedSlotReconcilerPorts.ts:417:held.sessionId",
];
const DIRECT_READ_ALLOWLIST: Readonly<Record<string, number>> = {
  // Recovery cohort session-target records and callback parameter destructures.
  "src/daemon/adbServerResetQuarantine.ts": 5,
  // Failure-report options parameter, not a PooledDevice.
  "src/daemon/deviceAllocation.ts": 1,
  // Session objects and autolock session-candidate records.
  "src/daemon/deviceAutolockManager.ts": 3,
  // PlanLossTarget capture records, not the target's nested device.
  "src/daemon/deviceDisconnectHandler.ts": 2,
  // DeviceHoldFacts is an already captured availability projection.
  "src/daemon/deviceHold.ts": 2,
  // Deferred-release record (1) and discovery options (1).
  "src/daemon/devicePool.ts": 2,
  // Candidate is a Session identity from pooledSessionIdentities.
  "src/daemon/deviceReservations.ts": 1,
  // existingSession is a Session, not its assigned PooledDevice.
  "src/daemon/explicitDeviceBind.ts": 1,
  // Session objects and keep-awake restore targets.
  "src/daemon/sessionManager.ts": 28,
  // Finalization callback record moved from SessionManager; no additional reads.
  "src/daemon/sessionSlots.ts": 1,
  // MCP failure options and live-acceptance Session candidates.
  "src/daemon/socketServer.ts": 1,
  // Live-acceptance Session candidates, moved from socketServer.ts.
  "src/daemon/socketServer/restartAdmission.ts": 2,
  // CoreDevice diagnostic capability entries.
  "src/doctor/checks/ios.ts": 1,
  // targetUserResult is a PromiseSettledResult.
  "src/features/action/LaunchApp.ts": 1,
  // ExecuteSqlOptions parameter, not a device binding.
  "src/features/observe/ios/CtrlProxyDatabase.ts": 1,
  // Restart-resume admission target records.
  "src/server/deviceToolsStartDevice.ts": 1,
  // deviceStateResult is a PromiseSettledResult from an ADB command.
  "src/utils/android-cmdline-tools/AndroidEmulatorClient.ts": 2,
};

function memberName(node: MemberExpression): string | undefined {
  return !node.computed && node.property.type === "Identifier"
    ? node.property.name
    : node.computed && node.property.type === "Literal" && typeof node.property.value === "string"
      ? node.property.value
      : undefined;
}

// Optional chains wrap expressions in ChainExpression; unwrapCallee handles
// non-null assertions, as/satisfies casts, parentheses and sequence expressions.
function unwrapRead(expression: Expression): Expression {
  const node = unwrapCallee(expression);
  return node.type === "ChainExpression" ? unwrapRead(node.expression) : node;
}

function scan(file: string, source: string): { reads: string[] } {
  const program = parseGuardSource(file, source);
  const binding = localBindings(program);
  const reads: string[] = [];
  const writes = new Set<MemberExpression>();
  const comparisons = new Set<MemberExpression>();
  const functions: { start: number }[] = [program];
  const aliasFunctions = new Map<Expression, { start: number }>();

  const isDeviceReceiver = (expression: Expression, offset: number, allowAlias = true): boolean => {
    const receiver = unwrapRead(expression);
    if (receiver.type === "Identifier") {
      if (DEVICE_NAME.test(receiver.name)) {
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
      return DEVICE_NAME.test(memberName(receiver) ?? "");
    }
    if (receiver.type !== "CallExpression") {
      return false;
    }
    const callee = unwrapRead(receiver.callee);
    if (callee.type === "Identifier") {
      return ["getDevice", "getPooledDevice"].includes(callee.name);
    }
    if (callee.type !== "MemberExpression") {
      return false;
    }
    const collection = unwrapRead(callee.object);
    return (
      ["getDevice", "getPooledDevice"].includes(memberName(callee) ?? "") ||
      (memberName(callee) === "get" &&
        (collection.type === "Identifier"
          ? collection.name === "devices"
          : collection.type === "MemberExpression" && memberName(collection) === "devices"))
    );
  };
  const report = (offset: number, text: string): void => {
    reads.push(
      `${file}:${source.slice(0, offset).split("\n").length}: read ${text} through holderOf/statusOf/isIdle/isBusy/isErrored in ${OWNER}`,
    );
  };
  const markWrite = (target: AssignmentTarget | Expression): void => {
    if (target.type === "ObjectPattern") {
      for (const property of target.properties) {
        markWrite(property.type === "RestElement" ? property.argument : property.value);
      }
    } else if (target.type === "ArrayPattern") {
      for (const element of target.elements) {
        if (element) {
          markWrite(element.type === "RestElement" ? element.argument : element);
        }
      }
    } else if (target.type === "AssignmentPattern") {
      markWrite(target.left);
    } else {
      const node = unwrapRead(target);
      if (node.type === "MemberExpression") {
        writes.add(node);
      }
    }
  };
  const checkPattern = (pattern: ParamPattern | AssignmentTarget): void => {
    if (pattern.type === "AssignmentPattern") {
      checkPattern(pattern.left);
    } else if (pattern.type === "RestElement") {
      checkPattern(pattern.argument);
    } else if (pattern.type === "TSParameterProperty") {
      checkPattern(pattern.parameter);
    } else if (pattern.type === "ArrayPattern") {
      for (const element of pattern.elements) {
        if (element) {
          checkPattern(element);
        }
      }
    } else if (pattern.type === "ObjectPattern") {
      for (const property of pattern.properties) {
        if (property.type === "RestElement") {
          checkPattern(property.argument);
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
          report(property.start, name);
        }
        checkPattern(property.value);
      }
    }
  };
  const enterFunction = (node: { start: number; params: ParamPattern[] }): void => {
    functions.push(node);
    for (const param of node.params) {
      checkPattern(param);
    }
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
      if (
        node.init &&
        (isDeviceReceiver(node.init, node.start) ||
          // The intentional snapshot bridge has a non-device receiver name.
          // Include it explicitly so removing either field must shrink the ratchet.
          (file === "src/daemon/devicePool.ts" &&
            node.init.type === "Identifier" &&
            node.init.name === "snapshot"))
      ) {
        checkPattern(node.id);
      }
    },
    AssignmentExpression(node) {
      markWrite(node.left);
      if (node.left.type === "ObjectPattern" && isDeviceReceiver(node.right, node.start)) {
        checkPattern(node.left);
      }
    },
    UpdateExpression(node) {
      markWrite(node.argument);
    },
    UnaryExpression(node) {
      if (node.operator === "delete") {
        markWrite(node.argument);
      }
    },
    BinaryExpression(node) {
      if (!["==", "===", "!=", "!=="].includes(node.operator)) {
        return;
      }
      for (const [operand, other] of [
        [node.left, node.right],
        [node.right, node.left],
      ]) {
        const member = unwrapRead(operand);
        const literal = unwrapRead(other);
        if (
          member.type === "MemberExpression" &&
          ["status", "health"].includes(memberName(member) ?? "") &&
          literal.type === "Literal" &&
          typeof literal.value === "string" &&
          (memberName(member) === "health" ? ["ok", "error"] : ["idle", "busy", "error"]).includes(
            literal.value,
          )
        ) {
          comparisons.add(member);
        }
      }
    },
    MemberExpression(node) {
      if (
        !writes.has(node) &&
        ["sessionId", "status", "health"].includes(memberName(node) ?? "") &&
        (comparisons.has(node) || isDeviceReceiver(node.object, node.start))
      ) {
        report(node.start, source.slice(node.start, node.end));
      }
    },
  }).visit(program);
  return { reads };
}

function readViolations(
  facts: ReadonlyMap<string, { reads: string[] }>,
  allowlist = DIRECT_READ_ALLOWLIST,
): string[] {
  const violations: string[] = [];
  for (const file of new Set([...facts.keys(), ...Object.keys(allowlist)])) {
    if (file === OWNER) {
      continue;
    }
    const reads = facts.get(file)?.reads ?? [];
    const allowed = allowlist[file] ?? 0;
    if (reads.length > allowed) {
      violations.push(
        `${file}: ${reads.length} direct reads exceeds ${allowed}; route through the owner ${OWNER}`,
        ...reads,
      );
    } else if (reads.length < allowed) {
      violations.push(
        `${file}: ${reads.length} direct reads is below ${allowed}; lower the constant`,
      );
    }
  }
  return violations;
}

describe("device binding single reader", () => {
  const facts = new Map<string, ReturnType<typeof scan>>();
  const missed: string[] = [];
  beforeAll(() => {
    for (const file of typeScriptFiles(path.join(ROOT, "src"))) {
      const relative = relativePosix(ROOT, file);
      if (relative !== OWNER) {
        facts.set(relative, scan(relative, readFileSync(file, "utf8")));
      }
    }
    for (const row of preChangeReaders) {
      if (
        !scan(row.file, row.snippet ?? row.source).reads.some((read) =>
          read.includes(`read ${row.expression} through`),
        )
      ) {
        missed.push(`${row.file}:${row.line}:${row.expression}`);
      }
    }
  }, 20_000);

  test.each(preChangeReaders)("pre-change typed read $file:$line ($expression)", (row) => {
    const key = `${row.file}:${row.line}:${row.expression}`;
    expect(row.snippet ?? row.source).toContain(row.source);
    expect(missed.includes(key)).toBe(MISSED_PRE_CHANGE_READS.includes(key));
  });

  test("pre-change coverage has exactly 196 reads and its three misses can only shrink", () => {
    expect(preChangeReaders).toHaveLength(196);
    expect(missed).toEqual(MISSED_PRE_CHANGE_READS);
  });

  test.each([
    "device.health;",
    'device?.["health"];',
    '"error" === d.health;',
    'x.health !== "ok";',
    "const { health } = device;",
    "function f({ health }) {}",
    "function f(device) { const d = device; d.health; }",
    "getDevice(id)?.health;",
    "device.sessionId;",
    "device?.status;",
    "(device!).sessionId;",
    "(device as PooledDevice).status;",
    'device["sessionId"];',
    'device.status !== "idle";',
    '"busy" === d.status;',
    "const { sessionId, ...rest } = device;",
    "function f({ status }) {}",
    "function f(device) { const d = device; d.sessionId; }",
    "getDevice(id)?.sessionId;",
    "devices.get(id)!.status;",
    "this.port.getPooledDevice(id)?.status;",
    "this.port.devices.get(id)!.sessionId;",
    'this.port["device"]?.status;',
    "({ status } = device);",
    'const { ["status"]: s = "idle" } = pooled;',
    'x?.["status"] == "error";',
    '"idle" != (x!.status as string);',
    "const { nested: { status }, ...rest } = device;",
    "const f = ({ sessionId, ...rest } = {}) => {};",
    "class C { f({ status }) {} }",
    "function f() { const d = this.port.device; d.status; }",
    "const f = () => { const d = getDevice(id)!; d.sessionId; };",
    'device?.["sessionId"];',
    "(device as PooledDevice)!.status;",
    "function f(device) { const d = device; const { sessionId } = d; }",
    "function f(TARGET) { const d = TARGET; d.status; }",
  ])("catches read %s", (source) => {
    expect(scan("fixture.ts", source).reads).toHaveLength(1);
  });

  test.each([
    "holderOf(device); statusOf(device); isIdle(device); isBusy(device); isErrored(device);",
    'device.health = "error";',
    "delete device.health;",
    'response.health === "green";',
    "response.health;",
    'device.status = "x";',
    "device.sessionId++;",
    "delete device?.sessionId;",
    "({ value: device.status } = snapshot);",
    "[device.sessionId] = values;",
    "response.status === 200;",
    "session.sessionId;",
    'x.status === "ok";',
    "function f(response) { const d = response; d.sessionId; }",
    "function f(device) { const d = device; { const d = response; d.sessionId; } }",
    "function f(device) { const d = device; const g = () => d.sessionId; }",
    "function f(device) { const d = device; } function g() { d.sessionId; }",
    "function f(device) { const d = device; const e = d; e.sessionId; }",
    'device.status ||= "busy";',
    'device["sessionId"] += "x";',
    "function outer(device) { const d = device; function inner(d) { d.sessionId; } }",
  ])("ignores benign syntax %s", (source) => {
    expect(scan("fixture.ts", source).reads).toEqual([]);
  });

  test("direct reads outside the owner can only shrink", () => {
    expect(facts.size).toBeGreaterThan(0);
    expect(facts.has("src/daemon/devicePool.ts")).toBe(true);
    expect(readViolations(facts)).toEqual([]);
  });
  test.each([1, 0, undefined])("requires lowering the constant when reads drop to %s", (count) => {
    expect(
      readViolations(
        new Map(
          count === undefined ? [] : [["fixture.ts", { reads: Array<string>(count).fill("read") }]],
        ),
        { "fixture.ts": 2 },
      ),
    ).toEqual([`fixture.ts: ${count ?? 0} direct reads is below 2; lower the constant`]);
  });
  test("accepts exact counts and rejects increases and new callers", () => {
    expect(
      readViolations(new Map([["fixture.ts", { reads: ["read"] }]]), { "fixture.ts": 1 }),
    ).toEqual([]);
    expect(
      readViolations(new Map([["fixture.ts", { reads: ["read", "read"] }]]), { "fixture.ts": 1 }),
    ).toContain(`fixture.ts: 2 direct reads exceeds 1; route through the owner ${OWNER}`);
    expect(readViolations(new Map([["new.ts", { reads: ["read"] }]]), {})).toContain(
      `new.ts: 1 direct reads exceeds 0; route through the owner ${OWNER}`,
    );
    expect(readViolations(new Map([[OWNER, { reads: ["read"] }]]), {})).toEqual([]);
  });
});
