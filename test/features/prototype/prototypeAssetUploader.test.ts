import { describe, expect, test } from "bun:test";
import {
  preparePrototypeAssets,
  uploadPrototypeAssets,
} from "../../../src/features/prototype/prototypeAssetUploader";
import {
  MAX_PROTOTYPE_ASSET_BYTES,
  MAX_PROTOTYPE_ASSET_COUNT,
  type PrototypeAssetUpload,
} from "../../../src/features/prototype/prototypeAssets";
import type { PrototypeAssetResult } from "../../../src/features/observe/android/ctrlProxyProtocol";
import { FakePrototypeAssetFileReader } from "../../fakes/FakePrototypeAssetFileReader";
import { FakeCtrlProxy } from "../../fakes/FakeCtrlProxy";
import { FakeTimer } from "../../fakes/FakeTimer";

const png = (extra = 4) =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(extra),
  ]);
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]);
const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 ")]);

function preparedMimeTypes(prepared: Awaited<ReturnType<typeof preparePrototypeAssets>>): string[] {
  return "assets" in prepared ? prepared.assets.map((asset) => asset.mimeType) : [];
}

function preparedError(prepared: Awaited<ReturnType<typeof preparePrototypeAssets>>): string {
  return "error" in prepared ? prepared.error : "";
}

describe("preparePrototypeAssets", () => {
  test("detects PNG, JPEG and WebP from magic bytes, not the file name", async () => {
    const reader = new FakePrototypeAssetFileReader()
      .addFile("/a/one.jpg", png())
      .addFile("/a/two.png", jpeg)
      .addFile("/a/three", webp);
    const prepared = await preparePrototypeAssets(
      [
        { id: "one", path: "/a/one.jpg" },
        { id: "two", path: "/a/two.png" },
        { id: "three", path: "/a/three" },
      ],
      reader,
    );
    expect(preparedMimeTypes(prepared)).toEqual(["image/png", "image/jpeg", "image/webp"]);
  });

  test("accepts TrueType and OpenType font files by signature and caps them at 2 MiB", async () => {
    const ttf = Buffer.concat([Buffer.from([0x00, 0x01, 0x00, 0x00]), Buffer.alloc(8)]);
    const otf = Buffer.concat([Buffer.from("OTTO"), Buffer.alloc(8)]);
    const big = Buffer.concat([Buffer.from("OTTO"), Buffer.alloc(2 * 1024 * 1024)]);
    const reader = new FakePrototypeAssetFileReader()
      .addFile("/f/a.bin", ttf)
      .addFile("/f/b.ttf", otf)
      .addFile("/f/big.otf", big);
    const prepared = await preparePrototypeAssets(
      [
        { id: "a", path: "/f/a.bin" },
        { id: "b", path: "/f/b.ttf" },
      ],
      reader,
    );
    expect(preparedMimeTypes(prepared)).toEqual(["font/ttf", "font/otf"]);
    const tooBig = await preparePrototypeAssets([{ id: "big", path: "/f/big.otf" }], reader);
    expect(preparedError(tooBig)).toContain(`the limit is ${2 * 1024 * 1024}`);
  });

  test("rejects unsupported content, relative paths, directories and missing files", async () => {
    const reader = new FakePrototypeAssetFileReader()
      .addFile("/a/gif.png", Buffer.from("GIF89a-bytes"))
      .addDirectory("/a/dir");
    const cases: Array<[string, string]> = [
      ["/a/gif.png", "not a PNG, JPEG or WebP"],
      ["rel/x.png", "path must be absolute"],
      ["/a/dir", "not a regular file"],
      ["/a/missing.png", "cannot read file"],
    ];
    for (const [path, message] of cases) {
      const error = preparedError(await preparePrototypeAssets([{ id: "x", path }], reader));
      expect(error).toContain(message);
      expect(error).toContain("No assets were uploaded");
    }
  });

  test("enforces the per-asset limit from the file size, before reading the file", async () => {
    const reader = new FakePrototypeAssetFileReader().addFile(
      "/a/big.png",
      png(MAX_PROTOTYPE_ASSET_BYTES),
    );
    const prepared = await preparePrototypeAssets([{ id: "big", path: "/a/big.png" }], reader);
    expect(preparedError(prepared)).toContain(`limit is ${MAX_PROTOTYPE_ASSET_BYTES}`);
    expect(reader.reads).toEqual([]);
  });

  test("enforces the total, count and duplicate-id limits", async () => {
    const reader = new FakePrototypeAssetFileReader();
    const chunk = png(MAX_PROTOTYPE_ASSET_BYTES - 8);
    const names = ["a", "b", "c", "d", "e"];
    for (const name of names) {
      reader.addFile(`/a/${name}.png`, chunk);
    }
    const total = await preparePrototypeAssets(
      names.map((id) => ({ id, path: `/a/${id}.png` })),
      reader,
    );
    expect(preparedError(total)).toContain("total more than");
    const count = await preparePrototypeAssets(
      Array.from({ length: MAX_PROTOTYPE_ASSET_COUNT + 1 }, (_, i) => ({
        id: `i${i}`,
        path: "/a/a.png",
      })),
      reader,
    );
    expect(preparedError(count)).toContain(`At most ${MAX_PROTOTYPE_ASSET_COUNT}`);
    const dup = await preparePrototypeAssets(
      [
        { id: "a", path: "/a/a.png" },
        { id: "a", path: "/a/b.png" },
      ],
      reader,
    );
    expect(preparedError(dup)).toContain("more than once");
  });
});

describe("preparePrototypeAssets observation sources", () => {
  const uri = "automobile:observation/dev/obs/screenshot";
  const reader = new FakePrototypeAssetFileReader();

  test("reads the bytes through the observation reader and validates them like a file", async () => {
    const reads: string[] = [];
    const prepared = await preparePrototypeAssets(
      [{ id: "shot", observation: uri }],
      reader,
      async (u) => {
        reads.push(u);
        return { bytes: webp };
      },
    );
    expect(preparedMimeTypes(prepared)).toEqual(["image/webp"]);
    expect(reads).toEqual([uri]);
    expect(reader.reads).toEqual([]);
  });

  test("names the observation and the reason when it cannot be read", async () => {
    const error = preparedError(
      await preparePrototypeAssets([{ id: "shot", observation: uri }], reader, async () => ({
        error: "Observation id obs is unknown or has been superseded.",
      })),
    );
    expect(error).toContain(`'shot' (${uri})`);
    expect(error).toContain("superseded");
    expect(error).toContain("No assets were uploaded");
  });

  test("rejects non-image bytes, oversize screenshots and a throwing reader", async () => {
    const cases: Array<[() => Promise<{ bytes: Buffer }>, string]> = [
      [async () => ({ bytes: Buffer.from("GIF89a-bytes") }), "not a PNG, JPEG or WebP"],
      [
        async () => ({ bytes: png(MAX_PROTOTYPE_ASSET_BYTES) }),
        `limit is ${MAX_PROTOTYPE_ASSET_BYTES}`,
      ],
      [
        async () => {
          throw new Error("disk gone");
        },
        "cannot read observation screenshot: disk gone",
      ],
    ];
    for (const [read, message] of cases) {
      const error = preparedError(
        await preparePrototypeAssets([{ id: "shot", observation: uri }], reader, read),
      );
      expect(error).toContain(message);
    }
  });

  test("without an observation reader the source is refused, and both or neither source is invalid", async () => {
    expect(
      preparedError(await preparePrototypeAssets([{ id: "shot", observation: uri }], reader)),
    ).toContain("not available");
    for (const source of [{ id: "x" }, { id: "x", path: "/a.png", observation: uri }]) {
      expect(preparedError(await preparePrototypeAssets([source], reader))).toContain(
        "exactly one of path or observation",
      );
    }
  });
});

describe("uploadPrototypeAssets", () => {
  const assets = (...ids: string[]): PrototypeAssetUpload[] =>
    ids.map((id) => ({ id, mimeType: "image/png", bytes: png() }));
  const newClient = () => new FakeCtrlProxy(new FakeTimer());

  test("uploads in order and reports what was stored", async () => {
    const client = newClient();
    const outcome = await uploadPrototypeAssets(client, assets("a", "b"), { action: "show" });
    expect(outcome).toEqual({
      success: true,
      uploaded: [
        { id: "a", mimeType: "image/png", bytes: 12 },
        { id: "b", mimeType: "image/png", bytes: 12 },
      ],
    });
    const ids = client
      .getPrototypeAssetHistory()
      .map((entry) => (entry.method === "put" ? entry.asset.id : ""));
    expect(ids).toEqual(["a", "b"]);
  });

  test("a failed re-upload says the prototype stays as first sent", async () => {
    const client = newClient();
    client.setPrototypeAssetResult({
      success: false,
      error: "store full",
      dispatched: true,
      acknowledged: true,
    });
    const outcome = await uploadPrototypeAssets(client, assets("a"), { action: "resend" });
    expect(outcome.error).toContain("The prototype stays as first sent");
    expect(outcome.error).not.toContain("was not shown");
  });

  test("a device refusal stops the run and names the assets already stored", async () => {
    const client = newClient();
    let calls = 0;
    client.requestPutPrototypeAsset = async (): Promise<PrototypeAssetResult> =>
      ++calls === 1
        ? { success: true, dispatched: true, acknowledged: true }
        : { success: false, error: "store full", dispatched: true, acknowledged: true };
    const outcome = await uploadPrototypeAssets(client, assets("a", "b", "c"), { action: "show" });
    expect(outcome.success).toBe(false);
    expect(outcome.uploaded.map((asset) => asset.id)).toEqual(["a"]);
    expect(outcome.error).toContain("'b' failed. Device refused the upload: store full");
    expect(outcome.error).toContain("Already uploaded: a");
    expect(outcome.error).toContain(
      "The new spec was not sent; a prototype already showing stays as it was.",
    );
    expect(calls).toBe(2);
  });

  test("a dispatched but unanswered upload is reported as indeterminate", async () => {
    const client = newClient();
    client.setPrototypeAssetResult({
      success: false,
      error: "Upload outcome is indeterminate: timed out",
      dispatched: true,
      acknowledged: false,
    });
    const outcome = await uploadPrototypeAssets(client, assets("a"), { action: "show" });
    expect(outcome.error).toContain("Outcome is indeterminate");
    expect(outcome.error).toContain("No assets were uploaded.");
    expect(outcome.error).toContain(
      "The new spec was not sent; a prototype already showing stays as it was.",
    );
  });

  test("an old device's actionable error fails the call with nothing uploaded", async () => {
    const client = newClient();
    client.setFailureMode(
      "requestPutPrototypeAsset",
      new Error(
        "put_prototype_asset: this CtrlProxy build does not support prototype assets; update the connected CtrlProxy.",
      ),
    );
    const outcome = await uploadPrototypeAssets(client, assets("a"), { action: "show" });
    expect(outcome.success).toBe(false);
    expect(outcome.error).toContain(
      "does not support prototype assets; update the connected CtrlProxy",
    );
    expect(outcome.uploaded).toEqual([]);
  });

  test("an aborted request sends no further assets and forwards the signal", async () => {
    const client = newClient();
    const controller = new AbortController();
    const original = client.requestPutPrototypeAsset.bind(client);
    client.requestPutPrototypeAsset = async (asset, options) => {
      const result = await original(asset, options);
      controller.abort();
      return result;
    };
    const outcome = await uploadPrototypeAssets(client, assets("a", "b"), {
      action: "show",
      signal: controller.signal,
    });
    expect(outcome.error).toContain("cancelled before 'b'");
    expect(outcome.uploaded.map((asset) => asset.id)).toEqual(["a"]);
    const history = client.getPrototypeAssetHistory();
    expect(history).toHaveLength(1);
    const first = history[0];
    expect(first.options?.abortSignal).toBe(controller.signal);
  });
});
