import { beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { parseSync, Visitor, type Expression, type MemberExpression } from "oxc-parser";
import path from "node:path";

const TEST_DIR = path.join(import.meta.dir, "..");
// Parsing every test file can exceed Bun's default hook limit on loaded CI runners.
const TREE_SCAN_HOOK_TIMEOUT_MS = 20_000;
const SERVER_CLASSES = [
  "Appearance",
  "DeviceSnapshot",
  "FailuresPush",
  "FailuresStream",
  "DeviceDataStream",
  "PerformancePush",
  "PerformanceStream",
  "TelemetryPush",
  "TestRecording",
  "VideoRecording",
  "VideoStream",
  "WebRtcStream",
];

// Relative test path -> accepted pre-existing violation lines. Keep empty while possible.
const ALLOWLIST: Record<string, string[]> = {};

function testFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? testFiles(file) : entry.name.endsWith(".test.ts") ? [file] : [];
  });
}

function normalizeRelativePath(relative: string): string {
  return relative.split(path.sep).join("/").split("\\").join("/");
}

function memberName(node: MemberExpression): string | undefined {
  if (!node.computed && node.property.type === "Identifier") {
    return node.property.name;
  }
  return node.property.type === "Literal" && typeof node.property.value === "string"
    ? node.property.value
    : undefined;
}

function callName(node: Expression): string | undefined {
  if (node.type === "Identifier") {
    return node.name;
  }
  return node.type === "MemberExpression" ? memberName(node) : undefined;
}

function isHomeSocket(node: Expression): boolean {
  if (
    node.type !== "CallExpression" ||
    !["join", "resolve"].includes(callName(node.callee) ?? "")
  ) {
    return false;
  }
  const [home, directory, file] = node.arguments;
  return (
    home?.type === "CallExpression" &&
    callName(home.callee) === "homedir" &&
    directory?.type === "Literal" &&
    directory.value === ".auto-mobile" &&
    file?.type === "Literal" &&
    typeof file.value === "string" &&
    file.value.endsWith(".sock")
  );
}

function violations(source: string): string[] {
  const parsed = parseSync("boundary.test.ts", source);
  const { errors } = parsed;
  if (errors.length > 0) {
    return errors.map((error) => `parse error: ${error.message}`);
  }
  // Every recognized constructor ends in SocketServer; home paths require
  // homedir, and listeners require both listen and a defaultPath/getSocketPath
  // origin (even through local aliases). Escaped identifiers or
  // computed string keys contain a backslash, so they always reach the visitor.
  // Keep parsing all files above: a syntax error must still fail the inventory.
  // Access program only for candidates (Oxc materializes its AST lazily).
  if (
    !/SocketServer|homedir|\\/.test(source) &&
    !(source.includes("listen") && /defaultPath|getSocketPath/.test(source))
  ) {
    return [];
  }
  const found: string[] = [];
  const scopes: Map<string, boolean>[] = [new Map()];
  const isDefaultPath = (node: Expression): boolean => {
    if (node.type === "Identifier") {
      return scopes.findLast((scope) => scope.has(node.name))?.get(node.name) ?? false;
    }
    if (node.type === "CallExpression") {
      return callName(node.callee) === "getSocketPath";
    }
    return node.type === "MemberExpression" && memberName(node) === "defaultPath";
  };
  const report = (start: number, label: string): void => {
    found.push(`${source.slice(0, start).split("\n").length}: ${label}`);
  };
  new Visitor({
    BlockStatement() {
      scopes.push(new Map());
    },
    "BlockStatement:exit"() {
      scopes.pop();
    },
    VariableDeclarator(node) {
      if (node.id.type === "Identifier") {
        scopes[scopes.length - 1].set(node.id.name, node.init ? isDefaultPath(node.init) : false);
      }
    },
    NewExpression(node) {
      const name = callName(node.callee);
      if (!SERVER_CLASSES.some((server) => name === `${server}SocketServer`)) {
        return;
      }
      const first = node.arguments[0];
      if (!first || (first.type !== "SpreadElement" && isDefaultPath(first))) {
        report(node.start, "explicit production socket path");
      }
    },
    CallExpression(node) {
      if (isHomeSocket(node)) {
        report(node.start, "home socket path");
      }
      const first = node.arguments[0];
      if (
        callName(node.callee) === "listen" &&
        first &&
        first.type !== "SpreadElement" &&
        isDefaultPath(first)
      ) {
        report(node.start, "explicit production socket path");
      }
    },
  }).visit(parsed.program);
  return found;
}

describe("auxiliary socket test boundary (issue #7616)", () => {
  test.each([
    "new DeviceDataStreamSocketServer()",
    "const socket = CONFIG.defaultPath; new DeviceDataStreamSocketServer(socket)",
    "const socket = DEVICE_DATA_STREAM_SOCKET_CONFIG.defaultPath; new DeviceDataStreamSocketServer(socket)",
    'new DeviceDataStreamSocketServer(DEVICE_DATA_STREAM_SOCKET_CONFIG["defaultPath"])',
    'path.resolve(os.homedir(), ".auto-mobile", "observation-stream.sock")',
    'const socket = DEVICE_DATA_STREAM_SOCKET_CONFIG["defaultPath"]; peer.listen(socket)',
  ])("rejects production socket spelling: %s", (source) => {
    expect(violations(source)).toHaveLength(1);
  });

  test("keeps escaped names and aliased listener paths in the candidate set", () => {
    for (const source of [
      String.raw`new DeviceDataStreamSocketServer()`,
      String.raw`peer["listen"](CONFIG.defaultPath)`,
      "const first = getSocketPath(); const second = first; peer.listen(second)",
      String.raw`path.join(os["homedir"](), ".auto-mobile", "stream.sock")`,
    ]) {
      expect(violations(source)).toHaveLength(1);
    }
    expect(violations("const =")[0]).toStartWith("parse error:");
    expect(violations("peer.listen(temporaryPath)")).toEqual([]);
  });

  test("normalizes Windows relative paths to POSIX form", () => {
    expect(normalizeRelativePath("lint\\auxSocketDirBoundary.test.ts")).toBe(
      "lint/auxSocketDirBoundary.test.ts",
    );
  });

  test("ignores source strings, comments, and temporary path aliases", () => {
    expect(
      violations(`
      // new DeviceDataStreamSocketServer()
      const fixture = 'new DeviceDataStreamSocketServer()';
      const socket = join(directory, "stream.sock");
      new DeviceDataStreamSocketServer(socket);
      const defaultPath = CONFIG.temporaryPath;
      peer.listen(defaultPath);
    `),
    ).toEqual([]);
  });

  let offenders: string[];
  // Check syntax in every file, then visit only conservative candidates during
  // setup; individual assertions stay below the 100ms budget.
  beforeAll(() => {
    const files = testFiles(TEST_DIR);
    expect(files.length).toBeGreaterThan(0);
    offenders = files.flatMap((file) => {
      const relative = normalizeRelativePath(path.relative(TEST_DIR, file));
      // The guard's own string fixtures intentionally contain forbidden examples.
      if (relative === "lint/auxSocketDirBoundary.test.ts") {
        return [];
      }
      const allowed = [...(ALLOWLIST[relative] ?? [])];
      return violations(readFileSync(file, "utf8"))
        .filter((violation) => {
          const index = allowed.indexOf(violation);
          if (index < 0) {
            return true;
          }
          allowed.splice(index, 1);
          return false;
        })
        .map((violation) => `${relative}:${violation}`);
    });
  }, TREE_SCAN_HOOK_TIMEOUT_MS);

  test("unit tests do not target production auxiliary socket paths", () => {
    expect(offenders).toEqual([]);
    expect(
      violations('path.join(os.homedir(), ".auto-mobile", "observation-stream.sock")'),
    ).toHaveLength(1);
    expect(
      violations("new DeviceDataStreamSocketServer(DEVICE_DATA_STREAM_SOCKET_CONFIG.defaultPath)"),
    ).toHaveLength(1);
  });
});
