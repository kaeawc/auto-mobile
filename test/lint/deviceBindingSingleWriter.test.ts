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

// Current member-call inventory, including unrelated APIs named releaseDevice.
// Shrinking only: route new pool releases through releaseSessionAndDevice.ts.
const RELEASE_DEVICE_ALLOWLIST: Readonly<Record<string, number>> = {
  "src/daemon/cli/runDaemonCommand.ts": 1,
  "src/daemon/daemon.ts": 3,
  "src/daemon/daemonRequestHandlers.ts": 1,
  "src/daemon/devicePool.ts": 7,
  "src/daemon/deviceRecoveryCoordinator.ts": 1,
  "src/daemon/explicitDeviceBind.ts": 1,
  "src/features/prototype/ios/prototypeViewerAttach.ts": 1,
  "src/server/appTools.ts": 2,
  "src/server/deviceTools.ts": 1,
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
      !["sessionId", "status"].includes(memberName(member) ?? "")
    ) {
      return;
    }
    const receiver = unwrapCallee(member.object);
    if (
      receiver.type !== "Identifier" ||
      !DEVICE_RECEIVERS.has(receiver.name) ||
      isRecoveryReservation(receiver.name, member.start)
    ) {
      return;
    }
    writes.push(
      `${file}:${source.slice(0, member.start).split("\n").length}: route ${receiver.name}.${memberName(member)} through ${OWNER}`,
    );
  };

  new Visitor({
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
    },
  }).visit(program);
  return { writes, releases };
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
    expect([...facts].flatMap(([file, fact]) => (file === OWNER ? [] : fact.writes))).toEqual([]);
  });

  test("releaseDevice member calls outside the release owner can only shrink", () => {
    const violations: string[] = [];
    for (const [file, { releases }] of facts) {
      if (file === "src/daemon/releaseSessionAndDevice.ts") {
        continue;
      }
      const allowed = RELEASE_DEVICE_ALLOWLIST[file] ?? 0;
      if (releases > allowed) {
        violations.push(
          `${file}: ${releases} releaseDevice calls exceeds ${allowed}; route through the releaseSessionAndDevice owner`,
        );
      }
    }
    expect(violations).toEqual([]);
  });
});
