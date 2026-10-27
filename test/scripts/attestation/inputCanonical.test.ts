import { describe, expect, test } from "bun:test";
import {
  canonicalEnvironmentInputs,
  canonicalInputEntries,
  canonicalInputPath,
  hashRecords,
  normalizeLineEndings,
  type InputEntry,
} from "../../../scripts/ci/attestation/inputCanonical";
import {
  TreeEntriesInputHasher,
  type TreeProbe,
} from "../../../scripts/ci/attestation/produceAttestations";
import { describeHashBoundary } from "./hashHarness";

describe("canonical paths", () => {
  test.each([
    ["src/a.ts", "src/a.ts"],
    ["./src//a.ts", "src/a.ts"],
    ["src\\win\\a.ts", "src/win/a.ts"],
    ["src/./b/c", "src/b/c"],
  ])("%s is %s", (input, expected) => {
    expect(canonicalInputPath(input)).toBe(expected);
  });

  test.each(["/abs/path", "C:\\work\\a.ts", "../outside", "a/../../b", "", "."])(
    "%p is refused",
    (input) => {
      expect(() => canonicalInputPath(input)).toThrow();
    },
  );
});

describe("canonical entries", () => {
  const entry = (path: string, id = "1", mode = "100644"): InputEntry => ({ path, id, mode });

  test("sorted by code unit, not locale", () => {
    expect(
      canonicalInputEntries([entry("b"), entry("B"), entry("a"), entry("é")]).map((e) => e.path),
    ).toEqual(["B", "a", "b", "é"]);
  });

  test("a duplicate path is refused, including one that only normalizes to a duplicate", () => {
    expect(() => canonicalInputEntries([entry("a/b"), entry("a\\b")])).toThrow("duplicate");
  });
});

describe("environment inputs", () => {
  test("only the named variables count, sorted, with an unset one recorded as unset", () => {
    expect(
      canonicalEnvironmentInputs({ B: "2", A: "1", OTHER: "x" }, ["B", "A", "C", "A"]),
    ).toEqual([
      ["A", "1"],
      ["B", "2"],
      ["C", null],
    ]);
  });

  test("an empty value is not the same as unset", () => {
    expect(canonicalEnvironmentInputs({ A: "" }, ["A"])).toEqual([["A", ""]]);
  });
});

test("line endings are pinned to LF", () => {
  expect(normalizeLineEndings("a\r\nb\rc\nd")).toBe("a\nb\nc\nd");
});

test("the algorithm name is part of the hash", () => {
  expect(hashRecords("v1", [["a"]])).not.toBe(hashRecords("v2", [["a"]]));
  expect(hashRecords("v1", [["a"], ["b"]])).not.toBe(hashRecords("v1", [["b"], ["a"]]));
});

class StaticProbe implements TreeProbe {
  constructor(private readonly entries: InputEntry[]) {}
  async headId() {
    return "head";
  }
  async dirtyPaths() {
    return [];
  }
  async inputEntries() {
    return this.entries;
  }
}

const baseEntries = (): InputEntry[] => [
  { path: "src/a.ts", id: "aaa", mode: "100644" },
  { path: "src/b.ts", id: "bbb", mode: "100644" },
  { path: "bun.lock", id: "lll", mode: "100644" },
];

describeHashBoundary<InputEntry[]>("tree-entries input hash", {
  base: baseEntries,
  hash: async (entries) =>
    (await new TreeEntriesInputHasher().hash("node", new StaticProbe(entries))).hash,
  mutations: {
    "a source file's content": (e) =>
      e.map((x) => (x.path === "src/a.ts" ? { ...x, id: "changed" } : x)),
    "the lockfile": (e) => e.map((x) => (x.path === "bun.lock" ? { ...x, id: "bumped" } : x)),
    "a file mode": (e) => e.map((x) => (x.path === "src/b.ts" ? { ...x, mode: "100755" } : x)),
    "a file added": (e) => [...e, { path: "src/c.ts", id: "ccc", mode: "100644" }],
    "a file removed": (e) => e.filter((x) => x.path !== "src/b.ts"),
    "a file renamed": (e) => e.map((x) => (x.path === "src/a.ts" ? { ...x, path: "src/z.ts" } : x)),
  },
  perturbations: {
    "entries in another order": (e) => [...e].reverse(),
    "backslash separators": (e) => e.map((x) => ({ ...x, path: x.path.replaceAll("/", "\\") })),
    "a leading ./ on every path": (e) => e.map((x) => ({ ...x, path: `./${x.path}` })),
  },
});
