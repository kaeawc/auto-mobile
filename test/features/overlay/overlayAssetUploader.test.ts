import { describe, expect, test } from "bun:test";
import {
  prepareOverlayAssets,
  uploadOverlayAssets,
} from "../../../src/features/overlay/overlayAssetUploader";
import {
  MAX_OVERLAY_ASSET_BYTES,
  MAX_OVERLAY_ASSET_COUNT,
  type OverlayAssetUpload,
} from "../../../src/features/overlay/overlayAssets";
import type { OverlayAssetResult } from "../../../src/features/observe/android/ctrlProxyProtocol";
import { FakeOverlayAssetFileReader } from "../../fakes/FakeOverlayAssetFileReader";
import { FakeCtrlProxy } from "../../fakes/FakeCtrlProxy";
import { FakeTimer } from "../../fakes/FakeTimer";

const png = (extra = 4) =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(extra),
  ]);
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]);
const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 ")]);

function preparedMimeTypes(prepared: Awaited<ReturnType<typeof prepareOverlayAssets>>): string[] {
  return "assets" in prepared ? prepared.assets.map((asset) => asset.mimeType) : [];
}

function preparedError(prepared: Awaited<ReturnType<typeof prepareOverlayAssets>>): string {
  return "error" in prepared ? prepared.error : "";
}

describe("prepareOverlayAssets", () => {
  test("detects PNG, JPEG and WebP from magic bytes, not the file name", async () => {
    const reader = new FakeOverlayAssetFileReader()
      .addFile("/a/one.jpg", png())
      .addFile("/a/two.png", jpeg)
      .addFile("/a/three", webp);
    const prepared = await prepareOverlayAssets(
      [
        { id: "one", path: "/a/one.jpg" },
        { id: "two", path: "/a/two.png" },
        { id: "three", path: "/a/three" },
      ],
      reader,
    );
    expect(preparedMimeTypes(prepared)).toEqual(["image/png", "image/jpeg", "image/webp"]);
  });

  test("rejects unsupported content, relative paths, directories and missing files", async () => {
    const reader = new FakeOverlayAssetFileReader()
      .addFile("/a/gif.png", Buffer.from("GIF89a-bytes"))
      .addDirectory("/a/dir");
    const cases: Array<[string, string]> = [
      ["/a/gif.png", "not a PNG, JPEG or WebP"],
      ["rel/x.png", "path must be absolute"],
      ["/a/dir", "not a regular file"],
      ["/a/missing.png", "cannot read file"],
    ];
    for (const [path, message] of cases) {
      const error = preparedError(await prepareOverlayAssets([{ id: "x", path }], reader));
      expect(error).toContain(message);
      expect(error).toContain("No assets were uploaded");
    }
  });

  test("enforces the per-asset limit from the file size, before reading the file", async () => {
    const reader = new FakeOverlayAssetFileReader().addFile(
      "/a/big.png",
      png(MAX_OVERLAY_ASSET_BYTES),
    );
    const prepared = await prepareOverlayAssets([{ id: "big", path: "/a/big.png" }], reader);
    expect(preparedError(prepared)).toContain(`limit is ${MAX_OVERLAY_ASSET_BYTES}`);
    expect(reader.reads).toEqual([]);
  });

  test("enforces the total, count and duplicate-id limits", async () => {
    const reader = new FakeOverlayAssetFileReader();
    const chunk = png(MAX_OVERLAY_ASSET_BYTES - 8);
    const names = ["a", "b", "c", "d", "e"];
    for (const name of names) {
      reader.addFile(`/a/${name}.png`, chunk);
    }
    const total = await prepareOverlayAssets(
      names.map((id) => ({ id, path: `/a/${id}.png` })),
      reader,
    );
    expect(preparedError(total)).toContain("total more than");
    const count = await prepareOverlayAssets(
      Array.from({ length: MAX_OVERLAY_ASSET_COUNT + 1 }, (_, i) => ({
        id: `i${i}`,
        path: "/a/a.png",
      })),
      reader,
    );
    expect(preparedError(count)).toContain(`At most ${MAX_OVERLAY_ASSET_COUNT}`);
    const dup = await prepareOverlayAssets(
      [
        { id: "a", path: "/a/a.png" },
        { id: "a", path: "/a/b.png" },
      ],
      reader,
    );
    expect(preparedError(dup)).toContain("more than once");
  });
});

describe("prepareOverlayAssets observation sources", () => {
  const uri = "automobile:observation/dev/obs/screenshot";
  const reader = new FakeOverlayAssetFileReader();

  test("reads the bytes through the observation reader and validates them like a file", async () => {
    const reads: string[] = [];
    const prepared = await prepareOverlayAssets(
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
      await prepareOverlayAssets([{ id: "shot", observation: uri }], reader, async () => ({
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
        async () => ({ bytes: png(MAX_OVERLAY_ASSET_BYTES) }),
        `limit is ${MAX_OVERLAY_ASSET_BYTES}`,
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
        await prepareOverlayAssets([{ id: "shot", observation: uri }], reader, read),
      );
      expect(error).toContain(message);
    }
  });

  test("without an observation reader the source is refused, and both or neither source is invalid", async () => {
    expect(
      preparedError(await prepareOverlayAssets([{ id: "shot", observation: uri }], reader)),
    ).toContain("not available");
    for (const source of [{ id: "x" }, { id: "x", path: "/a.png", observation: uri }]) {
      expect(preparedError(await prepareOverlayAssets([source], reader))).toContain(
        "exactly one of path or observation",
      );
    }
  });
});

describe("uploadOverlayAssets", () => {
  const assets = (...ids: string[]): OverlayAssetUpload[] =>
    ids.map((id) => ({ id, mimeType: "image/png", bytes: png() }));
  const newClient = () => new FakeCtrlProxy(new FakeTimer());

  test("uploads in order and reports what was stored", async () => {
    const client = newClient();
    const outcome = await uploadOverlayAssets(client, assets("a", "b"), { action: "show" });
    expect(outcome).toEqual({
      success: true,
      uploaded: [
        { id: "a", mimeType: "image/png", bytes: 12 },
        { id: "b", mimeType: "image/png", bytes: 12 },
      ],
    });
    const ids = client
      .getOverlayAssetHistory()
      .map((entry) => (entry.method === "put" ? entry.asset.id : ""));
    expect(ids).toEqual(["a", "b"]);
  });

  test("a failed re-upload says the overlay stays as first sent", async () => {
    const client = newClient();
    client.setOverlayAssetResult({
      success: false,
      error: "store full",
      dispatched: true,
      acknowledged: true,
    });
    const outcome = await uploadOverlayAssets(client, assets("a"), { action: "resend" });
    expect(outcome.error).toContain("The overlay stays as first sent");
    expect(outcome.error).not.toContain("was not shown");
  });

  test("a device refusal stops the run and names the assets already stored", async () => {
    const client = newClient();
    let calls = 0;
    client.requestPutOverlayAsset = async (): Promise<OverlayAssetResult> =>
      ++calls === 1
        ? { success: true, dispatched: true, acknowledged: true }
        : { success: false, error: "store full", dispatched: true, acknowledged: true };
    const outcome = await uploadOverlayAssets(client, assets("a", "b", "c"), { action: "show" });
    expect(outcome.success).toBe(false);
    expect(outcome.uploaded.map((asset) => asset.id)).toEqual(["a"]);
    expect(outcome.error).toContain("'b' failed. Device refused the upload: store full");
    expect(outcome.error).toContain("Already uploaded: a");
    expect(outcome.error).toContain("The overlay was not shown.");
    expect(calls).toBe(2);
  });

  test("a dispatched but unanswered upload is reported as indeterminate", async () => {
    const client = newClient();
    client.setOverlayAssetResult({
      success: false,
      error: "Upload outcome is indeterminate: timed out",
      dispatched: true,
      acknowledged: false,
    });
    const outcome = await uploadOverlayAssets(client, assets("a"), { action: "show" });
    expect(outcome.error).toContain("Outcome is indeterminate");
    expect(outcome.error).toContain("No assets were uploaded.");
    expect(outcome.error).toContain("The overlay was not shown.");
  });

  test("an old device's actionable error fails the call with nothing uploaded", async () => {
    const client = newClient();
    client.setFailureMode(
      "requestPutOverlayAsset",
      new Error(
        "put_overlay_asset: this CtrlProxy build does not support overlay assets; update the connected CtrlProxy.",
      ),
    );
    const outcome = await uploadOverlayAssets(client, assets("a"), { action: "show" });
    expect(outcome.success).toBe(false);
    expect(outcome.error).toContain(
      "does not support overlay assets; update the connected CtrlProxy",
    );
    expect(outcome.uploaded).toEqual([]);
  });

  test("an aborted request sends no further assets and forwards the signal", async () => {
    const client = newClient();
    const controller = new AbortController();
    const original = client.requestPutOverlayAsset.bind(client);
    client.requestPutOverlayAsset = async (asset, options) => {
      const result = await original(asset, options);
      controller.abort();
      return result;
    };
    const outcome = await uploadOverlayAssets(client, assets("a", "b"), {
      action: "show",
      signal: controller.signal,
    });
    expect(outcome.error).toContain("cancelled before 'b'");
    expect(outcome.uploaded.map((asset) => asset.id)).toEqual(["a"]);
    const history = client.getOverlayAssetHistory();
    expect(history).toHaveLength(1);
    const first = history[0];
    expect(first.options?.abortSignal).toBe(controller.signal);
  });
});
