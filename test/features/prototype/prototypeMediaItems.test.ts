import { describe, expect, test } from "bun:test";
import { PROTOTYPE_MEDIA_ITEMS_CAPABILITY } from "../../../src/features/observe/android/ctrlProxyProtocol";
import { prototypeAssetIdProblem } from "../../../src/features/prototype/prototypeAssets";
import { collectPrototypeAssetReferences } from "../../../src/features/prototype/prototypeAssetReferences";
import { prototypeRequiredCapabilities } from "../../../src/features/prototype/prototypeCapabilityGates";
import {
  isPrototypeMediaId,
  prototypeMediaItemFields,
  prototypeMediaItemsUnsupportedMessage,
} from "../../../src/features/prototype/prototypeMediaItems";
import { imageSlotUses } from "../../../src/features/prototype/prototypeRepeat";
import { prototypeThemeModeFields } from "../../../src/features/prototype/prototypeThemeModes";
import { validatePrototypeSpec } from "../../../src/features/prototype/prototypeValidation";

const spec = (root: unknown, extra: Record<string, unknown> = {}) => ({
  id: "m",
  window: { placement: { type: "fullscreen" } },
  data: { photo: "media:5b1f", picked: [{ id: 1, thumbnail: "media:5b1f/thumb" }] },
  root,
  ...extra,
});
const image = (asset: unknown) => ({ type: "image", asset, contentDescription: "Photo" });

describe("device media items (#14192)", () => {
  test("a data-bound image validates and needs the media items capability", () => {
    const bound = spec(image({ data: "/photo" }));
    expect(validatePrototypeSpec(bound).success).toBe(true);
    expect(prototypeMediaItemFields(bound)).toEqual(["root.asset.data"]);
    expect(prototypeRequiredCapabilities(bound).map((gate) => gate.capability)).toContain(
      PROTOTYPE_MEDIA_ITEMS_CAPABILITY,
    );
    const plain = spec(image("uploaded"));
    expect(prototypeMediaItemFields(plain)).toEqual([]);
    expect(prototypeRequiredCapabilities(plain).map((gate) => gate.capability)).not.toContain(
      PROTOTYPE_MEDIA_ITEMS_CAPABILITY,
    );
  });

  test("the gate reports tab item bindings too", () => {
    const tabs = spec(
      {
        type: "tabBar",
        stateKey: "tab",
        items: [
          { label: "A", image: { data: "/photo" } },
          { label: "B", image: "x" },
        ],
      },
      { state: { tab: 0 } },
    );
    expect(prototypeMediaItemFields(tabs)).toEqual(["root.items[0].image.data"]);
  });

  test("only a pointer string in a strict one-key object is accepted", () => {
    for (const asset of [
      { data: "photo" },
      { data: 1 },
      {},
      { data: "/photo", light: "a", dark: "b" },
    ]) {
      expect(validatePrototypeSpec(spec(image(asset))).success).toBe(false);
    }
  });

  test("a data binding is not a per-mode pair and costs no image budget", () => {
    expect(prototypeThemeModeFields(spec(image({ data: "/photo" })))).toEqual([]);
    expect(prototypeThemeModeFields(spec(image({ light: "a", dark: "b" })))).toEqual([
      "root.asset",
    ]);
    expect(imageSlotUses({ data: "/photo" })).toBe(0);
    expect(imageSlotUses("a")).toBe(1);
  });

  test("a media: id is never a host asset reference, and host assets cannot use the prefix", () => {
    const references = collectPrototypeAssetReferences(
      spec({
        type: "column",
        children: [image("uploaded"), image("media:5b1f"), image({ data: "/photo" })],
      }),
    );
    expect([...references.images]).toEqual(["uploaded"]);
    expect(isPrototypeMediaId("media:5b1f")).toBe(true);
    expect(isPrototypeMediaId("uploaded")).toBe(false);
    expect(prototypeAssetIdProblem("media:5b1f")).toContain("media:");
    expect(prototypeAssetIdProblem("uploaded")).toBeNull();
  });

  test("a repeat placeholder is a template, not an asset reference, and a data binding needs the data model", () => {
    const references = collectPrototypeAssetReferences(spec(image("{item.thumbnail}")));
    expect([...references.images]).toEqual([]);
    const noRoot = {
      id: "m",
      window: { placement: { type: "fullscreen" } },
      root: image({ data: "/photo" }),
    };
    expect(prototypeRequiredCapabilities(noRoot).map((gate) => gate.capability)).toContain(
      "prototype_data_model_v1",
    );
  });

  test("a repeat placeholder in a string asset binds the row's media id", () => {
    const result = validatePrototypeSpec(
      spec({
        type: "grid",
        columns: 2,
        repeat: { items: { path: "/picked" }, as: "item", key: "id" },
        children: [image("{item.thumbnail}")],
      }),
    );
    expect(result.success).toBe(true);
  });

  test("the refusal names the field and how to recover on each platform", () => {
    expect(prototypeMediaItemsUnsupportedMessage(["root.asset.data"], "android")).toContain(
      "Update the connected CtrlProxy",
    );
    expect(prototypeMediaItemsUnsupportedMessage(["root.asset.data"], "ios")).toContain(
      "launchApp prototype: true",
    );
  });
});
