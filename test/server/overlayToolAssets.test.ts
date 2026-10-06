import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { registerOverlayTools, overlayOutputSchema } from "../../src/server/overlayTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import type { BootedDevice } from "../../src/models";
import { FakeCtrlProxy } from "../fakes/FakeCtrlProxy";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeOverlayAssetFileReader } from "../fakes/FakeOverlayAssetFileReader";
import { preserveToolRegistry } from "../helpers/withTemporaryTool";

const device: BootedDevice = { deviceId: "fake-overlay", platform: "android", name: "Fake" };
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(4),
]);
const spec = {
  id: "panel",
  window: { placement: { type: "fullscreen" as const } },
  root: { type: "image" as const, asset: "logo" },
};

describe("overlay tool assets", () => {
  let client: FakeCtrlProxy;
  let reader: FakeOverlayAssetFileReader;
  let restore: () => void;
  let unsubscribe: () => void;
  beforeEach(() => {
    restore = preserveToolRegistry();
    const timer = new FakeTimer();
    client = new FakeCtrlProxy(timer);
    reader = new FakeOverlayAssetFileReader().addFile("/img/logo.png", png);
    unsubscribe = registerOverlayTools({
      clientFactory: () => client,
      clock: timer,
      timer,
      assetFileReader: reader,
    });
  });
  afterEach(() => {
    unsubscribe();
    restore();
  });

  async function call(input: unknown, signal?: AbortSignal) {
    const response = await ToolRegistry.getTool("overlay")!.deviceAwareHandler!(
      device,
      input,
      undefined,
      signal,
    );
    return { response, payload: overlayOutputSchema.parse(response.structuredContent) };
  }
  const assets = [{ id: "logo", path: "/img/logo.png" }];

  test("show uploads each asset before the overlay and reports what was stored", async () => {
    const order: string[] = [];
    const putAsset = client.requestPutOverlayAsset.bind(client);
    const show = client.requestShowOverlay.bind(client);
    client.requestPutOverlayAsset = async (asset, options) => {
      order.push(`put:${asset.id}`);
      return putAsset(asset, options);
    };
    client.requestShowOverlay = async (...args) => {
      order.push("show");
      return show(...args);
    };
    const { response, payload } = await call({ action: "show", spec, assets });
    expect(response.isError).not.toBe(true);
    expect(order).toEqual(["put:logo", "show"]);
    expect(payload.uploadedAssets).toEqual([{ id: "logo", mimeType: "image/png", bytes: 12 }]);
    expect(reader.reads).toEqual(["/img/logo.png"]);
  });

  test("update with a spec uploads assets; the spec on the wire carries only the id", async () => {
    await call({ action: "show", spec });
    const { payload } = await call({ action: "update", id: "panel", spec, assets });
    expect(payload.success).toBe(true);
    expect(client.getOverlayAssetHistory()).toHaveLength(1);
    const updates = client.getOverlayHistory().filter((entry) => entry.method === "update");
    expect(JSON.stringify(updates)).not.toContain("/img/logo.png");
  });

  test("an unreadable asset fails the call before anything is sent or shown", async () => {
    const { response, payload } = await call({
      action: "show",
      spec,
      assets: [{ id: "logo", path: "/img/missing.png" }],
    });
    expect(response.isError).toBe(true);
    expect(payload.error).toContain("cannot read file");
    expect(payload.error).toContain("No assets were uploaded");
    expect(client.getOverlayAssetHistory()).toEqual([]);
    expect(client.getOverlayHistory()).toEqual([]);
    expect((await call({ action: "status" })).payload.overlays).toEqual([]);
  });

  test("a failed second upload does not show the overlay and says what was stored", async () => {
    reader.addFile("/img/b.png", png);
    let puts = 0;
    client.requestPutOverlayAsset = async () => {
      puts += 1;
      return puts === 1
        ? { success: true, dispatched: true, acknowledged: true }
        : { success: false, error: "store full", dispatched: true, acknowledged: true };
    };
    const { response, payload } = await call({
      action: "show",
      spec,
      assets: [...assets, { id: "b", path: "/img/b.png" }],
    });
    expect(response.isError).toBe(true);
    expect(payload.error).toContain("Already uploaded: logo");
    expect(payload.uploadedAssets?.map((asset) => asset.id)).toEqual(["logo"]);
    expect(payload.lastResult).toMatchObject({ lastAction: "show", success: false });
    expect(client.getOverlayHistory()).toEqual([]);
    expect((await call({ action: "status" })).payload.overlays).toEqual([]);
  });

  test("an old device without the capability gets its actionable error and no overlay", async () => {
    const message =
      "put_overlay_asset: this CtrlProxy build does not support overlay assets; update the connected CtrlProxy.";
    client.requestPutOverlayAsset = async () => {
      throw new Error(message);
    };
    const { response, payload } = await call({ action: "show", spec, assets });
    expect(response.isError).toBe(true);
    expect(payload.error).toContain(message);
    expect(client.getOverlayHistory()).toEqual([]);
  });

  test("the request abort signal reaches the upload", async () => {
    const controller = new AbortController();
    await call({ action: "show", spec, assets }, controller.signal);
    expect(client.getOverlayAssetHistory()[0]).toMatchObject({
      options: { abortSignal: controller.signal },
    });
  });

  test("a show without assets neither reads files nor uploads (existing behaviour)", async () => {
    const { payload } = await call({ action: "show", spec });
    expect(payload.success).toBe(true);
    expect(payload.uploadedAssets).toBeUndefined();
    expect(client.getOverlayAssetHistory()).toEqual([]);
    expect(reader.reads).toEqual([]);
  });

  test("assets are rejected on actions that cannot use them and malformed entries", async () => {
    for (const input of [
      { action: "update", id: "panel", state: {}, assets },
      { action: "dismiss", id: "panel", assets },
      { action: "status", assets },
      { action: "show", spec, assets: [] },
      { action: "show", spec, assets: [{ id: "", path: "/x.png" }] },
      { action: "show", spec, assets: [{ id: "a", path: "/x.png", extra: 1 }] },
    ]) {
      const { response, payload } = await call(input);
      expect(response.isError).toBe(true);
      expect(payload.error).toContain("Invalid overlay input");
    }
    expect(client.getOverlayAssetHistory()).toEqual([]);
  });
});
