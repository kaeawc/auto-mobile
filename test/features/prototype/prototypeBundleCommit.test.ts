import { expect, test } from "bun:test";
import {
  commitBundleToDirectory,
  readPrototypeBundle,
} from "../../../src/features/prototype/prototypeBundle";
import { FakeBundleCommitFileSystem } from "../../fakes/FakeBundleCommitFileSystem";
import { bundleCorpus, corpusBytes } from "./prototypeBundleCorpus";
function bundle() {
  const entry = bundleCorpus().cases.find((c) => c.name === "golden-image-font")!;
  const result = readPrototypeBundle(corpusBytes(entry));
  if (!result.ok) {
    throw new Error(result.message);
  }
  return result.bundle;
}
test("stage is 0700, checked, no-follow writes complete before a single atomic rename", async () => {
  const fs = new FakeBundleCommitFileSystem();
  const result = await commitBundleToDirectory(bundle(), "/library/new", fs);
  expect(result).toEqual({ ok: true, destination: "/library/new" });
  expect(fs.operations[0]).toBe("directory /library");
  expect(fs.operations).toContain("stage /library 448");
  expect(fs.operations.at(-1)).toBe("rename /library/.bundle-fake /library/new");
  expect([...fs.files.keys()].every((path) => path.startsWith("/library/new/"))).toBe(true);
  expect(fs.files.size).toBe(4);
  expect(fs.operations.filter((op) => op.startsWith("rename "))).toHaveLength(1);
});
for (const operation of [
  "directory /library/.bundle-fake",
  "mkdir /library/.bundle-fake/assets 448",
  "write /library/.bundle-fake/spec.json",
  "rename /library/.bundle-fake /library/new",
]) {
  test(`cleanup on ${operation}`, async () => {
    const fs = new FakeBundleCommitFileSystem();
    fs.failOn = operation;
    const result = await commitBundleToDirectory(bundle(), "/library/new", fs);
    expect(result.ok).toBe(false);
    expect(fs.operations.at(-1)).toBe("remove /library/.bundle-fake");
    expect(fs.files.size).toBe(0);
    expect(fs.directories.has("/library/new")).toBe(false);
  });
}
test("symlink parent is rejected before staging", async () => {
  const fs = new FakeBundleCommitFileSystem();
  fs.symlinks.add("/library");
  expect((await commitBundleToDirectory(bundle(), "/library/new", fs)).ok).toBe(false);
  expect(fs.operations).toEqual(["directory /library"]);
});
test("existing destination and dangling symlink are rejected", async () => {
  const fs = new FakeBundleCommitFileSystem();
  fs.symlinks.add("/library/new");
  expect((await commitBundleToDirectory(bundle(), "/library/new", fs)).ok).toBe(false);
  expect(fs.operations.some((op) => op.startsWith("stage "))).toBe(false);
});
test("exclusive no-follow creation refuses planted leaf symlink", async () => {
  const fs = new FakeBundleCommitFileSystem();
  fs.symlinks.add("/library/.bundle-fake/spec.json");
  expect((await commitBundleToDirectory(bundle(), "/library/new", fs)).ok).toBe(false);
  expect(fs.operations.at(-1)).toBe("remove /library/.bundle-fake");
});
test("fresh stage creation failure does not remove someone else's directory", async () => {
  const fs = new FakeBundleCommitFileSystem();
  fs.directories.add("/library/.bundle-fake");
  expect((await commitBundleToDirectory(bundle(), "/library/new", fs)).ok).toBe(false);
  expect(fs.operations.some((op) => op.startsWith("remove "))).toBe(false);
});
test("cleanup failure returns a typed storage error", async () => {
  const fs = new FakeBundleCommitFileSystem();
  fs.symlinks.add("/library/.bundle-fake/spec.json");
  fs.failOn = "remove /library/.bundle-fake";
  expect(await commitBundleToDirectory(bundle(), "/library/new", fs)).toMatchObject({
    ok: false,
    code: "storage_failure",
  });
});

test("staging preserves advisory requirements while export derives them from the spec", async () => {
  const fs = new FakeBundleCommitFileSystem();
  const input = bundle();
  input.requires = ["future_capability_v2"];
  expect((await commitBundleToDirectory(input, "/library/new", fs)).ok).toBe(true);
  const manifest = JSON.parse(
    Buffer.from(fs.files.get("/library/new/bundle.json")!).toString(),
  ) as { requires: string[] };
  expect(manifest.requires).toEqual(input.requires);
});
