import {
  GuardVisitor,
  guardTextMayMatch,
  parseGuardSource,
  readGuardFile,
  relativePosix,
  typeScriptFiles,
} from "./astGuard";
import { beforeAll, describe, expect, test } from "bun:test";
import path from "node:path";

// #14046: the emulator-vs-physical probe was copied into six modules. `ro.kernel.qemu` is now
// read only by the DeviceTraits module; every other src file asks it. Any string that names the
// prop as a getprop argument (`"ro.kernel.qemu"`) or a getprop command (`getprop ro.kernel.qemu`)
// outside it is a new copy. Prose that merely mentions the prop (an error message) is allowed.
const ROOT = path.join(import.meta.dir, "..", "..");
const OWNER = "src/utils/android-cmdline-tools/deviceTraits.ts";
const PROP = "ro.kernel.qemu";
const GETPROP = /getprop\s+ro\.kernel\.qemu\b/;
// Reading every source file can exceed Bun's default hook limit on loaded CI runners.
const TREE_SCAN_HOOK_TIMEOUT_MS = 20_000;

function isProbeString(value: string): boolean {
  return value.trim() === PROP || GETPROP.test(value);
}

/** 1-based lines of string or template literals that read `ro.kernel.qemu`. */
export function findEmulatorFlagReads(file: string, source: string): number[] {
  const program = parseGuardSource(file, source, guardTextMayMatch(source, PROP));
  if (!program) {
    return [];
  }
  const lines = new Set<number>();
  const lineOf = (offset: number) => source.slice(0, offset).split("\n").length;
  new GuardVisitor({
    Literal(node) {
      if (typeof node.value === "string" && isProbeString(node.value)) {
        lines.add(lineOf(node.start));
      }
    },
    TemplateLiteral(node) {
      const text = node.quasis.map((quasi) => quasi.value.cooked ?? quasi.value.raw).join("${}");
      if (isProbeString(text)) {
        lines.add(lineOf(node.start));
      }
    },
  }).visit(program);
  return [...lines].sort((a, b) => a - b);
}

describe("findEmulatorFlagReads", () => {
  test.each([
    'adb.executeCommand("shell getprop ro.kernel.qemu");',
    'await property("ro.kernel.qemu");',
    "adb.executeCommand(`shell getprop ro.kernel.qemu`);",
    "adb.executeCommand(`shell getprop ro.kernel.qemu ${suffix}`);",
    "adb.execute(['shell', 'getprop', 'ro.kernel.qemu']);",
  ])("flags a read: %s", (source) => {
    expect(findEmulatorFlagReads("fixture.ts", source)).toEqual([1]);
  });

  test.each([
    'const message = "Location simulation requires an Android emulator (ro.kernel.qemu=1).";',
    "// shell getprop ro.kernel.qemu",
    'adb.executeCommand("shell getprop ro.product.model");',
  ])("ignores a non-read: %s", (source) => {
    expect(findEmulatorFlagReads("fixture.ts", source)).toEqual([]);
  });

  test("reports syntax errors with the file name", () => {
    expect(() => findEmulatorFlagReads("broken.ts", 'property("ro.kernel.qemu"')).toThrow(
      "broken.ts",
    );
  });
});

describe("ro.kernel.qemu single reader", () => {
  let violations: string[] = [];
  let ownerReads: number[] = [];

  beforeAll(() => {
    violations = typeScriptFiles(path.join(ROOT, "src"))
      .map((file) => ({ file: relativePosix(ROOT, file), absolute: file }))
      .filter(({ file }) => file !== OWNER)
      .flatMap(({ file, absolute }) =>
        findEmulatorFlagReads(file, readGuardFile(absolute)).map((line) => `${file}:${line}`),
      );
    ownerReads = findEmulatorFlagReads(OWNER, readGuardFile(path.join(ROOT, OWNER)));
  }, TREE_SCAN_HOOK_TIMEOUT_MS);

  test("only the DeviceTraits module reads ro.kernel.qemu", () => {
    expect(violations).toEqual([]);
  });

  test("the owner still reads it", () => {
    expect(ownerReads).not.toEqual([]);
  });
});
