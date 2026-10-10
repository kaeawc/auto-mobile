import { describe, expect, test } from "bun:test";

describe("packaged WebRTC runtime metadata", () => {
  // `reflect-metadata` is a side-effect polyfill that `build.ts` inlines into
  // `dist/src/index.js`. These source-level contracts stay in the fast unit
  // lane; the real bundle/subprocess proof lives in the integration companion.
  test("reflect-metadata is a direct dependency available to the build", async () => {
    const pkg = await Bun.file("package.json").json();
    const declaredVersion =
      pkg.dependencies?.["reflect-metadata"] ?? pkg.devDependencies?.["reflect-metadata"];
    expect(declaredVersion).toBeString();
  });

  // `./daemon/processEntry` must precede everything to capture the launcher pid
  // (#11041); it imports nothing, so runtime metadata is still initialized
  // before any module that could depend on it.
  test("the packaged entrypoint initializes runtime metadata first", async () => {
    const entrypoint = await Bun.file("src/index.ts").text();
    const executableBody = entrypoint.replace(/^#!.*\r?\n/, "");
    const importLines = executableBody.split(/\r?\n/).filter((line) => line.startsWith("import "));

    expect(importLines.slice(0, 2)).toEqual([
      'import "./daemon/processEntry";',
      'import "./runtime/reflectMetadata";',
    ]);
  });

  test("the process entry module imports nothing", async () => {
    const processEntry = await Bun.file("src/daemon/processEntry.ts").text();
    expect(processEntry).not.toMatch(
      /^\s*(import|export\s+\*\s+from|export\s+\{[^}]*\}\s+from)\b/m,
    );
  });

  test("runtime metadata initialization loads reflect-metadata", async () => {
    const runtimeInit = await Bun.file("src/runtime/reflectMetadata.ts").text();
    expect(runtimeInit.trim()).toBe('import "reflect-metadata";');
  });
});
