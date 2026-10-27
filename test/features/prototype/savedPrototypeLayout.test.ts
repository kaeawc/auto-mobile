import { describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import fixture from "../../fixtures/prototype-saved-layout/layout.json";
import contract from "../../../schemas/prototype-asset-contract.json";
import { CountingIdGenerator } from "../../../src/utils/IdGenerator";
import { logger } from "../../../src/utils/logger";
import {
  DirectorySavedPrototypeLayoutWriter,
  savedPrototypeAssetPath,
  SAVED_PROTOTYPE_FORMAT_VERSION,
  type SavedPrototypeLayoutRequest,
  type SavedPrototypeLayoutRejection,
} from "../../../src/features/prototype/savedPrototypeLayout";
import { FakeSavedPrototypeLayoutFileSystem } from "../../fakes/FakeSavedPrototypeLayoutFileSystem";
import { FakeSavedPrototypeLayoutWriter } from "../../fakes/FakeSavedPrototypeLayoutWriter";
import {
  type PrototypeAssetMimeType,
  maxPrototypeAssetBytes,
  MAX_PROTOTYPE_ASSET_COUNT,
  MAX_PROTOTYPE_ASSET_TOTAL_BYTES,
  MAX_PROTOTYPE_ASSET_ID_LENGTH,
} from "../../../src/features/prototype/prototypeAssets";

function request(): SavedPrototypeLayoutRequest {
  return {
    specJson: fixture.specJson,
    assets: fixture.assets.map((a) => ({
      id: a.id,
      mediaType: a.mediaType as PrototypeAssetMimeType,
      bytes: Buffer.from(a.base64, "base64"),
    })),
  };
}
function setup() {
  const fs = new FakeSavedPrototypeLayoutFileSystem();
  return {
    fs,
    writer: new DirectorySavedPrototypeLayoutWriter(fs, new CountingIdGenerator("save")),
  };
}
async function refusal(input: SavedPrototypeLayoutRequest, reason: SavedPrototypeLayoutRejection) {
  const { fs, writer } = setup();
  expect(await writer.write(input, "/prototype")).toMatchObject({ kind: "rejected", reason });
  expect(fs.operations).toEqual([]);
}

describe("saved prototype layout", () => {
  test("shared fixture, exact manifest serialization, verbatim spec, dedup and atomic order", async () => {
    const { fs, writer } = setup();
    expect<unknown>(await writer.write(request(), "/prototype")).toEqual({
      kind: "written",
      destination: "/prototype",
      replaced: false,
      manifest: fixture.expected.manifest,
    });
    expect([...fs.files.keys()].sort()).toEqual(
      [...Object.keys(fixture.expected.files), "spec.json", "manifest.json"]
        .map((p) => `/prototype/${p}`)
        .sort(),
    );
    expect(
      Buffer.from(fs.files.get("/prototype/manifest.json") ?? new Uint8Array()).toString(),
    ).toBe(JSON.stringify(fixture.expected.manifest, null, 2) + "\n");
    expect(Buffer.from(fs.files.get("/prototype/spec.json") ?? new Uint8Array()).toString()).toBe(
      fixture.specJson,
    );
    const writes = fs.operations.filter((p) => p.startsWith("write "));
    expect(writes).toHaveLength(4);
    expect(writes.at(-1)).toBe("write /.tmp-save-1/manifest.json");
    expect(fs.operations.indexOf("rename /.tmp-save-1 /prototype")).toBeGreaterThan(
      fs.operations.indexOf(writes.at(-1) ?? ""),
    );
    for (const [file, hash] of Object.entries(fixture.expected.files)) {
      expect(
        createHash("sha256")
          .update(fs.files.get(`/prototype/${file}`) ?? new Uint8Array())
          .digest("hex"),
      ).toBe(hash);
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(savedPrototypeAssetPath("image/png", fixture.expected.manifest.assets[0].sha256)).toBe(
      fixture.expected.manifest.assets[0].file,
    );
  });
  test("replacement rollback preserves good data and clears temporary names", async () => {
    const { fs, writer } = setup();
    fs.files.set("/prototype/good", Uint8Array.of(42));
    fs.failOperation = (op) => op === "rename /.tmp-save-1 /prototype";
    expect(await writer.write(request(), "/prototype")).toMatchObject({
      kind: "rejected",
      reason: "STORAGE_FAILURE",
    });
    expect([...fs.files]).toEqual([["/prototype/good", Uint8Array.of(42)]]);
    expect([...fs.directories].some((p) => p.includes(".tmp-") || p.includes(".old-"))).toBe(false);
    expect(fs.operations.filter((op) => op.startsWith("rename"))).toEqual([
      "rename /prototype /.old-save-1",
      "rename /.tmp-save-1 /prototype",
      "rename /.old-save-1 /prototype",
    ]);
  });
  test("successful replacement retires old directory", async () => {
    const { fs, writer } = setup();
    fs.files.set("/prototype/old", Uint8Array.of(1));
    expect(await writer.write(request(), "/prototype")).toMatchObject({
      kind: "written",
      replaced: true,
    });
    expect(fs.files.has("/prototype/old")).toBe(false);
    expect([...fs.files.keys()].every((p) => p.startsWith("/prototype/"))).toBe(true);
  });
  test("backup cleanup failure preserves successful replacement", async () => {
    const { fs, writer } = setup();
    fs.files.set("/prototype/old", Uint8Array.of(42));
    fs.failOperation = (op) => op === "remove /.old-save-1";
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      expect(await writer.write(request(), "/prototype")).toMatchObject({
        kind: "written",
        replaced: true,
      });
      expect(fs.files.has("/prototype/old")).toBe(false);
      expect(Buffer.from(fs.files.get("/prototype/spec.json") ?? new Uint8Array()).toString()).toBe(
        fixture.specJson,
      );
      expect(
        Buffer.from(fs.files.get("/prototype/manifest.json") ?? new Uint8Array()).toString(),
      ).toBe(JSON.stringify(fixture.expected.manifest, null, 2) + "\n");
      for (const [file, hash] of Object.entries(fixture.expected.files)) {
        expect(
          createHash("sha256")
            .update(fs.files.get(`/prototype/${file}`) ?? new Uint8Array())
            .digest("hex"),
        ).toBe(hash);
      }
      expect(fs.files.get("/.old-save-1/old")).toEqual(Uint8Array.of(42));
      expect(warn).toHaveBeenCalledWith(
        "Failed to remove saved prototype backup directory",
        expect.objectContaining({ message: "Injected failure: remove /.old-save-1" }),
      );
    } finally {
      warn.mockRestore();
    }
  });
  test("commit and restore failures retain backup and log both errors", async () => {
    const { fs, writer } = setup();
    fs.files.set("/prototype/good", Uint8Array.of(42));
    fs.failOperation = (op) =>
      op === "rename /.tmp-save-1 /prototype" || op === "rename /.old-save-1 /prototype";
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      expect(await writer.write(request(), "/prototype")).toMatchObject({
        kind: "rejected",
        reason: "STORAGE_FAILURE",
      });
      expect([...fs.files]).toEqual([["/.old-save-1/good", Uint8Array.of(42)]]);
      expect(fs.operations).not.toContain("remove /.old-save-1");
      expect(warn).toHaveBeenCalledWith(
        "Failed to commit saved prototype; restoring previous directory",
        expect.objectContaining({ message: "Injected failure: rename /.tmp-save-1 /prototype" }),
      );
      expect(warn).toHaveBeenCalledWith(
        "Failed to restore saved prototype backup directory",
        expect.objectContaining({ message: "Injected failure: rename /.old-save-1 /prototype" }),
      );
      expect(warn).toHaveBeenCalledWith(
        "Failed to write saved prototype",
        expect.objectContaining({ message: "Injected failure: rename /.tmp-save-1 /prototype" }),
      );
    } finally {
      warn.mockRestore();
    }
  });
  test("storage write failure cleans staging", async () => {
    const { fs, writer } = setup();
    fs.failOperation = (op) => op.startsWith("write ");
    expect(await writer.write(request(), "/prototype")).toMatchObject({
      kind: "rejected",
      reason: "STORAGE_FAILURE",
    });
    expect(fs.files.size).toBe(0);
    expect(fs.directories.size).toBe(0);
  });
  test("invalid spec", async () => {
    await refusal({ ...request(), specJson: "{}" }, "INVALID_SPEC");
  });
  test("spec cap", async () => {
    await refusal({ ...request(), specJson: " ".repeat(1048577) }, "SPEC_TOO_LARGE");
  });
  test.each(["", "a".repeat(257)])("invalid id %s", async (id) => {
    const input = request();
    input.assets[0].id = id;
    await refusal(input, "INVALID_ASSET_ID");
  });
  test("duplicate ids across folders", async () => {
    const input = request();
    input.assets[2].id = input.assets[0].id;
    await refusal(input, "DUPLICATE_ASSET_ID");
  });
  test("unsupported MIME", async () => {
    const input = request();
    input.assets[0].mediaType = "image/gif" as PrototypeAssetMimeType;
    await refusal(input, "UNSUPPORTED_MIME_TYPE");
  });
  test("empty bytes", async () => {
    const input = request();
    input.assets[0].bytes = new Uint8Array();
    await refusal(input, "EMPTY_ASSET");
  });
  test.each(["image/png", "font/ttf"] as const)("size cap %s", async (mediaType) => {
    await refusal(
      {
        ...request(),
        assets: [
          { id: "large", mediaType, bytes: new Uint8Array(maxPrototypeAssetBytes(mediaType) + 1) },
        ],
      },
      "ASSET_TOO_LARGE",
    );
  });
  test.each([Uint8Array.of(1, 2, 3), Buffer.from("OTTO")])(
    "font signature must match MIME",
    async (bytes) => {
      await refusal(
        { ...request(), assets: [{ id: "font", mediaType: "font/ttf", bytes }] },
        "INVALID_FONT",
      );
    },
  );
  test("count cap", async () => {
    const asset = request().assets[0];
    await refusal(
      { ...request(), assets: Array.from({ length: 33 }, (_, i) => ({ ...asset, id: String(i) })) },
      "COUNT_LIMIT",
    );
  });
  test("total cap", async () => {
    const bytes = new Uint8Array(4194304);
    await refusal(
      {
        ...request(),
        assets: Array.from({ length: 5 }, (_, i) => ({
          id: String(i),
          mediaType: "image/png",
          bytes,
        })),
      },
      "TOTAL_LIMIT",
    );
  });
  test("limits match contract and inclusive count/id boundaries", async () => {
    expect(SAVED_PROTOTYPE_FORMAT_VERSION).toBe(fixture.formatVersion);
    expect(maxPrototypeAssetBytes("image/png")).toBe(contract.limits.MAX_PROTOTYPE_ASSET_BYTES);
    expect(maxPrototypeAssetBytes("font/ttf")).toBe(contract.limits.MAX_PROTOTYPE_FONT_ASSET_BYTES);
    expect(MAX_PROTOTYPE_ASSET_COUNT).toBe(contract.limits.MAX_PROTOTYPE_ASSET_COUNT);
    expect(MAX_PROTOTYPE_ASSET_TOTAL_BYTES).toBe(contract.limits.MAX_PROTOTYPE_ASSET_TOTAL_BYTES);
    expect(MAX_PROTOTYPE_ASSET_ID_LENGTH).toBe(contract.limits.MAX_PROTOTYPE_ASSET_ID_LENGTH);
    const { writer } = setup();
    const asset = request().assets[0];
    expect(
      await writer.write(
        {
          ...request(),
          assets: Array.from({ length: 32 }, (_, i) => ({
            ...asset,
            id: String(i).padStart(256, "a"),
          })),
        },
        "/prototype",
      ),
    ).toMatchObject({ kind: "written" });
  });
  test("empty request arrays allow missing spec references and preserve spec whitespace", async () => {
    const { fs, writer } = setup();
    const specJson = " " + fixture.specJson + "\n";
    expect(await writer.write({ specJson, assets: [] }, "/prototype")).toMatchObject({
      kind: "written",
      manifest: { assets: [], fonts: [] },
    });
    expect(Buffer.from(fs.files.get("/prototype/spec.json") ?? new Uint8Array()).toString()).toBe(
      specJson,
    );
  });
  test("spec byte boundary is inclusive", async () => {
    const { writer } = setup();
    const specJson = fixture.specJson.padEnd(1048576, " ");
    expect(await writer.write({ specJson, assets: [] }, "/prototype")).toMatchObject({
      kind: "written",
    });
  });
  test.each(["image/png", "font/ttf"] as const)(
    "per-file boundary is inclusive %s",
    async (mediaType) => {
      const { writer } = setup();
      const bytes = new Uint8Array(maxPrototypeAssetBytes(mediaType));
      if (mediaType === "font/ttf") {
        bytes.set([0, 1, 0, 0]);
      }
      expect(
        await writer.write(
          { specJson: fixture.specJson, assets: [{ id: "boundary", mediaType, bytes }] },
          "/prototype",
        ),
      ).toMatchObject({ kind: "written" });
    },
  );
  test("total boundary counts manifest entries even when bytes deduplicate", async () => {
    const { writer } = setup();
    const bytes = new Uint8Array(4194304);
    expect(
      await writer.write(
        {
          specJson: fixture.specJson,
          assets: Array.from({ length: 4 }, (_, i) => ({
            id: String(i),
            mediaType: "image/png",
            bytes,
          })),
        },
        "/prototype",
      ),
    ).toMatchObject({ kind: "written" });
  });
  test("writer fake records calls and supports configurable failures", async () => {
    const fake = new FakeSavedPrototypeLayoutWriter();
    const input = request();
    expect(await fake.write(input, "/prototype")).toMatchObject({ kind: "written" });
    expect(fake.requests).toEqual([{ request: input, destination: "/prototype" }]);
    fake.result = { kind: "rejected", reason: "STORAGE_FAILURE", message: "fake" };
    expect(await fake.write(input, "/prototype")).toEqual(fake.result);
  });
});
