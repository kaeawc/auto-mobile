import { toolIsError, toolStructured } from "../helpers/toolResponse";
import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { registerPrototypeTools, prototypeOutputSchema } from "../../src/server/prototypeTools";
import {
  prototypeMediaRefusal,
  splitPrototypeMediaSources,
} from "../../src/server/prototypeTools/mediaAssets";
import { ToolRegistry } from "../../src/server/toolRegistry";
import type { BootedDevice } from "../../src/models";
import type { PrototypeMediaFileOpener } from "../../src/features/prototype/prototypeMediaUpload";
import { preparePrototypeAssets } from "../../src/features/prototype/prototypeAssetUploader";
import { FakeCtrlProxy } from "../fakes/FakeCtrlProxy";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakePrototypeAssetFileReader } from "../fakes/FakePrototypeAssetFileReader";
import { preserveToolRegistry } from "../helpers/withTemporaryTool";
import { warmedTests } from "../helpers/warmedTests";

const device: BootedDevice = { deviceId: "fake-prototype", platform: "android", name: "Fake" };
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(4),
]);
const mp4 = new Uint8Array([0, 0, 0, 0x18, ...Buffer.from("ftypisom"), ...new Array(20).fill(3)]);
const spec = {
  id: "panel",
  window: { placement: { type: "fullscreen" as const } },
  root: { type: "image" as const, asset: "logo" },
};
const assets = [
  { id: "logo", path: "/img/logo.png" },
  { id: "clip", path: "/media/clip.mp4" },
];

/** In-memory media files, so nothing touches disk. */
const opener: PrototypeMediaFileOpener = {
  async open(path) {
    if (path !== "/media/clip.mp4") {
      throw new Error("ENOENT: no such file");
    }
    return {
      size: mp4.length,
      read: async (offset, length) => mp4.slice(offset, offset + length),
      close: async () => {},
    };
  },
};

describe("prototype tool media assets (#14254)", () => {
  let client: FakeCtrlProxy;
  let teardown: (() => void) | undefined;
  function registerTools(): void {
    const restore = preserveToolRegistry();
    const timer = new FakeTimer();
    client = new FakeCtrlProxy(timer);
    const unsubscribe = registerPrototypeTools({
      clientFactory: () => client,
      clock: timer,
      timer,
      assetFileReader: new FakePrototypeAssetFileReader().addFile("/img/logo.png", png),
      mediaFileOpener: opener,
    });
    teardown = () => {
      unsubscribe();
      restore();
    };
  }
  function tearDown(): void {
    teardown?.();
    teardown = undefined;
  }
  const warmed = warmedTests(() => {
    tearDown();
    registerTools();
  });
  afterAll(tearDown);

  async function call(input: Record<string, unknown>) {
    const response = await ToolRegistry.getTool("prototype")!.deviceAwareHandler!(device, input);
    return { response, payload: prototypeOutputSchema.parse(toolStructured(response)) };
  }

  warmed("show streams a media file after the images and reports both as uploaded", async () => {
    const { response, payload } = await call({ action: "show", spec, assets });
    expect(toolIsError(response)).toBe(false);
    expect(client.getPrototypeAssetHistory().map((entry) => entry.method)).toEqual(["put"]);
    expect(client.getPrototypeMediaHistory().map((message) => message.type)).toEqual([
      "put_prototype_asset_begin",
      "put_prototype_asset_chunk",
      "put_prototype_asset_commit",
    ]);
    expect(client.getPrototypeMediaHistory()[0]).toMatchObject({
      id: "clip",
      mimeType: "video/mp4",
      size: mp4.length,
      sha256: createHash("sha256").update(mp4).digest("hex"),
    });
    expect(payload.uploadedAssets).toEqual([
      { id: "logo", mimeType: "image/png", bytes: 12 },
      { id: "clip", mimeType: "video/mp4", bytes: mp4.length },
    ]);
    expect(client.getPrototypeHistory()).toHaveLength(1);
  });

  test("a refused media upload leaves the prototype unshown and names what was stored", async () => {
    client.setPrototypeMediaReply((message) =>
      message.type === "put_prototype_asset_begin"
        ? { success: false, code: "count_limit", error: "The media store is full." }
        : { success: true },
    );
    const { response, payload } = await call({ action: "show", spec, assets });
    expect(toolIsError(response)).toBe(true);
    expect(payload.error).toContain("The media store is full.");
    expect(payload.error).toContain("Already uploaded: logo");
    expect(client.getPrototypeHistory()).toHaveLength(0);
  });
});

describe("prototype media asset routing", () => {
  test("only paths with a media extension take the chunked upload", () => {
    expect(
      splitPrototypeMediaSources([
        { id: "a", path: "/x/a.PNG" },
        { id: "b", path: "/x/b.Mp3" },
        { id: "c", observation: "automobile:observation/d/o/screenshot" },
        { id: "d", path: "/x/subs.vtt" },
      ]),
    ).toEqual({
      media: [
        { id: "b", path: "/x/b.Mp3" },
        { id: "d", path: "/x/subs.vtt" },
      ],
      other: [
        { id: "a", path: "/x/a.PNG" },
        { id: "c", observation: "automobile:observation/d/o/screenshot" },
      ],
    });
  });

  test("only show carries media; save, share and installApp refuse it", async () => {
    const media = [{ id: "clip", path: "/m/clip.mp4" }];
    expect(prototypeMediaRefusal(media, "save", undefined, false)).toStartWith(
      "Media assets ('clip') can only be sent with show for now: save cannot carry",
    );
    // Paths that bypass the show pipeline (iOS save, share, installApp) read assets directly.
    const prepared = await preparePrototypeAssets(media, new FakePrototypeAssetFileReader());
    expect("error" in prepared && prepared.error).toContain(
      "media assets can only be sent with show to an Android device for now",
    );
  });

  test("a transport without media support refuses, warning iOS about WebM and Ogg", () => {
    const media = [
      { id: "intro", path: "/m/intro.webm" },
      { id: "song", path: "/m/song.mp3" },
    ];
    expect(prototypeMediaRefusal([], "show", undefined, true)).toBeNull();
    const ios = prototypeMediaRefusal(media, "show", undefined, true);
    expect(ios).toContain("only Android CtrlProxy accepts video, audio and caption files");
    expect(ios).toContain(
      "On iOS, WebM and Ogg ('intro') would not play in any case: AVPlayer cannot decode them",
    );
    expect(prototypeMediaRefusal(media, "show", undefined, false)).not.toContain("AVPlayer");
  });
});
