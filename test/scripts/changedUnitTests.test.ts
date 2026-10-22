import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  bunfigPreloads,
  changedGraphTests,
  resolveChangedImports,
  scanChangedImports,
  type ChangedGraphReader,
  unitCommandPreloads,
} from "../../scripts/lib/changedUnitTests";

const root = path.resolve(import.meta.dir, "../..");

describe("changed unit parse graph", () => {
  test("Bun and require resolution accept a test filename without evaluating its target", () => {
    expect(resolveChangedImports("../../src/cli", import.meta.filename)).toEqual([
      path.resolve(import.meta.dir, "../../src/cli/index.ts"),
    ]);
  });
  const tests = ["test/a.test.ts", "test/b.test.ts", "test/c.test.ts"];
  const dependencies: Record<string, string[]> = {
    "test/a.test.ts": ["src/a.ts"],
    "test/b.test.ts": ["src/b.ts"],
    "src/a.ts": ["src/b.ts"],
    "src/b.ts": ["src/a.ts", "config.json"],
  };
  const reader: ChangedGraphReader = {
    read: () => "",
    imports: (file) => dependencies[file] ?? [],
    resolve: (specifier) => [specifier],
  };
  test("follows arbitrary-depth imports and cycles from non-source leaves", () => {
    expect(changedGraphTests(tests, ["config.json"], reader)).toEqual(tests.slice(0, 2));
  });
  test("changed tests select themselves exactly once", () => {
    expect(changedGraphTests(tests, [tests[2], tests[2]], reader)).toEqual([tests[2]]);
  });
  test("empty changes skip graph reads", () => {
    expect(
      changedGraphTests(tests, [], {
        ...reader,
        read: () => {
          throw new Error("unexpected read");
        },
      }),
    ).toEqual([]);
  });
  test("unrelated changes select nothing", () => {
    expect(changedGraphTests(tests, ["unrelated.ts"], reader)).toEqual([]);
  });
  test("uncertain local resolution selects all units", () => {
    expect(
      changedGraphTests(tests, ["deleted.ts"], {
        ...reader,
        resolve: () => {
          throw new Error("missing local target");
        },
      }),
    ).toEqual(tests);
  });
  test("retains require, re-export and dynamic import even after unreachable code", () => {
    const source =
      'throw new Error("must not execute"); require("./a"); export * from "./b"; import("./c"); require.resolve("./d");';
    expect(scanChangedImports("test/a.test.ts", source).sort()).toEqual([
      "./a",
      "./b",
      "./c",
      "./d",
    ]);
  });
  test("retains non-relative lexical aliases but omits type-only edges", () => {
    const source =
      'import type { T } from "./types"; throw new Error("unreachable"); require("@/runtime");';
    expect(scanChangedImports("test/a.test.ts", source)).toEqual(["@/runtime"]);
  });
  test.each(["package.json", "bun.lock"])(
    "a %s-only dependency bump selects all units (#14426)",
    (manifest) => {
      expect(changedGraphTests(tests, [manifest], reader)).toEqual(tests);
    },
  );
  test("a changed global preload selects all units, imported or not (#14425)", () => {
    expect(changedGraphTests(tests, ["test/setup/p.ts"], reader, ["test/setup/p.ts"])).toEqual(
      tests,
    );
  });
  test("unsupported loaders select all units instead of dropping transitive edges", () => {
    expect(
      changedGraphTests(tests, ["asset.css"], {
        ...reader,
        resolve: () => ["asset.css"],
      }),
    ).toEqual(tests);
  });
});

describe("changed unit global preloads (#14425)", () => {
  test("bunfig preloads are read as repository-relative paths", () => {
    expect(bunfigPreloads('[test]\npreload = ["./test/setup/a.ts", "test/b.ts"]\n')).toEqual([
      "test/setup/a.ts",
      "test/b.ts",
    ]);
    expect(bunfigPreloads('[test]\npreload = "./test/setup/a.ts"\n')).toEqual(["test/setup/a.ts"]);
    expect(bunfigPreloads("[test]\ntimeout = 5\n")).toEqual([]);
    expect(() => bunfigPreloads("[test]\npreload = [1]\n")).toThrow("bunfig.toml");
  });
  test("the real bunfig and unit command preloads resolve to existing files", () => {
    const preloads = [
      ...bunfigPreloads(readFileSync(path.join(root, "bunfig.toml"), "utf8")),
      ...unitCommandPreloads(root),
    ];
    expect(preloads).toContain("test/setup/testPreload.ts");
    expect(preloads).toContain("test/setup/fileTimingProbe.ts");
    expect(preloads.filter((file) => !existsSync(path.join(root, file)))).toEqual([]);
  });
});
