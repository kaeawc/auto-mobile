import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import cases from "../../fixtures/prototype-media-transport/cases.json";
import {
  type PrototypeMediaFileOpener,
  type PrototypeMediaTransportClient,
  type PrototypeMediaTransportMessage,
  type PrototypeMediaTransportResult,
  prototypeMediaChunkRanges,
  prototypeMediaMimeTypeForPath,
  uploadPrototypeMediaAsset,
} from "../../../src/features/prototype/prototypeMediaUpload";

class FakeMediaClient implements PrototypeMediaTransportClient {
  readonly sent: PrototypeMediaTransportMessage[] = [];
  constructor(
    private readonly answer: (
      message: PrototypeMediaTransportMessage,
    ) => PrototypeMediaTransportResult = () => ({ success: true }),
  ) {}

  async sendPrototypeMediaMessage(
    message: PrototypeMediaTransportMessage,
  ): Promise<PrototypeMediaTransportResult> {
    this.sent.push(message);
    return this.answer(message);
  }

  types(): string[] {
    return this.sent.map((message) => message.type);
  }
}

/** In-memory files; records every read so tests can assert chunk-at-a-time access. */
class FakeMediaFiles implements PrototypeMediaFileOpener {
  readonly reads: number[] = [];
  closed = 0;
  constructor(private readonly files: Record<string, Uint8Array>) {}

  async open(path: string) {
    const bytes = this.files[path];
    if (!bytes) {
      throw new Error("ENOENT: no such file");
    }
    return {
      size: bytes.length,
      read: async (offset: number, length: number) => {
        this.reads.push(length);
        return bytes.slice(offset, offset + length);
      },
      close: async () => {
        this.closed += 1;
      },
    };
  }
}

function fixtureBytes(name: string): Uint8Array {
  const item = cases.signatures.find((entry) => entry.name === name);
  if (!item) {
    throw new Error(`missing fixture ${name}`);
  }
  return Buffer.from(item.hex, "hex");
}

const MP4 = fixtureBytes("mp4 ftyp box");

describe("prototype media chunked upload", () => {
  test("maps extensions to media types", () => {
    expect(prototypeMediaMimeTypeForPath("/a/clip.MP4")).toBe("video/mp4");
    expect(prototypeMediaMimeTypeForPath("/a/song.m4a")).toBe("audio/mp4");
    expect(prototypeMediaMimeTypeForPath("/a/captions.vtt")).toBe("text/vtt");
    expect(prototypeMediaMimeTypeForPath("/a/image.png")).toBeNull();
  });

  test("splits into contiguous chunks no larger than the cap", () => {
    expect(prototypeMediaChunkRanges(10, 4)).toEqual([
      { offset: 0, length: 4 },
      { offset: 4, length: 4 },
      { offset: 8, length: 2 },
    ]);
    expect(prototypeMediaChunkRanges(0, 4)).toEqual([]);
  });

  test("sends begin with the digest, contiguous chunks, then commit", async () => {
    const client = new FakeMediaClient();
    const files = new FakeMediaFiles({ "/m/clip.mp4": MP4 });
    const outcome = await uploadPrototypeMediaAsset(
      client,
      { id: "clip", path: "/m/clip.mp4" },
      { opener: files, chunkBytes: 16 },
    );
    expect(outcome).toEqual({ success: true, id: "clip", mimeType: "video/mp4", bytes: 36 });
    expect(client.types()).toEqual([
      "put_prototype_asset_begin",
      "put_prototype_asset_chunk",
      "put_prototype_asset_chunk",
      "put_prototype_asset_chunk",
      "put_prototype_asset_commit",
    ]);
    expect(client.sent[0]).toEqual({
      type: "put_prototype_asset_begin",
      id: "clip",
      mimeType: "video/mp4",
      size: 36,
      sha256: createHash("sha256").update(MP4).digest("hex"),
    });
    const chunks = client.sent.flatMap((message) =>
      message.type === "put_prototype_asset_chunk" ? [message] : [],
    );
    expect(chunks.map((chunk) => chunk.offset)).toEqual([0, 16, 32]);
    expect(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.dataBase64, "base64")))).toEqual(
      Buffer.from(MP4),
    );
    expect(Math.max(...files.reads)).toBeLessThanOrEqual(16);
    expect(files.closed).toBe(1);
  });

  test("a signature mismatch sends nothing", async () => {
    const client = new FakeMediaClient();
    const files = new FakeMediaFiles({ "/m/clip.mp4": fixtureBytes("webm EBML header") });
    const outcome = await uploadPrototypeMediaAsset(
      client,
      { id: "clip", path: "/m/clip.mp4" },
      { opener: files },
    );
    expect(outcome.success).toBe(false);
    expect(outcome.code).toBe("content_mismatch");
    expect(client.sent).toEqual([]);
  });

  test("invalid UTF-8 captions are refused before begin, even split across chunks", async () => {
    const client = new FakeMediaClient();
    const files = new FakeMediaFiles({
      "/m/bad.vtt": Buffer.from("WEBVTT\n\n\xc3", "latin1"),
      "/m/good.vtt": Buffer.from("WEBVTT\n\ncafé\n"),
    });
    const bad = await uploadPrototypeMediaAsset(
      client,
      { id: "cc", path: "/m/bad.vtt" },
      { opener: files, chunkBytes: 4 },
    );
    expect(bad.code).toBe("not_utf8");
    expect(client.sent).toEqual([]);
    const good = await uploadPrototypeMediaAsset(
      client,
      { id: "cc", path: "/m/good.vtt" },
      // 12 ends the first chunk on 0xc3, so é's two bytes arrive in different chunks.
      { opener: files, chunkBytes: 12 },
    );
    expect(good.success).toBe(true);
  });

  test("an oversize file is refused without being read", async () => {
    const client = new FakeMediaClient();
    const files = new FakeMediaFiles({ "/m/cc.vtt": new Uint8Array(256 * 1024 + 1) });
    const outcome = await uploadPrototypeMediaAsset(
      client,
      { id: "cc", path: "/m/cc.vtt" },
      { opener: files },
    );
    expect(outcome.code).toBe("too_large");
    expect(files.reads).toEqual([]);
    expect(client.sent).toEqual([]);
  });

  test("a device rejection mid-stream aborts the upload and reports the code", async () => {
    const client = new FakeMediaClient((message) =>
      message.type === "put_prototype_asset_commit"
        ? { success: false, code: "sha256_mismatch", error: "digest differs" }
        : { success: true },
    );
    const files = new FakeMediaFiles({ "/m/clip.mp4": MP4 });
    const outcome = await uploadPrototypeMediaAsset(
      client,
      { id: "clip", path: "/m/clip.mp4" },
      { opener: files },
    );
    expect(outcome.success).toBe(false);
    expect(outcome.code).toBe("sha256_mismatch");
    expect(outcome.error).toContain("digest differs");
    expect(client.types().at(-1)).toBe("put_prototype_asset_abort");
  });

  test("a refused begin sends no chunks and no abort", async () => {
    const client = new FakeMediaClient(() => ({
      success: false,
      code: "total_limit",
      error: "store full",
    }));
    const files = new FakeMediaFiles({ "/m/clip.mp4": MP4 });
    const outcome = await uploadPrototypeMediaAsset(
      client,
      { id: "clip", path: "/m/clip.mp4" },
      { opener: files },
    );
    expect(outcome.code).toBe("total_limit");
    expect(client.types()).toEqual(["put_prototype_asset_begin"]);
  });

  test("a begin lost in transit still aborts on the device", async () => {
    const client: PrototypeMediaTransportClient & { sent: PrototypeMediaTransportMessage[] } = {
      sent: [],
      async sendPrototypeMediaMessage(message) {
        this.sent.push(message);
        if (message.type === "put_prototype_asset_begin") {
          throw new Error("acknowledgement timed out");
        }
        return { success: true };
      },
    };
    const files = new FakeMediaFiles({ "/m/clip.mp4": MP4 });
    const outcome = await uploadPrototypeMediaAsset(
      client,
      { id: "clip", path: "/m/clip.mp4" },
      { opener: files },
    );
    expect(outcome.success).toBe(false);
    expect(outcome.error).toContain("timed out");
    expect(client.sent.map((message) => message.type)).toEqual([
      "put_prototype_asset_begin",
      "put_prototype_asset_abort",
    ]);
  });

  test("cancellation between chunks aborts on the device", async () => {
    const controller = new AbortController();
    const client = new FakeMediaClient((message) => {
      if (message.type === "put_prototype_asset_chunk") {
        controller.abort();
      }
      return { success: true };
    });
    const files = new FakeMediaFiles({ "/m/clip.mp4": MP4 });
    const outcome = await uploadPrototypeMediaAsset(
      client,
      { id: "clip", path: "/m/clip.mp4" },
      { opener: files, chunkBytes: 12, signal: controller.signal },
    );
    expect(outcome.success).toBe(false);
    expect(outcome.error).toContain("cancelled");
    expect(client.types()).toEqual([
      "put_prototype_asset_begin",
      "put_prototype_asset_chunk",
      "put_prototype_asset_abort",
    ]);
  });

  test("relative paths, unknown extensions and missing files fail cleanly", async () => {
    const client = new FakeMediaClient();
    const files = new FakeMediaFiles({});
    const relative = await uploadPrototypeMediaAsset(
      client,
      { id: "a", path: "clip.mp4" },
      { opener: files },
    );
    expect(relative.error).toContain("absolute");
    const unknown = await uploadPrototypeMediaAsset(
      client,
      { id: "a", path: "/m/clip.mov" },
      { opener: files },
    );
    expect(unknown.code).toBe("unsupported_mime_type");
    const missing = await uploadPrototypeMediaAsset(
      client,
      { id: "a", path: "/m/clip.mp4" },
      { opener: files },
    );
    expect(missing.error).toContain("ENOENT");
    expect(client.sent).toEqual([]);
  });
});
