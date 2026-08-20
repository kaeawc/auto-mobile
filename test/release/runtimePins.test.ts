import { describe, expect, test } from "bun:test";
import {
  computePins,
  findGraphMismatches,
  isExactVersion,
  lastKeyComponent,
  parseBunLock,
  repartitionDependencies,
  resolveKey,
  resolveRuntimeClosure,
  splitIdSpec,
} from "../../scripts/release/lib/runtime-pins";

/**
 * A tiny synthetic Bun lockfile that mirrors the real hazard from issue #5421: a
 * runtime root (`img-lib`) whose transitive graph reaches a package via caret
 * ranges (`codec` -> `asn1`), plus a package name (`shared`) that the repo also
 * uses directly at a different major, plus a `@types/*` node that must never be
 * pinned. Trailing commas are included to exercise the JSONC tolerance.
 */
const FIXTURE_LOCK = `{
  "lockfileVersion": 1,
  "packages": {
    "img-lib": ["img-lib@2.0.0", "", { "dependencies": { "codec": "^1.4.0", "shared": "^1.0.0" }, "optionalDependencies": { "img-native-darwin": "2.0.0" } }, "sha512-a"],
    "codec": ["codec@1.4.7", "", { "dependencies": { "asn1": "^3.1.0" } }, "sha512-b"],
    "asn1": ["asn1@3.1.9", "", {}, "sha512-c"],
    "shared": ["shared@1.9.0", "", { "dependencies": { "@types/node": "^16.0.0" } }, "sha512-d"],
    "@types/node": ["@types/node@16.9.1", "", {}, "sha512-e"],
    "img-native-darwin": ["img-native-darwin@2.0.0", "", {}, "sha512-f"],
    "unrelated": ["unrelated@9.9.9", "", { "dependencies": { "codec": "^1.4.0" } }, "sha512-g"],
  }
}`;

describe("splitIdSpec", () => {
  test("splits scoped and unscoped id specs", () => {
    expect(splitIdSpec("codec@1.4.7")).toEqual({ name: "codec", version: "1.4.7" });
    expect(splitIdSpec("@jimp/core@1.6.1")).toEqual({ name: "@jimp/core", version: "1.6.1" });
  });
});

describe("isExactVersion", () => {
  test("accepts plain semver, rejects ranges and tags", () => {
    for (const ok of ["1.2.3", "0.35.3", "1.6.1-beta.2", "2.0.0+build.1"]) {
      expect(isExactVersion(ok)).toBe(true);
    }
    for (const bad of [
      "^1.2.3",
      "~1.2.3",
      ">=1.0.0",
      "1.x",
      "*",
      "1.2.3 - 2.0.0",
      "latest",
      "npm:foo@1.0.0",
    ]) {
      expect(isExactVersion(bad)).toBe(false);
    }
  });
});

describe("lastKeyComponent", () => {
  test("returns the trailing package name, handling scopes and nesting", () => {
    expect(lastKeyComponent("codec")).toBe("codec");
    expect(lastKeyComponent("@jimp/core")).toBe("@jimp/core");
    expect(lastKeyComponent("a/b/core")).toBe("core");
    expect(lastKeyComponent("a/@scope/pkg")).toBe("@scope/pkg");
  });
});

describe("resolveKey", () => {
  test("does not match an unscoped name against a scoped key", () => {
    const graph = parseBunLock(`{
      "packages": {
        "@jimp/core": ["@jimp/core@1.6.1", "", {}, "h"]
      }
    }`);
    // Unscoped `core` must NOT resolve to the scoped `@jimp/core`.
    expect(resolveKey(graph, "core", null)).toBeNull();
    expect(resolveKey(graph, "@jimp/core", null)).toBe("@jimp/core");
  });

  test("falls back to a nested entry by trailing component", () => {
    const graph = parseBunLock(`{
      "packages": {
        "parent/only-nested": ["only-nested@2.0.0", "", {}, "h"]
      }
    }`);
    expect(resolveKey(graph, "only-nested", null)).toBe("parent/only-nested");
  });
});

describe("parseBunLock", () => {
  test("parses JSONC with trailing commas into resolved nodes", () => {
    const graph = parseBunLock(FIXTURE_LOCK);
    expect(graph.get("codec")?.version).toBe("1.4.7");
    expect(graph.get("img-lib")?.deps).toEqual({ codec: "^1.4.0", shared: "^1.0.0" });
    expect(graph.get("img-lib")?.optionalDeps).toEqual({ "img-native-darwin": "2.0.0" });
  });
});

describe("resolveRuntimeClosure", () => {
  test("walks transitive deps and optionalDeps from the roots only", () => {
    const graph = parseBunLock(FIXTURE_LOCK);
    const closure = resolveRuntimeClosure(graph, ["img-lib"]);
    const names = [...closure.keys()].sort();
    // Reaches img-lib -> codec -> asn1, img-lib -> shared -> @types/node,
    // and the optional native binary. Never reaches `unrelated`.
    expect(names).toEqual([
      "@types/node",
      "asn1",
      "codec",
      "img-lib",
      "img-native-darwin",
      "shared",
    ]);
    expect(closure.get("asn1")).toEqual(new Set(["3.1.9"]));
  });
});

describe("computePins", () => {
  test("exact-pins the closure, excludes @types/ and native @img-style prefixes", () => {
    const graph = parseBunLock(FIXTURE_LOCK);
    const pins = computePins(graph, ["img-lib"], { excludePrefixes: ["@types/", "img-native-"] });
    expect(pins.dependencies).toEqual({
      asn1: "3.1.9",
      codec: "1.4.7",
      "img-lib": "2.0.0",
      shared: "1.9.0",
    });
    expect(Object.values(pins.dependencies).every(isExactVersion)).toBe(true);
    expect(pins.excluded).toEqual(["@types/node", "img-native-darwin"]);
  });

  test("reports multi-version names and pins the highest", () => {
    const graph = parseBunLock(`{
      "packages": {
        "root": ["root@1.0.0", "", { "dependencies": { "a": "^1.0.0", "b": "^2.0.0" } }, "h"],
        "a": ["a@1.0.0", "", { "dependencies": { "dup": "^1.0.0" } }, "h"],
        "b": ["b@2.0.0", "", { "dependencies": { "dup": "^2.0.0" } }, "h"],
        "dup": ["dup@2.5.0", "", {}, "h"],
        "a/dup": ["dup@1.5.0", "", {}, "h"]
      }
    }`);
    const pins = computePins(graph, ["root"]);
    expect(pins.multiVersion.dup).toEqual(["2.5.0", "1.5.0"]);
    expect(pins.dependencies.dup).toBe("2.5.0");
  });
});

describe("repartitionDependencies", () => {
  test("pins roots + pure transitives, leaves directly-used names unpinned, moves inlined deps to dev", () => {
    const graph = parseBunLock(FIXTURE_LOCK);
    const pins = computePins(graph, ["img-lib"], { excludePrefixes: ["@types/", "img-native-"] });
    const result = repartitionDependencies({
      currentDependencies: { "img-lib": "^2.0.0", shared: "^2.0.0", werift: "^0.24.0" },
      currentDevDependencies: { typescript: "^7.0.0" },
      roots: ["img-lib"],
      closurePins: pins.dependencies,
    });

    // Root + pure-transitive closure nodes are pinned exact.
    expect(result.dependencies).toEqual({ asn1: "3.1.9", codec: "1.4.7", "img-lib": "2.0.0" });
    // `shared` is used directly at a different major -> stays dev at our version,
    // never pinned to the transitive 1.9.0 (that would collide with our build).
    expect(result.residualUnpinned).toEqual(["shared"]);
    expect(result.devDependencies.shared).toBe("^2.0.0");
    // Inlined-only dep moves to dev at its own range.
    expect(result.devDependencies.werift).toBe("^0.24.0");
    expect(result.devDependencies.typescript).toBe("^7.0.0");
    // No name may appear in both maps.
    const both = Object.keys(result.dependencies).filter((n) => n in result.devDependencies);
    expect(both).toEqual([]);
  });

  test("a runtime root that was previously a devDependency is not left in both maps", () => {
    const graph = parseBunLock(FIXTURE_LOCK);
    const pins = computePins(graph, ["img-lib", "codec"], {
      excludePrefixes: ["@types/", "img-native-"],
    });
    const result = repartitionDependencies({
      currentDependencies: { "img-lib": "^2.0.0" },
      // codec is currently a devDependency but is now a runtime root.
      currentDevDependencies: { codec: "^1.0.0", typescript: "^7.0.0" },
      roots: ["img-lib", "codec"],
      closurePins: pins.dependencies,
    });
    expect(result.dependencies.codec).toBe("1.4.7");
    expect(result.devDependencies.codec).toBeUndefined();
    expect(result.devDependencies.typescript).toBe("^7.0.0");
  });

  test("is idempotent: re-running on already-pinned package.json is a no-op", () => {
    const graph = parseBunLock(FIXTURE_LOCK);
    const pins = computePins(graph, ["img-lib"], { excludePrefixes: ["@types/", "img-native-"] });
    const first = repartitionDependencies({
      currentDependencies: { "img-lib": "^2.0.0", shared: "^2.0.0", werift: "^0.24.0" },
      currentDevDependencies: { typescript: "^7.0.0" },
      roots: ["img-lib"],
      closurePins: pins.dependencies,
    });
    const second = repartitionDependencies({
      currentDependencies: first.dependencies,
      currentDevDependencies: first.devDependencies,
      roots: ["img-lib"],
      closurePins: pins.dependencies,
    });
    expect(second.dependencies).toEqual(first.dependencies);
    expect(second.devDependencies).toEqual(first.devDependencies);
    expect(second.residualUnpinned).toEqual(first.residualUnpinned);
  });
});

describe("findGraphMismatches", () => {
  const expected = { asn1: "3.1.9", codec: "1.4.7" };

  test("returns nothing when the resolved graph reproduces the pins", () => {
    expect(
      findGraphMismatches(expected, { asn1: "3.1.9", codec: "1.4.7", extra: "1.0.0" }),
    ).toEqual([]);
  });

  test("flags a drifted version and an absent package", () => {
    expect(findGraphMismatches(expected, { asn1: "3.2.0" })).toEqual([
      { name: "asn1", expected: "3.1.9", resolved: "3.2.0" },
      { name: "codec", expected: "1.4.7", resolved: undefined },
    ]);
  });
});
