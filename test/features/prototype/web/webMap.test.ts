import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  fitFraming,
  mapPercent,
  mercator,
  routePercents,
  wrapOffset,
} from "../../../../src/features/prototype/web/webMap";
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

describe("prototype web map across the 180° line (#16593)", () => {
  const size = { width: 400, height: 200 };

  test("wraps a horizontal offset to the nearest copy of the world", () => {
    expect(wrapOffset(0.25)).toBe(0.25);
    expect(wrapOffset(0.75)).toBe(-0.25);
    expect(wrapOffset(-0.75)).toBe(0.25);
    expect(wrapOffset(0.5)).toBe(-0.5);
  });

  test("a camera near 180° places a marker just over the line beside it", () => {
    const view = { center: mercator(0, 179), worldSize: 256 * 2 ** 1 };
    expect(mapPercent(mercator(0, -179), view, size)).toEqual({ left: 50.711, top: 50 });
    expect(mapPercent(mercator(0, 178), view, size).left).toBe(49.644);
  });

  test("fitting markers on both sides of 180° frames them around it", () => {
    const points = [mercator(0, 179), mercator(0, -179)];
    const view = fitFraming(points, size)!;
    expect(view.center.x).toBeCloseTo(0, 9);
    expect(mapPercent(points[0]!, view, size).left).toBeCloseTo(10, 3);
    expect(mapPercent(points[1]!, view, size).left).toBeCloseTo(90, 3);
    // Three points spread round the world still take the smallest arc covering them.
    const spread = fitFraming([mercator(0, 170), mercator(0, -170), mercator(0, 10)], size)!;
    expect(spread.center.x).toBeCloseTo(mercator(0, 100).x, 9);
  });

  test("a route crossing 180° is drawn the short way round", () => {
    const route = [mercator(0, 178), mercator(0, -178), mercator(0, -176)];
    const view = fitFraming(route, size)!;
    const lefts = routePercents(route, view, size).map((point) => point.left);
    expect(lefts[0]).toBeCloseTo(10, 3);
    expect(lefts[1]).toBeCloseTo(63.333, 3);
    expect(lefts[2]).toBeCloseTo(90, 3);
    // Framed elsewhere, the crossing segment still spans 4°, not the whole world.
    const away = { center: mercator(0, 0), worldSize: 256 };
    const [from, to] = routePercents(route.slice(0, 2), away, size);
    expect(to!.left - from!.left).toBeCloseTo(((4 / 360) * 256 * 100) / 400, 2);
  });

  test("fitting a route frames the span it is drawn across, not just its vertices", () => {
    // Each hop is under half the world, so the line is drawn 340° wide through Greenwich.
    const route = [mercator(0, -170), mercator(0, 0), mercator(0, 170)];
    const view = fitFraming([], size, [route])!;
    const lefts = routePercents(route, view, size).map((point) => point.left);
    expect(lefts[0]).toBeCloseTo(10, 2);
    expect(lefts[1]).toBeCloseTo(50, 2);
    expect(lefts[2]).toBeCloseTo(90, 2);
    // A line wrapping the whole world is fitted one world wide.
    const round = [0, 120, -120, 0].map((lng) => mercator(0, lng));
    const roundView = fitFraming([], size, [round])!;
    expect(roundView.worldSize).toBeCloseTo(400 * 0.8, 9);
    const roundLefts = routePercents(round, roundView, size).map((point) => point.left);
    expect(roundLefts[0]).toBeCloseTo(10, 2);
    expect(roundLefts[3]).toBeCloseTo(90, 2);
    expect(fitFraming([], size, [[]])).toBeUndefined();
  });

  test("fitting routes that only together wrap the world keeps every vertex in view (#16658)", () => {
    const lines = [
      [-170, 0, 170].map((lng) => mercator(0, lng)),
      [0, 170, -20].map((lng) => mercator(0, lng)),
    ];
    const view = fitFraming([], size, lines)!;
    const placed = lines.map((line) => routePercents(line, view, size).map((point) => point.left));
    // Drawn 340° wide each and offset by 170°, the lines span 510°: framed edge to edge.
    expect(placed[0]![0]).toBeCloseTo(10, 2);
    expect(placed[1]![2]).toBeCloseTo(90, 2);
    expect(placed.flat().every((left) => left >= 0 && left <= 100)).toBe(true);
    expect(view.worldSize).toBeCloseTo((400 * 0.8) / (510 / 360), 6);
    // Markers framed with them sit on the copy the fit placed them on.
    const marked = fitFraming([mercator(0, 90)], size, lines)!;
    const lefts = [
      mapPercent(mercator(0, 90), marked, size).left,
      ...lines.flatMap((line) => routePercents(line, marked, size).map((point) => point.left)),
    ];
    expect(lefts.every((left) => left >= 0 && left <= 100)).toBe(true);
  });

  test("fits and draws long routes in one pass per line (#16666)", () => {
    // Eight 2,000-point lines, each walking 340° east through Greenwich in sub-degree hops.
    const lines = Array.from({ length: 8 }, (_, line) =>
      Array.from({ length: 2_000 }, (_, index) => mercator(line, -170 + (index * 340) / 1_999)),
    );
    const view = fitFraming([], size, lines)!;
    expect(view.worldSize).toBeCloseTo((400 * 0.8) / (340 / 360), 6);
    const placed = lines.map((line) => routePercents(line, view, size).map((point) => point.left));
    expect(placed.every((lefts) => lefts.length === 2_000)).toBe(true);
    expect(placed[0]![0]).toBeCloseTo(10, 2);
    expect(placed[0]![1_999]).toBeCloseTo(90, 2);
    expect(placed.flat().every((left) => left >= 0 && left <= 100)).toBe(true);
  });

  test("a single fitted marker keeps the single-point zoom wherever it sits", () => {
    // Wrapping a lone longitude through whole-world shifts must not leave a sliver of width.
    for (const lng of [-122.42, -74, 0, 179.9]) {
      expect(fitFraming([mercator(0, lng)], size)!.worldSize).toBe(256 * 2 ** 15);
    }
    const view = fitFraming([mercator(0, -122.42)], size)!;
    const [, end] = routePercents([mercator(0, -122.42), mercator(0, -122.419)], view, size);
    expect(end!.left).toBeCloseTo(55.825, 2);
  });

  test("the rendered still pins and routes across 180°", () => {
    const pacific = [
      { id: "w", lat: 0, lng: 179, name: "West" },
      { id: "e", lat: 0, lng: -179, name: "East" },
    ];
    const rendered = renderPrototypeStill({
      ...reference,
      data: { places: pacific, route: pacific.map(({ lat, lng }) => ({ lat, lng })) },
      root: {
        type: "map",
        markers,
        polylines: [{ path: "/route" }],
        fit: "markers",
        style: { width: { dp: 400 }, height: { dp: 200 } },
      },
    });
    const pins = find(rendered.element, (element) => element.attrs["data-part"] === "marker");
    expect(pins.map((pin) => pin.style.left)).toEqual(["10%", "90%"]);
    expect(toHtml(rendered.element)).toContain('points="10,50 90,50"');
  });
});
