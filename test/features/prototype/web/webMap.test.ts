import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fitFraming, mapPercent, mercator } from "../../../../src/features/prototype/web/webMap";
import {
  toHtml,
  type WebChild,
  type WebElement,
} from "../../../../src/features/prototype/web/webNodes";
import { renderPrototypeStill } from "../../../../src/features/prototype/web/webStill";

const reference = JSON.parse(
  readFileSync(
    join(import.meta.dir, "../../../fixtures/prototype-web/reference-checkout.json"),
    "utf8",
  ),
) as Record<string, unknown>;

function find(node: WebChild, predicate: (element: WebElement) => boolean): WebElement[] {
  if (typeof node === "string") {
    return [];
  }
  return [
    ...(predicate(node) ? [node] : []),
    ...node.children.flatMap((child) => find(child, predicate)),
  ];
}

const places = [
  { id: "a", lat: 37.77, lng: -122.42, name: "Ferry" },
  { id: "b", lat: 37.8, lng: -122.4, name: "Pier" },
];

function still(map: Record<string, unknown>) {
  const rendered = renderPrototypeStill({
    ...reference,
    data: { places, route: places.map(({ lat, lng }) => ({ lat, lng })) },
    root: { type: "map", ...map },
  });
  const part = (name: string) =>
    find(rendered.element, (element) => element.attrs["data-part"] === name);
  return { ...rendered, part, html: toHtml(rendered.element) };
}

const markers = {
  path: "/places",
  as: "place",
  id: "{place.id}",
  lat: "{place.lat}",
  lng: "{place.lng}",
  title: "{place.name}",
};

describe("prototype web map (#16539)", () => {
  test("projects with Web Mercator", () => {
    expect(mercator(0, 0)).toEqual({ x: 0.5, y: 0.5 });
    expect(mercator(0, 180).x).toBe(1);
    expect(mercator(90, 0).y).toBeCloseTo(0, 6);
  });

  test("fitting frames the points inside the box, and one point at street zoom", () => {
    const points = [mercator(0, -1), mercator(0, 1)];
    const size = { width: 400, height: 200 };
    const view = fitFraming(points, size)!;
    expect(mapPercent(points[0]!, view, size).left).toBeCloseTo(10, 3);
    expect(mapPercent(points[1]!, view, size).left).toBeCloseTo(90, 3);
    expect(fitFraming([points[0]!], size)!.worldSize).toBe(256 * 2 ** 15);
    expect(fitFraming([], size)).toBeUndefined();
  });

  test("draws marker pins and route lines with no tiles or placeholder", () => {
    const map = still({ markers, polylines: [{ path: "/route", width: 6 }], fit: "markers" });
    expect(map.unsupportedNodes).toEqual([]);
    const pins = map.part("marker");
    expect(pins.map((pin) => pin.attrs["aria-label"])).toEqual(["Ferry", "Pier"]);
    expect(pins.map((pin) => [pin.style.left, pin.style.top])).toEqual([
      ["39.744%", "90%"],
      ["60.256%", "10%"],
    ]);
    expect(map.html).toContain('<polyline fill="none" points="39.744,90 60.256,10"');
    expect(map.html).toContain('viewBox="0 0 100 100"');
    expect(map.html).not.toMatch(/\b(src|href)=|url\(/);
  });

  test("a literal camera centres its point; a data camera reads /data", () => {
    const literal = still({ markers, camera: { lat: 37.77, lng: -122.42, zoom: 12 } });
    expect(literal.part("marker")[0]!.style).toMatchObject({ left: "50%", top: "50%" });
    const fromData = renderPrototypeStill({
      ...reference,
      data: { places, cam: { lat: 37.8, lng: -122.4, zoom: 12 } },
      root: { type: "map", markers, camera: { data: "/cam" } },
    });
    const pins = find(fromData.element, (element) => element.attrs["data-part"] === "marker");
    expect(pins[1]!.style).toMatchObject({ left: "50%", top: "50%" });
  });

  test("projects against the map's own dp size", () => {
    const map = still({
      markers,
      fit: "markers",
      style: { width: { dp: 200 }, height: { dp: 400 } },
    });
    // The taller box fits the points by width, so they no longer reach the vertical margins.
    const pins = map.part("marker");
    expect(pins.map((pin) => pin.style.left)).toEqual(["10%", "90%"]);
    expect(map.html).toContain("height:400px");
  });

  test("an empty map draws the neutral canvas", () => {
    const map = still({ mapStyle: "plain" });
    expect(map.unsupportedNodes).toEqual([]);
    expect(map.html).toContain("background:#e8eaed");
  });
});
