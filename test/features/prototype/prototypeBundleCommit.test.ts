import { expect, test } from "bun:test";
import {
  commitBundleToDirectory,
  readPrototypeBundle,
} from "../../../src/features/prototype/prototypeBundle";
import { join, sep } from "node:path";
import {
  FAKE_BUNDLE_LIBRARY,
  FakeBundleCommitFileSystem,
} from "../../fakes/FakeBundleCommitFileSystem";
import { bundleCorpus, corpusBytes } from "./prototypeBundleCorpus";
/** A path under the fake library root, in this platform's form. */
const lib = (...parts: string[]): string => join(FAKE_BUNDLE_LIBRARY, ...parts);
const NEW = lib("new");
const STAGE = lib(".bundle-fake");

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
  const result = await commitBundleToDirectory(bundle(), NEW, fs);
  expect(result).toEqual({ ok: true, destination: NEW });
  expect(fs.operations[0]).toBe(`directory ${FAKE_BUNDLE_LIBRARY}`);
  expect(fs.operations).toContain(`stage ${FAKE_BUNDLE_LIBRARY} 448`);
  expect(fs.operations.at(-1)).toBe(`rename ${STAGE} ${NEW}`);
  expect([...fs.files.keys()].every((path) => path.startsWith(`${NEW}${sep}`))).toBe(true);
  expect(fs.files.size).toBe(4);
  expect(fs.operations.filter((op) => op.startsWith("rename "))).toHaveLength(1);
});
for (const operation of [
  `directory ${STAGE}`,
  `mkdir ${join(STAGE, "assets")} 448`,
  `write ${join(STAGE, "spec.json")}`,
  `rename ${STAGE} ${NEW}`,
]) {
  test(`cleanup on ${operation}`, async () => {
    const fs = new FakeBundleCommitFileSystem();
    fs.failOn = operation;
    const result = await commitBundleToDirectory(bundle(), NEW, fs);
    expect(result.ok).toBe(false);
    expect(fs.operations.at(-1)).toBe(`remove ${STAGE}`);
    expect(fs.files.size).toBe(0);
    expect(fs.directories.has(NEW)).toBe(false);
  });
}
test("symlink parent is rejected before staging", async () => {
  const fs = new FakeBundleCommitFileSystem();
  fs.symlinks.add(FAKE_BUNDLE_LIBRARY);
  expect((await commitBundleToDirectory(bundle(), NEW, fs)).ok).toBe(false);
  expect(fs.operations).toEqual([`directory ${FAKE_BUNDLE_LIBRARY}`]);
});
test("existing destination and dangling symlink are rejected", async () => {
  const fs = new FakeBundleCommitFileSystem();
  fs.symlinks.add(NEW);
  expect((await commitBundleToDirectory(bundle(), NEW, fs)).ok).toBe(false);
  expect(fs.operations.some((op) => op.startsWith("stage "))).toBe(false);
});
test("exclusive no-follow creation refuses planted leaf symlink", async () => {
  const fs = new FakeBundleCommitFileSystem();
  fs.symlinks.add(join(STAGE, "spec.json"));
  expect((await commitBundleToDirectory(bundle(), NEW, fs)).ok).toBe(false);
  expect(fs.operations.at(-1)).toBe(`remove ${STAGE}`);
});
test("fresh stage creation failure does not remove someone else's directory", async () => {
  const fs = new FakeBundleCommitFileSystem();
  fs.directories.add(STAGE);
  expect((await commitBundleToDirectory(bundle(), NEW, fs)).ok).toBe(false);
  expect(fs.operations.some((op) => op.startsWith("remove "))).toBe(false);
});
test("cleanup failure returns a typed storage error", async () => {
  const fs = new FakeBundleCommitFileSystem();
  fs.symlinks.add(join(STAGE, "spec.json"));
  fs.failOn = `remove ${STAGE}`;
  expect(await commitBundleToDirectory(bundle(), NEW, fs)).toMatchObject({
    ok: false,
    code: "storage_failure",
  });
});

test("staging preserves advisory requirements while export derives them from the spec", async () => {
  const fs = new FakeBundleCommitFileSystem();
  const input = bundle();
  input.requires = ["future_capability_v2"];
  expect((await commitBundleToDirectory(input, NEW, fs)).ok).toBe(true);
  const manifest = JSON.parse(Buffer.from(fs.files.get(join(NEW, "bundle.json"))!).toString()) as {
    requires: string[];
  };
  expect(manifest.requires).toEqual(input.requires);
});
