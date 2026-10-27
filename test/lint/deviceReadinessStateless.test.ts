import { beforeAll, describe, expect, test } from "bun:test";
import path from "node:path";
import {
  GuardVisitor,
  parseGuardSource,
  readGuardFile,
  relativePosix,
  typeScriptFiles,
  unwrapCallee,
  valueImports,
} from "./astGuard";

function forbiddenReadinessCalls(file: string, source: string): string[] {
  const program = parseGuardSource(file, source);
  if (!program) {
    return [];
  }
  const readinessNames = new Set(["DeviceReadiness"]);
  for (const [local, binding] of valueImports(file, program)) {
    if (binding.name === "DeviceReadiness") {
      readinessNames.add(local);
    }
  }
  const found: string[] = [];
  new GuardVisitor({
    CallExpression(node) {
      const callee = unwrapCallee(node.callee);
      if (callee.type !== "MemberExpression") {
        return;
      }
      const property = callee.property;
      const name = callee.computed
        ? property.type === "Literal"
          ? property.value
          : undefined
        : property.type === "Identifier"
          ? property.name
          : undefined;
      const receiver = unwrapCallee(callee.object);
      if (
        name === "getCurrentDevice" ||
        (name === "getInstance" &&
          receiver.type === "Identifier" &&
          readinessNames.has(receiver.name))
      ) {
        found.push(`${String(name)} at ${node.start}`);
      }
    },
  }).visit(program);
  return found;
}

describe("readiness has explicit ownership and no ambient current device (#11810)", () => {
  const violations: string[] = [];
  beforeAll(() => {
    const root = path.join(import.meta.dir, "../..");
    for (const file of typeScriptFiles(path.join(root, "src"))) {
      const source = readGuardFile(file);
      if (!source.includes("DeviceReadiness") && !source.includes("getCurrentDevice")) {
        continue;
      }
      for (const call of forbiddenReadinessCalls(file, source)) {
        violations.push(`${relativePosix(root, file)}: ${call}`);
      }
    }
  }, 30_000);

  test("src contains no singleton readiness or current-device calls", () => {
    expect(violations).toEqual([]);
  });

  test.each([
    "DeviceReadiness.getInstance();",
    'DeviceReadiness["getInstance"]();',
    "(DeviceReadiness.getInstance)();",
    'import { DeviceReadiness as Ready } from "./readiness"; Ready.getInstance();',
    "readiness.getCurrentDevice();",
  ])("rejects %s", (source) => {
    expect(forbiddenReadinessCalls("fixture.ts", source)).toHaveLength(1);
  });

  test("ignores strings, comments and unrelated singletons", () => {
    expect(
      forbiddenReadinessCalls(
        "fixture.ts",
        '// DeviceReadiness.getInstance()\nconst text = "getCurrentDevice()"; Other.getInstance();',
      ),
    ).toEqual([]);
  });
});
