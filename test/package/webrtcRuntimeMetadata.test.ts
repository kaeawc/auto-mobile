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

  test("the packaged entrypoint initializes runtime metadata first", async () => {
    const entrypoint = await Bun.file("src/index.ts").text();
    const executableBody = entrypoint.replace(/^#!.*\r?\n/, "");
    const firstImportLine = executableBody
      .split(/\r?\n/)
      .find((line) => line.startsWith("import "));

    expect(firstImportLine).toBe('import "./runtime/reflectMetadata";');
  });

  test("runtime metadata initialization loads reflect-metadata", async () => {
    const runtimeInit = await Bun.file("src/runtime/reflectMetadata.ts").text();
    expect(runtimeInit.trim()).toBe('import "reflect-metadata";');
  });
});
