import { describe, expect, test } from "bun:test";
import fixture from "../../../fixtures/prototype-saved-layout/layout.json";
import type { PrototypeJson } from "../../../../src/features/prototype/prototypeSpec";
import type {
  PrototypeAssetMimeType,
  PrototypeAssetUpload,
} from "../../../../src/features/prototype/prototypeAssets";
import { DefaultDataContainerWriter } from "../../../../src/features/prototype/ios/iosPrototypeInstallerAdapters";
import { DirectorySavedPrototypeLayoutWriter } from "../../../../src/features/prototype/savedPrototypeLayout";
import { FakeSavedPrototypeLayoutFileSystem } from "../../../fakes/FakeSavedPrototypeLayoutFileSystem";
import { FakeSavedPrototypeLayoutWriter } from "../../../fakes/FakeSavedPrototypeLayoutWriter";
import { FakeIdGenerator } from "../../../fakes/FakeIdGenerator";

const destination = "/data/Documents/prototype";
const legacy = "/data/Documents/prototype.json";
const spec = JSON.parse(fixture.specJson) as PrototypeJson;
const assets: readonly PrototypeAssetUpload[] = fixture.assets.map((asset) => ({
  id: asset.id,
  mimeType: asset.mediaType as PrototypeAssetMimeType,
  bytes: Buffer.from(asset.base64, "base64"),
}));

function setup() {
  const files = new FakeSavedPrototypeLayoutFileSystem();
  const writer = new DefaultDataContainerWriter(
    new DirectorySavedPrototypeLayoutWriter(files, new FakeIdGenerator(["save"])),
    { rm: files.remove.bind(files) },
  );
  files.files.set(legacy, Buffer.from("legacy spec"));
  return { files, writer };
}

describe("DefaultDataContainerWriter", () => {
  test("writes shared fixture layout and removes legacy only after commit", async () => {
    const { files, writer } = setup();
    await writer.write("/data", spec, assets);
    expect([...files.files.keys()].sort()).toEqual(
      ["manifest.json", "spec.json", ...Object.keys(fixture.expected.files)]
        .map((file) => `${destination}/${file}`)
        .sort(),
    );
    expect(
      JSON.parse(Buffer.from(files.files.get(`${destination}/manifest.json`) ?? []).toString()),
    ).toEqual(fixture.expected.manifest);
    expect(Buffer.from(files.files.get(`${destination}/spec.json`) ?? []).toString()).toBe(
      JSON.stringify(spec),
    );
    for (const asset of assets) {
      const entry = [...fixture.expected.manifest.assets, ...fixture.expected.manifest.fonts].find(
        (entry) => entry.id === asset.id,
      )!;
      expect(files.files.get(`${destination}/${entry.file}`)).toEqual(asset.bytes);
    }
    expect([...files.directories].sort()).toEqual([
      `${destination}/assets`,
      `${destination}/fonts`,
    ]);
    expect(files.operations.filter((op) => op.startsWith("rename "))).toEqual([
      `rename /data/Documents/.tmp-save ${destination}`,
    ]);
    const commit = files.operations.indexOf(`rename /data/Documents/.tmp-save ${destination}`);
    expect(commit).toBeGreaterThan(
      files.operations.indexOf("write /data/Documents/.tmp-save/manifest.json"),
    );
    expect(files.operations.indexOf(`remove ${legacy}`)).toBeGreaterThan(commit);
    expect(files.files.has(legacy)).toBe(false);
  }, 15);

  test("stages replacement before backup rename and removes backup after commit", async () => {
    const { files, writer } = setup();
    files.files.set(`${destination}/old-spec`, Buffer.from("old"));
    await writer.write("/data", spec, assets);
    expect(files.operations.filter((op) => op.startsWith("rename "))).toEqual([
      `rename ${destination} /data/Documents/.old-save`,
      `rename /data/Documents/.tmp-save ${destination}`,
    ]);
    const backup = files.operations.indexOf(`rename ${destination} /data/Documents/.old-save`);
    expect(backup).toBeGreaterThan(
      files.operations.indexOf("write /data/Documents/.tmp-save/manifest.json"),
    );
    expect(files.operations.indexOf("remove /data/Documents/.old-save")).toBeGreaterThan(
      backup + 1,
    );
    expect(
      [...files.files.keys(), ...files.directories].some(
        (path) => path.includes(".tmp-") || path.includes(".old-"),
      ),
    ).toBe(false);
    expect(files.files.has(`${destination}/old-spec`)).toBe(false);
  }, 15);

  test("preserves legacy and propagates rejection message and reason", async () => {
    const { files } = setup();
    const layout = new FakeSavedPrototypeLayoutWriter();
    layout.result = { kind: "rejected", reason: "INVALID_FONT", message: "Font bytes are invalid" };
    const writer = new DefaultDataContainerWriter(layout, { rm: files.remove.bind(files) });
    await expect(writer.write("/data", spec, assets)).rejects.toMatchObject({
      message: "Font bytes are invalid",
      reason: "INVALID_FONT",
    });
    expect(layout.requests).toEqual([
      {
        destination,
        request: {
          specJson: JSON.stringify(spec),
          assets: assets.map((asset) => ({
            id: asset.id,
            mediaType: asset.mimeType,
            bytes: asset.bytes,
          })),
        },
      },
    ]);
    expect(files.files.get(legacy)).toEqual(Buffer.from("legacy spec"));
    expect(files.operations).toEqual([]);
  }, 15);

  test("preserves legacy on injected storage failure", async () => {
    const { files, writer } = setup();
    files.failOperation = (operation) => operation === "write /data/Documents/.tmp-save/spec.json";
    await expect(writer.write("/data", spec, assets)).rejects.toMatchObject({
      reason: "STORAGE_FAILURE",
    });
    expect(files.files.get(legacy)).toEqual(Buffer.from("legacy spec"));
    expect(files.operations).not.toContain(`remove ${legacy}`);
    expect([...files.files.keys()]).toEqual([legacy]);
    expect(files.directories.size).toBe(0);
  }, 15);

  test("omitted assets writes manifest with empty assets and fonts", async () => {
    const { files, writer } = setup();
    await writer.write("/data", spec);
    expect(
      JSON.parse(Buffer.from(files.files.get(`${destination}/manifest.json`) ?? []).toString()),
    ).toEqual({
      formatVersion: 1,
      specFile: "spec.json",
      assets: [],
      fonts: [],
    });
    expect([...files.files.keys()].sort()).toEqual([
      `${destination}/manifest.json`,
      `${destination}/spec.json`,
    ]);
    expect(Buffer.from(files.files.get(`${destination}/spec.json`) ?? []).toString()).toBe(
      JSON.stringify(spec),
    );
  }, 15);
});
