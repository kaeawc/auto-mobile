import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "../..");

async function readRepoFile(relativePath: string): Promise<string> {
  return readFile(join(repoRoot, relativePath), "utf-8");
}

describe("image backend cache contract docs", () => {
  test("design doc is accepted and documents per-machine nav screenshot caches", async () => {
    const designDoc = await readRepoFile("docs/design-docs/image-backend.md");

    expect(designDoc).toContain("Status: accepted");
    expect(designDoc).toContain("nav-screenshot caches are per-machine");
    expect(designDoc).toContain("not portable across platforms");
    expect(designDoc).toContain("sharp");
    expect(designDoc).toContain("jimp");
  });

  test("observe docs surface the per-machine cache contract near perceptual matching", async () => {
    const observeDoc = await readRepoFile("docs/design-docs/plat/android/observe.md");

    expect(observeDoc).toContain("Per-machine cache contract");
    expect(observeDoc).toContain("nav-screenshot caches are local to the machine");
    expect(observeDoc).toContain("not portable across platforms");
  });
});
