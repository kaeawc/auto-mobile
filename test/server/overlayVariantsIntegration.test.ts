import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { overlayOutputSchema, registerOverlayTools } from "../../src/server/overlayTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import type { BootedDevice } from "../../src/models";
import { composeVariantCarousel } from "../../src/features/overlay/overlayVariants";
import { FakeAdbClientFactory } from "../fakes/FakeAdbClientFactory";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeCtrlProxy } from "../fakes/FakeCtrlProxy";
import { FakeOverlayAssetFileReader } from "../fakes/FakeOverlayAssetFileReader";
import { FakeTimer } from "../fakes/FakeTimer";
import { preserveToolRegistry } from "../helpers/withTemporaryTool";
import { event } from "../helpers/overlayTestEvent";

/**
 * `showVariants` is a show of the composed carousel, so it must compose with the integrated
 * mutation path: display resolution (#9308), asset staging and the missing-asset re-send (#9301).
 */
const BOTH_PANELS =
  'Display id 0: DisplayInfo{uniqueId "local:cover-key" type INTERNAL, real 100 x 100}\n' +
  'Display id 2: DisplayInfo{uniqueId "local:inner-key" type INTERNAL, real 200 x 200}';
const COVER_ONLY =
  'Display id 0: DisplayInfo{uniqueId "local:cover-key" type INTERNAL, real 100 x 100}';
const INVENTORY = "cmd display get-displays";
const device: BootedDevice = {
  deviceId: "fold-variants",
  platform: "android",
  name: "Fold",
  displays: {
    panels: [
      { key: "inner-key", role: "inner", sizePx: { width: 200, height: 200 } },
      { key: "cover-key", role: "cover", sizePx: { width: 100, height: 100 } },
    ],
    postures: ["opened", "closed"],
  },
};
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(4),
]);
const variants = [
  { image: { asset: "first" }, label: "First" },
  { image: { asset: "second" } },
  { spec: { type: "text" as const, text: "Third" } },
];
const assets = [
  { id: "first", path: "/img/first.png" },
  { id: "second", path: "/img/second.png" },
];
const carousel = { action: "showVariants", id: "panel", variants, assets };
const composed = composeVariantCarousel({ id: "panel", variants });

describe("showVariants on the integrated overlay mutation path", () => {
  let client: FakeCtrlProxy;
  let adb: FakeAdbExecutor;
  let reader: FakeOverlayAssetFileReader;
  let restore: () => void;
  let unsubscribe: () => void;

  beforeEach(() => {
    restore = preserveToolRegistry();
    const timer = new FakeTimer();
    client = new FakeCtrlProxy(timer);
    client.setSupportedCommands(["overlay_display_id_v1"]);
    adb = new FakeAdbExecutor();
    adb.setCommandResponse(INVENTORY, { stdout: BOTH_PANELS, stderr: "" });
    reader = new FakeOverlayAssetFileReader()
      .addFile("/img/first.png", png)
      .addFile("/img/second.png", png);
    unsubscribe = registerOverlayTools({
      clientFactory: () => client,
      adbFactory: new FakeAdbClientFactory(adb),
      lastRenderedObservation: () => undefined,
      assetFileReader: reader,
      clock: timer,
      timer,
    });
  });
  afterEach(() => {
    unsubscribe();
    restore();
  });

  async function call(
    input: Record<string, unknown>,
    progress?: (amount: number) => Promise<void>,
  ) {
    const response = await ToolRegistry.getTool("prototype")!.deviceAwareHandler!(
      device,
      input,
      progress,
    );
    return { response, payload: overlayOutputSchema.parse(response.structuredContent) };
  }
  const inventoryReads = () =>
    adb.getExecutedCommands().filter((command) => command.includes("get-displays")).length;
  const uploadedIds = () =>
    client
      .getOverlayAssetHistory()
      .flatMap((entry) => (entry.method === "put" ? [entry.asset.id] : []));

  test("with display and assets it uploads first, then shows the composed spec on that display", async () => {
    const order: string[] = [];
    const putAsset = client.requestPutOverlayAsset.bind(client);
    const show = client.requestShowOverlay.bind(client);
    client.requestPutOverlayAsset = async (asset, options) => {
      order.push(`put:${asset.id}`);
      return putAsset(asset, options);
    };
    client.requestShowOverlay = async (...args) => {
      order.push(`show:${args[3]}`);
      return show(...args);
    };
    const { response, payload } = await call({ ...carousel, display: "inner" });
    expect(response.isError).not.toBe(true);
    expect(order).toEqual(["put:first", "put:second", "show:2"]);
    expect(client.getOverlayHistory()).toMatchObject([
      { method: "show", spec: composed, displayId: 2 },
    ]);
    expect(payload.uploadedAssets?.map((asset) => asset.id)).toEqual(["first", "second"]);
    expect(payload.lastResult?.displayId).toBe(2);
    expect(inventoryReads()).toBe(1);
  });

  test("assets alone upload each image once, before the show, on the default display", async () => {
    const { payload } = await call(carousel);
    expect(payload.success).toBe(true);
    expect(uploadedIds()).toEqual(["first", "second"]);
    const shows = client.getOverlayHistory();
    expect(shows).toHaveLength(1);
    expect(Object.hasOwn(shows[0], "displayId")).toBe(false);
    expect(inventoryReads()).toBe(0);
  });

  test("display alone (no assets) shows on the resolved display", async () => {
    const { payload } = await call({
      action: "showVariants",
      id: "panel",
      variants: [{ spec: { type: "text", text: "Only" } }],
      display: "inner",
    });
    expect(payload.success).toBe(true);
    expect(client.getOverlayAssetHistory()).toEqual([]);
    expect(client.getOverlayHistory()).toMatchObject([{ displayId: 2 }]);
  });

  test("a device without display support refuses before uploading or showing anything", async () => {
    client.setSupportedCommands([]);
    const { response, payload } = await call({ ...carousel, display: "inner" });
    expect(response.isError).toBe(true);
    expect(payload.error).toContain("overlay_display_id_v1");
    expect(client.getOverlayAssetHistory()).toEqual([]);
    expect(client.getOverlayHistory()).toEqual([]);
    expect(reader.reads).toEqual([]);
    expect((await call({ action: "status" })).payload.overlays).toEqual([]);
  });

  test("an unknown or disconnected display fails before assets are uploaded", async () => {
    adb.setCommandResponse(INVENTORY, { stdout: COVER_ONLY, stderr: "" });
    const { response } = await call({ ...carousel, display: "inner" });
    expect(response.isError).toBe(true);
    expect(client.getOverlayAssetHistory()).toEqual([]);
    expect(client.getOverlayHistory()).toEqual([]);
  });

  test("the missing-asset retry re-sends the same composed spec to the same display", async () => {
    // The panel disappears from the inventory after the first send; the retry must not re-resolve.
    const show = client.requestShowOverlay.bind(client);
    let shows = 0;
    client.requestShowOverlay = async (...args) => {
      shows += 1;
      if (shows === 1) {
        adb.setCommandResponse(INVENTORY, { stdout: COVER_ONLY, stderr: "" });
      }
      return show(...args);
    };
    client.queueOverlayResults({ success: true, missingAssets: ["second"] }, { success: true });
    const { payload } = await call({ ...carousel, display: "inner" });
    expect(payload.success).toBe(true);
    expect(payload.missingAssets).toBeUndefined();
    expect(payload.warning).toBeUndefined();
    // Both uploads, then only the asset the device reported missing is re-uploaded.
    expect(uploadedIds()).toEqual(["first", "second", "second"]);
    expect(client.getOverlayHistory()).toMatchObject([
      { method: "show", spec: composed, displayId: 2 },
      { method: "show", spec: composed, displayId: 2 },
    ]);
    expect(inventoryReads()).toBe(1);
    expect(payload.lastResult?.displayId).toBe(2);
  });

  test("a retry that still reports the asset missing warns and keeps the display", async () => {
    client.setOverlayResult({ success: true, missingAssets: ["first"] });
    const { payload } = await call({ ...carousel, display: "inner" });
    expect(payload.success).toBe(true);
    expect(payload.missingAssets).toEqual(["first"]);
    expect(payload.warning).toBeDefined();
    expect(client.getOverlayHistory()).toMatchObject([{ displayId: 2 }, { displayId: 2 }]);
  });

  test("a missing asset the call did not upload is reported without a re-send", async () => {
    client.setOverlayResult({ success: true, missingAssets: ["elsewhere"] });
    const { payload } = await call({
      action: "showVariants",
      id: "panel",
      variants: [{ image: { asset: "elsewhere" } }],
    });
    expect(payload.success).toBe(true);
    expect(payload.missingAssets).toEqual(["elsewhere"]);
    expect(payload.warning).toBeDefined();
    expect(client.getOverlayHistory()).toHaveLength(1);
    expect(client.getOverlayAssetHistory()).toEqual([]);
  });

  test("an unreadable asset file fails the call with nothing uploaded or shown", async () => {
    const { response, payload } = await call({
      ...carousel,
      assets: [{ id: "first", path: "/img/absent.png" }],
    });
    expect(response.isError).toBe(true);
    expect(payload.success).toBe(false);
    expect(client.getOverlayAssetHistory()).toEqual([]);
    expect(client.getOverlayHistory()).toEqual([]);
  });

  test("an upload failure fails the call before the carousel is shown", async () => {
    client.setOverlayAssetResult({
      success: false,
      error: "store full",
      dispatched: true,
      acknowledged: true,
    });
    const { response, payload } = await call(carousel);
    expect(response.isError).toBe(true);
    expect(payload.success).toBe(false);
    expect(client.getOverlayHistory()).toEqual([]);
  });

  test("waitForSelection with assets and display uploads, shows, then returns the pick", async () => {
    const { payload } = await call(
      { ...carousel, display: "inner", waitForSelection: true },
      async (amount) => {
        if (amount === 0) {
          client.emitOverlayEvent({
            ...event(1, "panel", "emit", "selected"),
            payload: { index: 1 },
            pages: { variants: 1 },
          });
        }
      },
    );
    expect(payload.success).toBe(true);
    expect(payload.selection).toEqual({ index: 1 });
    expect(payload.uploadedAssets).toHaveLength(2);
    expect(payload.lastResult?.displayId).toBe(2);
    expect(uploadedIds()).toEqual(["first", "second"]);
    expect(client.getOverlayHistory()).toHaveLength(1);
  });

  test("a refused display never starts the selection wait", async () => {
    client.setSupportedCommands([]);
    let progress = 0;
    const { payload } = await call(
      { ...carousel, display: "inner", waitForSelection: true },
      async () => {
        progress += 1;
      },
    );
    expect(payload.success).toBe(false);
    expect(payload.selection).toBeUndefined();
    expect(progress).toBe(0);
  });

  describe("rejects what show rejects", () => {
    test.each([
      ["empty assets", { assets: [] }, ">=1 items"],
      ["an entry with neither path nor observation", { assets: [{ id: "a" }] }, "exactly one of"],
      [
        "an entry with both path and observation",
        { assets: [{ id: "a", path: "/img/first.png", observation: "automobile:x" }] },
        "exactly one of",
      ],
      ["an unknown entry field", { assets: [{ id: "a", path: "/p.png", extra: 1 }] }, "extra"],
      ["a non-string display", { display: 3 }, "display"],
      ["a spec", { spec: composed }, "showVariants allows"],
      ["a state patch", { state: { a: 1 } }, "showVariants allows"],
      ["all", { all: true }, "showVariants allows"],
      ["an awaitEvent filter", { eventName: "selected" }, "showVariants allows"],
      ["floating-only fields on a fullscreen carousel", { gravity: "center" }, "floating"],
    ])("%s", async (_name, extra, message) => {
      const { response, payload } = await call({ ...carousel, ...extra });
      expect(response.isError).toBe(true);
      expect(payload.error).toContain(message);
      expect(client.getOverlayAssetHistory()).toEqual([]);
      expect(client.getOverlayHistory()).toEqual([]);
      expect(inventoryReads()).toBe(0);
    });

    test("more assets than the contract maximum", async () => {
      const many = Array.from({ length: 33 }, (_, i) => ({ id: `a${i}`, path: "/img/first.png" }));
      const { response } = await call({ ...carousel, assets: many });
      expect(response.isError).toBe(true);
      expect(client.getOverlayHistory()).toEqual([]);
    });

    test("display and assets stay refused on actions that do not show", async () => {
      for (const action of ["dismiss", "status", "awaitEvent"]) {
        const { response } = await call({ action, id: "panel", display: "inner", assets });
        expect(response.isError).toBe(true);
      }
    });
  });
});
