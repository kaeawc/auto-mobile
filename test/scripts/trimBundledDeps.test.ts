import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  collectBundledPackages,
  listCandidates,
  runTrim,
  shouldTrimBundledDeps,
  type TrimOptions,
} from "../../scripts/release/trim-bundled-deps";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "pack-trim-"));
  roots.push(root);
  const put = (filename: string, value: unknown) => {
    const full = path.join(root, filename);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, typeof value === "string" ? value : JSON.stringify(value));
  };
  put("package.json", { bundledDependencies: ["pkg"] });
  put("node_modules/pkg/package.json", {
    name: "pkg",
    main: "lib",
    module: "runtime.ts",
    bin: { command: "cmd/tool.ts" },
    exports: {
      ".": { types: "./index.d.ts", "@zod/source": "./src/index.ts", default: "./lib/index.js" },
      "./locales/*": "./locales/*",
    },
    dependencies: { dep: "1" },
    optionalDependencies: { absent: "1" },
  });
  const retained = [
    "lib/index.js",
    "runtime.ts",
    "cmd/tool.ts",
    "locales/keep.d.ts",
    "README.md",
    "LICENSE",
    "test/NOTICE.md",
    "package.json",
  ];
  for (const filename of retained.filter((name) => name !== "package.json")) {
    put(`node_modules/pkg/${filename}`, `content ${filename}`);
  }
  for (const filename of [
    "index.d.ts",
    "index.d.cts",
    "index.d.mts",
    "index.js.map",
    "src/index.ts",
    "src/other.mts",
    "src/other.cts",
    "test/photo.jpg",
    "tests/test.js",
    "__tests__/sample.snap",
    "dist/docs/page.html",
    "examples/example.js",
    ".github/ci.yml",
    "CHANGELOG.md",
    "Makefile",
  ]) {
    put(`node_modules/pkg/${filename}`, `remove ${filename}`);
  }
  put("node_modules/pkg/node_modules/dep/package.json", {
    name: "dep",
    main: "index",
    dependencies: { pngjs: "1" },
  });
  put("node_modules/pkg/node_modules/dep/index.js", "module.exports = {};");
  const png = "node_modules/pkg/node_modules/dep/node_modules/pngjs";
  put(`${png}/package.json`, { name: "pngjs", main: "lib/png.js" });
  put(`${png}/lib/png.js`, "module.exports = {};");
  put(`${png}/browser.js`, "remove browser");
  put("node_modules/unrelated/package.json", { name: "unrelated" });
  put("node_modules/unrelated/test/image.jpg", "untouched");
  const stdout: string[] = [],
    stderr: string[] = [];
  const options: TrimOptions = {
    root,
    env: { CI: "true" },
    stdout: (message) => stdout.push(message),
    stderr: (message) => stderr.push(message),
  };
  return { root, put, options, stdout, stderr };
}
function tree(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  function walk(directory: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(filename);
      } else {
        result[path.relative(root, filename)] = readFileSync(filename).toString("base64");
      }
    }
  }
  walk(root);
  return result;
}

describe("reversible bundled dependency pack trim", () => {
  test("gate truth table", () => {
    for (const CI of [undefined, "true", "1", "false", ""]) {
      for (const override of [undefined, "true", "false", "unexpected"]) {
        expect(shouldTrimBundledDeps({ CI, AUTOMOBILE_TRIM_BUNDLED_DEPS: override })).toBe(
          override === "true" || (override !== "false" && (CI === "true" || CI === "1")),
        );
      }
    }
  });
  test("list is read-only and reports exactly the closure's unprotected candidates", () => {
    const { root, options, stdout } = fixture();
    const before = tree(root);
    expect(collectBundledPackages(root)).toHaveLength(3);
    const candidates = listCandidates(root);
    expect(candidates).toHaveLength(16);
    expect(candidates.some((item) => item.path.endsWith("pngjs/browser.js"))).toBe(true);
    expect(
      candidates.some((item) =>
        /unrelated|runtime.ts|cmd\/tool.ts|locales|README|NOTICE|LICENSE/.test(item.path),
      ),
    ).toBe(false);
    runTrim("list", { ...options, env: {} });
    expect(stdout).toEqual([
      ...candidates.map((item) => `${item.path}\t${item.size}`),
      `Total: 16 files, ${candidates.reduce((sum, item) => sum + item.size, 0)} bytes`,
    ]);
    expect(tree(root)).toEqual(before);
  });
  test("prepack removes exact candidates, postpack restores every byte, stdout is empty", () => {
    const { root, options, stdout } = fixture();
    const before = tree(root),
      candidates = listCandidates(root);
    runTrim("prepack", options);
    for (const item of candidates) {
      expect(existsSync(path.join(root, item.path))).toBe(false);
    }
    expect(existsSync(path.join(root, "node_modules/pkg/runtime.ts"))).toBe(true);
    expect(existsSync(path.join(root, "node_modules/unrelated/test/image.jpg"))).toBe(true);
    runTrim("postpack", options);
    runTrim("postpack", options);
    expect(tree(root)).toEqual(before);
    expect(stdout).toEqual([]);
    expect(existsSync(path.join(root, ".pack-trim-backup"))).toBe(false);
  });
  test("disabled gate never touches the fixture", () => {
    const { root, options, stdout } = fixture();
    const before = tree(root);
    runTrim("prepack", { ...options, env: { CI: "true", AUTOMOBILE_TRIM_BUNDLED_DEPS: "false" } });
    expect(tree(root)).toEqual(before);
    expect(stdout).toEqual([]);
  });
  test("second prepack restores stale backup before computing a fresh plan", () => {
    const { root, options } = fixture();
    const before = tree(root);
    runTrim("prepack", options);
    runTrim("prepack", {
      ...options,
      candidates: (directory, packages) => {
        expect(tree(directory)).toEqual(before);
        return listCandidates(directory, packages);
      },
    });
    runTrim("postpack", options);
    expect(tree(root)).toEqual(before);
  });
  test("broken protection fails the independent entry assertion and restores", () => {
    const { root, options } = fixture();
    const before = tree(root);
    expect(() =>
      runTrim("prepack", {
        ...options,
        candidates: (directory, packages) => [
          ...listCandidates(directory, packages),
          { path: "node_modules/pkg/runtime.ts", size: 1 },
        ],
      }),
    ).toThrow("Trim removed runtime entry");
    expect(tree(root)).toEqual(before);
  });
  test("remaining JS literal references retain explicit browser files", () => {
    const { root, put } = fixture();
    put(
      "node_modules/pkg/node_modules/dep/node_modules/pngjs/lib/png.js",
      'require("../browser");',
    );
    expect(listCandidates(root).some((item) => item.path.endsWith("browser.js"))).toBe(false);
  });
  test("partial wildcard prefixes and referenced tinycolor builds are retained", () => {
    const { root, put } = fixture();
    put("node_modules/pkg/node_modules/dep/package.json", {
      name: "tinycolor2",
      main: "index.js",
      exports: { ".": "./index.js", "./prefix*": "./src/prefix*" },
    });
    put("node_modules/pkg/node_modules/dep/src/prefix.ts", "keep wildcard");
    for (const file of ["tinycolor.js", "esm/test.js", "cjs/test.js"]) {
      put(`node_modules/pkg/node_modules/dep/${file}`, "keep audited reference");
    }
    expect(listCandidates(root).some((item) => item.path.includes("/dep/"))).toBe(false);
  });
  test("extensionless main and directory bin resolve; ambiguous main keeps entire package", () => {
    const { root, put } = fixture();
    put("node_modules/pkg/node_modules/dep/package.json", {
      name: "dep",
      main: "absent",
      dependencies: { pngjs: "1" },
    });
    put("node_modules/pkg/node_modules/dep/test/test.ts", "keep ambiguous");
    expect(listCandidates(root).some((item) => item.path.endsWith("dep/test/test.ts"))).toBe(false);
  });
});
