import { describe, expect, test } from "bun:test";

describe("packaged WebRTC runtime metadata", () => {
  test("reflect-metadata is a direct runtime dependency", async () => {
    const pkg = await Bun.file("package.json").json();

    expect(pkg.dependencies["reflect-metadata"]).toBeString();
  });

  test("the packaged entrypoint initializes reflect metadata first", async () => {
    const entrypoint = await Bun.file("src/index.ts").text();
    const executableBody = entrypoint.replace(/^#!.*\n/, "");
    const firstImportLine = executableBody
      .split("\n")
      .find(line => line.startsWith("import "));

    expect(firstImportLine).toBe('import "reflect-metadata";');
  });
});
