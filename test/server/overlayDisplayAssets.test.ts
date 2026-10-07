import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { overlayOutputSchema, registerOverlayTools } from "../../src/server/overlayTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import type { BootedDevice } from "../../src/models";
import { FakeAdbClientFactory } from "../fakes/FakeAdbClientFactory";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeCtrlProxy } from "../fakes/FakeCtrlProxy";
import { FakeOverlayAssetFileReader } from "../fakes/FakeOverlayAssetFileReader";
import { FakeTimer } from "../fakes/FakeTimer";
import { preserveToolRegistry } from "../helpers/withTemporaryTool";

/**
 * Cross-feature behaviour of the `display` input (#9308) together with the `assets` input and the
 * missing-asset retry (#9301): neither lane could see the other's code path.
 */
const BOTH_PANELS =
  'Display id 0: DisplayInfo{uniqueId "local:cover-key" type INTERNAL, real 100 x 100}\n' +
  'Display id 2: DisplayInfo{uniqueId "local:inner-key" type INTERNAL, real 200 x 200}';
const COVER_ONLY =
  'Display id 0: DisplayInfo{uniqueId "local:cover-key" type INTERNAL, real 100 x 100}';
const INVENTORY = "cmd display get-displays";
const device: BootedDevice = {
  deviceId: "fold-overlay-assets",
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
const spec = {
  id: "panel",
  window: { placement: { type: "fullscreen" as const } },
  root: { type: "image" as const, asset: "logo" },
};
const assets = [{ id: "logo", path: "/img/logo.png" }];

describe("overlay display together with assets", () => {
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
    reader = new FakeOverlayAssetFileReader().addFile("/img/logo.png", png);
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

  async function call(input: Record<string, unknown>) {
    const response = await ToolRegistry.getTool("prototype")!.deviceAwareHandler!(device, input);
    return { response, payload: overlayOutputSchema.parse(response.structuredContent) };
  }
  const inventoryReads = () =>
    adb.getExecutedCommands().filter((command) => command.includes("get-displays")).length;

  test("show with display and assets uploads first, then shows on the resolved display", async () => {
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
    const { response, payload } = await call({ action: "show", spec, assets, display: "inner" });
    expect(response.isError).not.toBe(true);
    expect(order).toEqual(["put:logo", "show:2"]);
    expect(payload.uploadedAssets).toEqual([{ id: "logo", mimeType: "image/png", bytes: 12 }]);
    expect(payload.lastResult?.displayId).toBe(2);
    expect(inventoryReads()).toBe(1);
  });

  test("a refused display uploads nothing and reads no asset file", async () => {
    client.setSupportedCommands([]);
    const { response, payload } = await call({ action: "show", spec, assets, display: "inner" });
    expect(response.isError).toBe(true);
    expect(payload.error).toContain("overlay_display_id_v1");
    expect(client.getOverlayAssetHistory()).toEqual([]);
    expect(client.getOverlayHistory()).toEqual([]);
    expect(payload.uploadedAssets).toBeUndefined();
    expect((await call({ action: "status" })).payload.overlays).toEqual([]);
  });

  test("an unknown display fails before assets are uploaded", async () => {
    adb.setCommandResponse(INVENTORY, { stdout: COVER_ONLY, stderr: "" });
    const { response } = await call({ action: "show", spec, assets, display: "inner" });
    expect(response.isError).toBe(true);
    expect(client.getOverlayAssetHistory()).toEqual([]);
    expect(client.getOverlayHistory()).toEqual([]);
  });

  test("the missing-asset retry re-sends to the same display without re-resolving it", async () => {
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
    client.queueOverlayResults({ success: true, missingAssets: ["logo"] }, { success: true });
    const { payload } = await call({ action: "show", spec, assets, display: "inner" });
    expect(payload.success).toBe(true);
    expect(payload.missingAssets).toBeUndefined();
    expect(payload.warning).toBeUndefined();
    expect(client.getOverlayAssetHistory().map((entry) => entry.method)).toEqual(["put", "put"]);
    expect(client.getOverlayHistory()).toMatchObject([
      { method: "show", displayId: 2 },
      { method: "show", displayId: 2 },
    ]);
    expect(inventoryReads()).toBe(1);
    expect(payload.lastResult?.displayId).toBe(2);
  });

  test("a retry that still reports the asset missing keeps the display on the result", async () => {
    client.setOverlayResult({ success: true, missingAssets: ["logo"] });
    const { payload } = await call({ action: "show", spec, assets, display: "inner" });
    expect(payload.success).toBe(true);
    expect(payload.missingAssets).toEqual(["logo"]);
    expect(payload.warning).toBeDefined();
    expect(client.getOverlayHistory()).toMatchObject([{ displayId: 2 }, { displayId: 2 }]);
    expect(payload.lastResult?.displayId).toBe(2);
  });

  test("on the default display the retry still sends no displayId", async () => {
    client.queueOverlayResults({ success: true, missingAssets: ["logo"] }, { success: true });
    const { payload } = await call({ action: "show", spec, assets, display: "cover" });
    expect(payload.success).toBe(true);
    const shows = client.getOverlayHistory();
    expect(shows).toHaveLength(2);
    expect(shows.map((entry) => Object.hasOwn(entry, "displayId"))).toEqual([false, false]);
    expect(payload.lastResult && Object.hasOwn(payload.lastResult, "displayId")).toBe(false);
  });

  test("update with a spec and assets stays on the display the overlay was shown on", async () => {
    await call({ action: "show", spec, assets, display: "inner" });
    const { payload } = await call({ action: "update", id: "panel", spec, assets });
    expect(payload.success).toBe(true);
    expect(payload.lastResult?.displayId).toBe(2);
    const update = client.getOverlayHistory().find((entry) => entry.method === "update");
    expect(update).toBeDefined();
    expect(Object.hasOwn(update ?? {}, "displayId")).toBe(false);
    expect(inventoryReads()).toBe(1);
  });

  test("display is still refused on update even with assets", async () => {
    await call({ action: "show", spec, display: "inner" });
    const { response } = await call({
      action: "update",
      id: "panel",
      spec,
      assets,
      display: "inner",
    });
    expect(response.isError).toBe(true);
  });
});
