import { expect, test } from "bun:test";
import { collectPrototypeAssetReferences } from "../../../src/features/prototype/prototypeAssetReferences";
import { prototypeMapMarkerAsset } from "../../../src/features/prototype/prototypeMap";
import { validatePrototypeSpec } from "../../../src/features/prototype/prototypeValidation";

function spec(icon: unknown) {
  return {
    id: "map-marker-asset",
    window: { placement: { type: "fullscreen" } },
    data: { stops: [{ id: "a", lat: 0, lng: 0 }] },
    requires: { platform: ["map"] },
    root: {
      type: "map",
      markers: {
        path: "/stops",
        as: "s",
        id: "{s.id}",
        lat: "{s.lat}",
        lng: "{s.lng}",
        title: "Stop",
        icon,
      },
    },
  };
}

test("a marker icon asset is an image the bundle carries (#16491)", () => {
  expect([...collectPrototypeAssetReferences(spec({ asset: "car-pin" })).images]).toEqual([
    "car-pin",
  ]);
  expect([...collectPrototypeAssetReferences(spec("directions_car")).images]).toEqual([]);
});

test("a per-marker template is not an asset reference", () => {
  expect(prototypeMapMarkerAsset(spec({ asset: "{s.pin}" }).root)).toBeUndefined();
  expect(prototypeMapMarkerAsset(spec("directions_car").root)).toBeUndefined();
});

test("a known marker asset passes a complete asset inventory", () => {
  const result = validatePrototypeSpec(spec({ asset: "car-pin" }), {
    shareAssetIds: ["car-pin"],
  });
  expect(result.success).toBe(true);
});

test("a bare URL is still refused as a marker icon", () => {
  const result = validatePrototypeSpec(spec("https://example.com/car.png"));
  expect(result.success).toBe(false);
});
