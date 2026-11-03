import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  fileStem,
  shareProtoViewerBundle,
} from "../../../../src/features/prototype/protoViewer/protoViewerShare";
import { readPrototypeBundle } from "../../../../src/features/prototype/prototypeBundle";
import type { PrototypeSpec } from "../../../../src/features/prototype/prototypeSpec";
import { FakePrototypeAssetFileReader } from "../../../fakes/FakePrototypeAssetFileReader";
import { FakeProtoViewerShareFiles } from "../../../fakes/FakeProtoViewerShareFiles";

const URL_ = "https://example.com/releases/demo.automobile-proto";
const spec = {
  id: "demo",
  window: { placement: { type: "fullscreen" } },
  root: { type: "text", text: "Hello" },
} as PrototypeSpec;

/** Records the text it was asked to draw instead of encoding a QR. */
const qrTexts: string[] = [];
const fakeQr = {
  render(text: string) {
    qrTexts.push(text);
    return { png: Buffer.from(`png:${text}`), terminal: `qr:${text}` };
  },
};

function deps(files = new FakeProtoViewerShareFiles()) {
  return {
    files,
    qr: fakeQr,
    assetFileReader: new FakePrototypeAssetFileReader(),
    observationScreenshotReader: async () => {
      throw new Error("no observations in this test");
    },
  };
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

describe("prototype share", () => {
  test("with url: writes the bundle and QR, and the link carries the written bundle's hash", async () => {
    const files = new FakeProtoViewerShareFiles();
    const result = await shareProtoViewerBundle({ spec, url: URL_ }, deps(files));

    expect(result.success).toBe(true);
    const share = result.share!;
    const bundle = files.written.get(share.bundlePath)!;
    expect(share.bundlePath).toBe(
      path.join("/data/prototype-shares", `demo-${share.sha256.slice(0, 12)}.automobile-proto`),
    );
    expect(share.sha256).toBe(sha256(bundle));
    expect(share.bytes).toBe(bundle.length);
    expect(readPrototypeBundle(bundle).ok).toBe(true);
    const link = new URL(share.link!);
    expect(link.protocol).toBe("automobile-proto:");
    expect(link.searchParams.get("url")).toBe(URL_);
    expect(link.searchParams.get("sha256")).toBe(share.sha256);
    expect(share.qrPngPath).toBe(
      share.bundlePath.replace(
        ".automobile-proto",
        `-${sha256(Buffer.from(share.link!)).slice(0, 12)}.qr.png`,
      ),
    );
    expect(Buffer.from(files.written.get(share.qrPngPath!)!).toString()).toBe(`png:${share.link}`);
    expect(share.qr).toBe(`qr:${share.link}`);
    expect(qrTexts.at(-1)).toBe(share.link);
    expect(result.warning).toContain(URL_);
  });

  test("one bundle shared at two urls keeps a QR per link", async () => {
    const files = new FakeProtoViewerShareFiles();
    const first = await shareProtoViewerBundle({ spec, url: URL_ }, deps(files));
    const second = await shareProtoViewerBundle(
      { spec, url: "https://mirror.example.com/demo.automobile-proto" },
      deps(files),
    );
    expect(second.share?.bundlePath).toBe(first.share!.bundlePath);
    expect(second.share?.qrPngPath).not.toBe(first.share!.qrPngPath);
    expect(Buffer.from(files.written.get(first.share!.qrPngPath!)!).toString()).toBe(
      `png:${first.share!.link}`,
    );
  });

  test("the same spec shares to the same bytes and hash", async () => {
    const first = await shareProtoViewerBundle({ spec }, deps());
    const second = await shareProtoViewerBundle({ spec }, deps());
    expect(second.share?.sha256).toBe(first.share!.sha256);
  });

  test("without url: only the bundle is written, and the warning says how to get a link", async () => {
    const files = new FakeProtoViewerShareFiles();
    const result = await shareProtoViewerBundle({ spec }, deps(files));
    expect(result.success).toBe(true);
    expect(result.share?.link).toBeUndefined();
    expect(result.share?.qrPngPath).toBeUndefined();
    expect([...files.written.keys()]).toEqual([result.share!.bundlePath]);
    expect(result.warning).toContain("url");
  });

  test.each([
    "http://example.com/demo",
    "https://user:secret@example.com/demo",
    "https://example.com/demo#frag",
  ])("refuses %s before writing anything", async (url) => {
    const files = new FakeProtoViewerShareFiles();
    const result = await shareProtoViewerBundle({ spec, url }, deps(files));
    expect(result).toMatchObject({ success: false, errorCode: "invalid_url" });
    expect(files.written.size).toBe(0);
  });

  test("refuses a url whose link would be too dense for a QR", async () => {
    const files = new FakeProtoViewerShareFiles();
    const url = `https://example.com/${"%".repeat(400)}`;
    const result = await shareProtoViewerBundle({ spec, url }, deps(files));
    expect(result).toMatchObject({ success: false, errorCode: "invalid_url" });
    expect(result.error).toContain("too dense");
    expect(files.written.size).toBe(0);
  });

  test("refuses element anchors, which only resolve against a live screen", async () => {
    const anchored: PrototypeSpec = JSON.parse(
      JSON.stringify({
        ...spec,
        root: {
          type: "text",
          text: "Hi",
          anchor: { type: "element", selector: { text: "Buy" } },
        },
      }),
    );
    const result = await shareProtoViewerBundle({ spec: anchored, url: URL_ }, deps());
    expect(result).toMatchObject({ success: false, errorCode: "invalid_spec" });
  });

  test("an asset the spec references must be uploaded in the same call", async () => {
    const withImage: PrototypeSpec = JSON.parse(
      JSON.stringify({
        ...spec,
        root: { type: "image", asset: "hero", contentDescription: "Hero" },
      }),
    );
    const files = new FakeProtoViewerShareFiles();
    const result = await shareProtoViewerBundle({ spec: withImage }, deps(files));
    expect(result).toMatchObject({ success: false, errorCode: "missing_asset" });
    expect(result.error).toContain("Nothing was written.");
    expect(files.written.size).toBe(0);
  });
});

describe("share file names", () => {
  test.each([
    ["demo", "demo"],
    ["../../etc/passwd", "etc-passwd"],
    ["a/b\\c", "a-b-c"],
    ["...", "prototype"],
    ["x".repeat(80), "x".repeat(48)],
  ])("%s stays inside the share directory as %s", (id, stem) => {
    expect(fileStem(id)).toBe(stem);
  });
});
