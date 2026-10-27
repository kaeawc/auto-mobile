import { SimulatorTemplateCleanup } from "../../../src/features/iosTemplates/SimulatorTemplateCleanup";
import { expect, test } from "bun:test";
import { FileSimulatorTemplateManifestStore } from "../../../src/features/iosTemplates/FileSimulatorTemplateManifestStore";
import { FakeTemplateManifestFiles } from "../../fakes/FakeTemplateManifestFiles";
import { SimulatorTemplatesHarness } from "../../helpers/SimulatorTemplatesHarness";
test("manifest round-trips and removes through fake filesystem", async () => {
  const fake = new SimulatorTemplatesHarness();
  fake.ready();
  const files = new FakeTemplateManifestFiles();
  const store = new FileSimulatorTemplateManifestStore(files, () => "/fake/templates");
  await store.write(fake.manifest!);
  expect(await store.read(fake.manifest!.key)).toEqual(fake.manifest);
  expect(await store.list()).toEqual([fake.manifest!]);
  await store.remove(fake.manifest!.key);
  expect(await store.read(fake.manifest!.key)).toBeUndefined();
});

test("corrupt manifests are absent, skipped and removable by cleanup", async () => {
  const fake = new SimulatorTemplatesHarness();
  fake.ready();
  if (!fake.manifest) {
    throw new Error("fixture");
  }
  const files = new FakeTemplateManifestFiles();
  const store = new FileSimulatorTemplateManifestStore(files, () => "/fake/templates");
  await store.write(fake.manifest);
  const path = [...files.files.keys()][0];
  if (!path) {
    throw new Error("fixture path");
  }
  for (const bad of [
    "{",
    "{}",
    JSON.stringify({ ...fake.manifest, udid: "not-a-uuid" }),
    JSON.stringify({ ...fake.manifest, key: { ...fake.manifest.key, xcodeBuild: "other" } }),
  ]) {
    files.files.set(path, bad);
    expect(await store.read(fake.manifest.key)).toBeUndefined();
    expect(await store.list()).toEqual([]);
  }
  await store.removeInvalid();
  expect(files.files.size).toBe(0);
});
test("runtime cleanup removes invalid files without consulting simulator UDIDs", async () => {
  const fake = new SimulatorTemplatesHarness();
  fake.ready();
  if (!fake.manifest) {
    throw new Error("fixture");
  }
  const files = new FakeTemplateManifestFiles();
  const store = new FileSimulatorTemplateManifestStore(files, () => "/fake/templates");
  await store.write(fake.manifest);
  const path = [...files.files.keys()][0];
  if (!path) {
    throw new Error("fixture");
  }
  files.files.set(path, "{");
  const cleanup = new SimulatorTemplateCleanup(fake.client, store, {
    acquire: async () => () => {},
    acquireName: async () => () => {},
  });
  await cleanup.clean({ runtime: "ios" });
  expect(files.files.size).toBe(0);
  expect(fake.events).toEqual([]);
});
