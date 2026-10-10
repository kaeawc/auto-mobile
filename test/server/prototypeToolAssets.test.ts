import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { registerPrototypeTools, prototypeOutputSchema } from "../../src/server/prototypeTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import type { BootedDevice } from "../../src/models";
import { FakeCtrlProxy } from "../fakes/FakeCtrlProxy";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakePrototypeAssetFileReader } from "../fakes/FakePrototypeAssetFileReader";
import { preserveToolRegistry } from "../helpers/withTemporaryTool";

const device: BootedDevice = { deviceId: "fake-prototype", platform: "android", name: "Fake" };
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(4),
]);
const shotUri = "automobile:observation/fake-prototype/obs-1/screenshot";
const spec = {
  id: "panel",
  window: { placement: { type: "fullscreen" as const } },
  root: { type: "image" as const, asset: "logo" },
};

describe("prototype tool assets", () => {
  let client: FakeCtrlProxy;
  let reader: FakePrototypeAssetFileReader;
  let observationReads: string[];
  let restore: () => void;
  let unsubscribe: () => void;
  beforeEach(() => {
    restore = preserveToolRegistry();
    const timer = new FakeTimer();
    client = new FakeCtrlProxy(timer);
    reader = new FakePrototypeAssetFileReader().addFile("/img/logo.png", png);
    observationReads = [];
    unsubscribe = registerPrototypeTools({
      clientFactory: () => client,
      clock: timer,
      timer,
      assetFileReader: reader,
      observationScreenshotReader: async (uri) => {
        observationReads.push(uri);
        return uri === shotUri ? { bytes: png } : { error: "Observation id gone is superseded." };
      },
    });
  });
  afterEach(() => {
    unsubscribe();
    restore();
  });

  async function call(input: unknown, signal?: AbortSignal) {
    const response = await ToolRegistry.getTool("prototype")!.deviceAwareHandler!(
      device,
      input,
      undefined,
      signal,
    );
    return { response, payload: prototypeOutputSchema.parse(response.structuredContent) };
  }
  const assets = [{ id: "logo", path: "/img/logo.png" }];

  test("show uploads each asset before the prototype and reports what was stored", async () => {
    const order: string[] = [];
    const putAsset = client.requestPutPrototypeAsset.bind(client);
    const show = client.requestShowPrototype.bind(client);
    client.requestPutPrototypeAsset = async (asset, options) => {
      order.push(`put:${asset.id}`);
      return putAsset(asset, options);
    };
    client.requestShowPrototype = async (...args) => {
      order.push("show");
      return show(...args);
    };
    const { response, payload } = await call({ action: "show", spec, assets });
    expect(response.isError).not.toBe(true);
    expect(order).toEqual(["put:logo", "show"]);
    expect(payload.uploadedAssets).toEqual([{ id: "logo", mimeType: "image/png", bytes: 12 }]);
    expect(reader.reads).toEqual(["/img/logo.png"]);
  });

  test("a same-id show uploads assets; the spec on the wire carries only the id", async () => {
    await call({ action: "show", spec });
    const { payload } = await call({ action: "show", spec, assets });
    expect(payload.success).toBe(true);
    expect(client.getPrototypeAssetHistory()).toHaveLength(1);
    expect(client.getPrototypeHistory()).toHaveLength(2);
    expect(JSON.stringify(client.getPrototypeHistory())).not.toContain("/img/logo.png");
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
    expect(client.getPrototypeAssetHistory()).toEqual([]);
    expect(client.getPrototypeHistory()).toEqual([]);
    expect((await call({ action: "status" })).payload.prototypes).toEqual([]);
  });

  test("a failed second upload does not show the prototype and says what was stored", async () => {
    reader.addFile("/img/b.png", png);
    let puts = 0;
    client.requestPutPrototypeAsset = async () => {
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
    expect(client.getPrototypeHistory()).toEqual([]);
    expect((await call({ action: "status" })).payload.prototypes).toEqual([]);
  });

  test("an old device without the capability gets its actionable error and no prototype", async () => {
    const message =
      "put_prototype_asset: this CtrlProxy build does not support prototype assets; update the connected CtrlProxy.";
    client.requestPutPrototypeAsset = async () => {
      throw new Error(message);
    };
    const { response, payload } = await call({ action: "show", spec, assets });
    expect(response.isError).toBe(true);
    expect(payload.error).toContain(message);
    expect(client.getPrototypeHistory()).toEqual([]);
  });

  test("the request abort signal reaches the upload", async () => {
    const controller = new AbortController();
    await call({ action: "show", spec, assets }, controller.signal);
    expect(client.getPrototypeAssetHistory()[0]).toMatchObject({
      options: { abortSignal: controller.signal },
    });
  });

  test("a show without assets neither reads files nor uploads (existing behaviour)", async () => {
    const { payload } = await call({ action: "show", spec });
    expect(payload.success).toBe(true);
    expect(payload.uploadedAssets).toBeUndefined();
    expect(client.getPrototypeAssetHistory()).toEqual([]);
    expect(reader.reads).toEqual([]);
  });

  test("assets are rejected on actions that cannot use them and malformed entries", async () => {
    for (const input of [
      { action: "dismiss", id: "panel", assets },
      { action: "status", assets },
      { action: "show", spec, assets: [] },
      { action: "show", spec, assets: [{ id: "", path: "/x.png" }] },
      { action: "show", spec, assets: [{ id: "a", path: "/x.png", extra: 1 }] },
    ]) {
      const { response, payload } = await call(input);
      expect(response.isError).toBe(true);
      expect(payload.error).toContain("Invalid prototype input");
    }
    expect(client.getPrototypeAssetHistory()).toEqual([]);
  });
  describe("missing assets", () => {
    test("a result with no missingAssets adds neither field", async () => {
      const { payload } = await call({ action: "show", spec, assets });
      expect(payload.missingAssets).toBeUndefined();
      expect(payload.warning).toBeUndefined();
    });

    test("an id the call did not supply is surfaced with a warning and success stays true", async () => {
      client.setPrototypeResult({ success: true, missingAssets: ["avatar", "banner"] });
      const { response, payload } = await call({ action: "show", spec });
      expect(response.isError).not.toBe(true);
      expect(payload.success).toBe(true);
      expect(payload.missingAssets).toEqual(["avatar", "banner"]);
      expect(payload.warning).toContain("'avatar', 'banner'");
      expect(payload.warning).toContain("Upload them with assets");
      expect(client.getPrototypeAssetHistory()).toEqual([]);
      expect(client.getPrototypeHistory()).toHaveLength(1);
    });

    test("a same-id show surfaces missing assets too", async () => {
      await call({ action: "show", spec });
      client.setPrototypeResult({ success: true, missingAssets: ["avatar"] });
      const { payload } = await call({ action: "show", spec });
      expect(payload.missingAssets).toEqual(["avatar"]);
      expect(payload.warning).toContain("'avatar'");
    });

    test("a supplied asset reported missing is re-uploaded and the prototype re-sent once", async () => {
      client.queuePrototypeResults({ success: true, missingAssets: ["logo"] }, { success: true });
      const { response, payload } = await call({ action: "show", spec, assets });
      expect(response.isError).not.toBe(true);
      expect(payload.success).toBe(true);
      expect(payload.missingAssets).toBeUndefined();
      expect(payload.warning).toBeUndefined();
      expect(client.getPrototypeAssetHistory().map((entry) => entry.method)).toEqual([
        "put",
        "put",
      ]);
      expect(client.getPrototypeHistory().map((entry) => entry.method)).toEqual(["show", "show"]);
      expect(reader.reads).toEqual(["/img/logo.png"]);
    });

    test("only the supplied-and-missing assets are re-uploaded", async () => {
      reader.addFile("/img/b.png", png);
      client.queuePrototypeResults(
        { success: true, missingAssets: ["b", "other"] },
        { success: true, missingAssets: ["other"] },
      );
      const { payload } = await call({
        action: "show",
        spec,
        assets: [...assets, { id: "b", path: "/img/b.png" }],
      });
      const puts = client
        .getPrototypeAssetHistory()
        .map((entry) => ("asset" in entry ? entry.asset.id : ""));
      expect(puts).toEqual(["logo", "b", "b"]);
      expect(payload.success).toBe(true);
      expect(payload.missingAssets).toEqual(["other"]);
      expect(payload.warning).toContain("'other'");
      expect(payload.warning).not.toContain("'b'");
    });

    test("still missing after the single retry returns success with a warning and does not loop", async () => {
      client.setPrototypeResult({ success: true, missingAssets: ["logo"] });
      const { response, payload } = await call({ action: "show", spec, assets });
      expect(response.isError).not.toBe(true);
      expect(payload.success).toBe(true);
      expect(payload.missingAssets).toEqual(["logo"]);
      expect(payload.warning).toContain("re-uploaded and the prototype re-sent once");
      expect(client.getPrototypeAssetHistory()).toHaveLength(2);
      expect(client.getPrototypeHistory()).toHaveLength(2);
    });

    test("a failed re-upload keeps the first result and says why", async () => {
      client.setPrototypeResult({ success: true, missingAssets: ["logo"] });
      const putAsset = client.requestPutPrototypeAsset.bind(client);
      let puts = 0;
      client.requestPutPrototypeAsset = async (asset, options) => {
        puts += 1;
        return puts === 1
          ? putAsset(asset, options)
          : { success: false, error: "store full", dispatched: true, acknowledged: true };
      };
      const { response, payload } = await call({ action: "show", spec, assets });
      expect(response.isError).not.toBe(true);
      expect(payload.success).toBe(true);
      expect(payload.warning).toContain("did not complete");
      expect(payload.warning).toContain("store full");
      expect(client.getPrototypeHistory()).toHaveLength(1);
    });

    test("a failed re-send keeps the first result as a warning", async () => {
      client.queuePrototypeResults(
        { success: true, missingAssets: ["logo"] },
        { success: false, error: "device busy" },
      );
      const { payload } = await call({ action: "show", spec, assets });
      expect(payload.success).toBe(true);
      expect(payload.missingAssets).toEqual(["logo"]);
      expect(payload.warning).toContain("device busy");
    });

    test("an abort before the retry skips it", async () => {
      const controller = new AbortController();
      client.setPrototypeResult({ success: true, missingAssets: ["logo"] });
      const show = client.requestShowPrototype.bind(client);
      client.requestShowPrototype = async (...args) => {
        const result = await show(...args);
        controller.abort();
        return result;
      };
      const { payload } = await call({ action: "show", spec, assets }, controller.signal);
      expect(payload.success).toBe(true);
      expect(payload.warning).toContain("cancelled");
      expect(client.getPrototypeAssetHistory()).toHaveLength(1);
      expect(client.getPrototypeHistory()).toHaveLength(1);
    });

    test("a failed show is never retried", async () => {
      client.setPrototypeResult({ success: false, error: "no", missingAssets: ["logo"] });
      const { response, payload } = await call({ action: "show", spec, assets });
      expect(response.isError).toBe(true);
      expect(payload.missingAssets).toBeUndefined();
      expect(client.getPrototypeHistory()).toHaveLength(1);
    });
  });

  describe("observation screenshot sources", () => {
    test("an observation asset is read through the resolver and uploaded like a file", async () => {
      const { response, payload } = await call({
        action: "show",
        spec,
        assets: [{ id: "logo", observation: shotUri }],
      });
      expect(response.isError).not.toBe(true);
      expect(observationReads).toEqual([shotUri]);
      expect(reader.reads).toEqual([]);
      expect(payload.uploadedAssets).toEqual([{ id: "logo", mimeType: "image/png", bytes: 12 }]);
      expect(client.getPrototypeAssetHistory()).toHaveLength(1);
    });

    test("a superseded observation fails the call before anything is sent", async () => {
      const { response, payload } = await call({
        action: "show",
        spec,
        assets: [
          { id: "logo", observation: "automobile:observation/fake-prototype/gone/screenshot" },
        ],
      });
      expect(response.isError).toBe(true);
      expect(payload.error).toContain("superseded");
      expect(payload.error).toContain("No assets were uploaded");
      expect(client.getPrototypeAssetHistory()).toEqual([]);
      expect(client.getPrototypeHistory()).toEqual([]);
    });

    test("a re-upload of a missing observation asset reuses the bytes already read", async () => {
      client.queuePrototypeResults({ success: true, missingAssets: ["logo"] }, { success: true });
      await call({ action: "show", spec, assets: [{ id: "logo", observation: shotUri }] });
      expect(observationReads).toEqual([shotUri]);
      expect(client.getPrototypeAssetHistory()).toHaveLength(2);
    });

    test("each asset needs exactly one of path or observation", async () => {
      for (const entry of [
        { id: "logo" },
        { id: "logo", path: "/img/logo.png", observation: shotUri },
      ]) {
        const { response, payload } = await call({ action: "show", spec, assets: [entry] });
        expect(response.isError).toBe(true);
        expect(payload.error).toContain("exactly one of path or observation");
      }
      expect(observationReads).toEqual([]);
      expect(client.getPrototypeAssetHistory()).toEqual([]);
    });
  });
});
