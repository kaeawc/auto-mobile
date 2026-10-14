import { describe, expect, test, spyOn } from "bun:test";
import {
  FileSavedPrototypeMirror,
  missingOnDevice,
  type MirroredSavedPrototype,
} from "../../../src/features/prototype/savedPrototypeMirror";
import { CountingIdGenerator } from "../../../src/utils/IdGenerator";
import { logger } from "../../../src/utils/logger";
import { FakeMirrorFileSystem } from "../../fakes/FakeMirrorFileSystem";

export const entry: MirroredSavedPrototype = {
  id: "panel",
  label: "Panel",
  icon: "photo",
  spec: {
    id: "panel",
    window: { placement: { type: "fullscreen" } },
    root: { type: "image", asset: "photo" },
  },
  assets: [
    { id: "photo", mimeType: "image/png", bytes: new Uint8Array([1, 2, 3]) },
    { id: "missing" },
  ],
};
function harness() {
  const fs = new FakeMirrorFileSystem();
  return {
    fs,
    mirror: new FileSavedPrototypeMirror(fs, () => "/mirror", new CountingIdGenerator()),
  };
}
describe("saved prototype mirror", () => {
  test("round trips spec, label, icon, asset bytes and missing assets; removes entries", async () => {
    const { mirror } = harness();
    await mirror.record("emulator-5554", entry);
    expect(await mirror.list("emulator-5554")).toEqual([entry]);
    await mirror.remove("emulator-5554", entry.id);
    expect(await mirror.list("emulator-5554")).toEqual([]);
  });
  test.each(["../x", "a/b", "a\\b", "..", "CON", "R5CT1234", "emulator-5554", "A/B", "a%2Fb"])(
    "hostile serial %s and IDs cannot escape or collide",
    async (serial) => {
      const { mirror, fs } = harness();
      for (const id of ["../x", "a/b", "..", "CON", "A/B", "a\\b", "a%2Fb"]) {
        await mirror.record(serial, { ...entry, id, spec: { ...entry.spec, id } });
      }
      expect((await mirror.list(serial)).map((value) => value.id).sort()).toEqual(
        ["../x", "a/b", "..", "CON", "A/B", "a\\b", "a%2Fb"].sort(),
      );
      expect(
        [...fs.files.keys()].every(
          (file) => file.startsWith("/mirror/") && file.split("/").length >= 5,
        ),
      ).toBe(true);
      expect(await mirror.list("unknown")).toEqual([]);
    },
  );
  test.each([
    ["a/b", "a%2Fb"],
    ["a/b", "A/B"],
    ["\ud800", "\ud801"],
  ])("serials %s and %s have independent entries", async (first, second) => {
    const { mirror } = harness();
    await mirror.record(first, { ...entry, label: "First" });
    await mirror.record(second, { ...entry, label: "Second" });
    expect((await mirror.list(first))[0].label).toBe("First");
    expect((await mirror.list(second))[0].label).toBe("Second");
    await mirror.remove(first, entry.id);
    expect(await mirror.list(first)).toEqual([]);
    expect((await mirror.list(second))[0].label).toBe("Second");
  });
  test("corrupt and invalid manifests are skipped with a warning", async () => {
    const { mirror, fs } = harness();
    await mirror.record("device", entry);
    const manifest = [...fs.files.keys()].find((file) => file.endsWith("manifest.json"))!;
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      for (const contents of ["{", '{"id":"panel"}']) {
        await fs.writeFile(manifest, contents);
        expect(await mirror.list("device")).toEqual([]);
      }
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });
  test("failed replacement writes preserve the previous entry", async () => {
    const { mirror, fs } = harness();
    await mirror.record("device", entry);
    fs.failWrite = true;
    await expect(mirror.record("device", { ...entry, label: "Changed" })).rejects.toThrow(
      "write failed",
    );
    fs.failWrite = false;
    expect(await mirror.list("device")).toEqual([entry]);
  });
  test("replacement rename failure rolls back; successful replacement updates the whole entry", async () => {
    const { mirror, fs } = harness();
    await mirror.record("device", entry);
    const manifest = [...fs.files.keys()].find((file) => file.endsWith("manifest.json"))!;
    fs.failRenameTo = manifest.slice(0, -"/manifest.json".length);
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      await expect(mirror.record("device", { ...entry, label: "New" })).rejects.toThrow(
        "rename failed",
      );
      expect(await mirror.list("device")).toEqual([entry]);
      await mirror.record("device", { ...entry, label: "New", assets: [] });
      expect(await mirror.list("device")).toEqual([{ ...entry, label: "New", assets: [] }]);
      expect(
        [...fs.directories].some(
          (directory) => directory.includes(".tmp-") || directory.includes(".old-"),
        ),
      ).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });
  test("unreadable asset bytes remain visible as unavailable in a valid entry", async () => {
    const { mirror, fs } = harness();
    await mirror.record("device", entry);
    const file = [...fs.files.keys()].find((file) => file.endsWith(".bin"))!;
    await fs.rm(file);
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const entries = await mirror.list("device");
      expect(entries[0].assets).toEqual([
        { id: "photo", mimeType: "image/png" },
        { id: "missing" },
      ]);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
  test("root provider is lazy and not cached", async () => {
    const fs = new FakeMirrorFileSystem();
    let root = "/first";
    let resolutions = 0;
    const mirror = new FileSavedPrototypeMirror(
      fs,
      () => {
        resolutions++;
        return root;
      },
      new CountingIdGenerator(),
    );
    expect(resolutions).toBe(0);
    await mirror.record("device", entry);
    root = "/second";
    expect(await mirror.list("device")).toEqual([]);
    await mirror.record("device", { ...entry, label: "Second" });
    root = "/first";
    expect(await mirror.list("device")).toEqual([entry]);
  });
  test("missingOnDevice keeps host-only entries in mirror order", () => {
    const other = { ...entry, id: "other" };
    expect(missingOnDevice([entry, other], [{ id: entry.id }])).toEqual([other]);
  });
});
