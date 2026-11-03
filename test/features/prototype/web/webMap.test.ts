import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  cameraOrientation,
  eyeDistance,
  fitFraming,
  fromCentre,
  groundReach,
  groundTransform,
  mapOffset,
  mapSize,
  mercator,
  projectLine,
  projectOffset,
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

/** A pin's offset from the box centre, read back from `fromCentre`'s CSS. */
function offsetOf(value: unknown): number {
  const text = String(value);
  if (text === "50%") {
    return 0;
  }
  const match = /^calc\(50% ([+-]) ([\d.]+)px\)$/.exec(text);
  expect(match).not.toBeNull();
  return (match![1] === "-" ? -1 : 1) * Number(match![2]);
}

/** The default still frame's portrait screen, which a root map fills. */
const SCREEN = { width: 411, height: 923 };

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
    // 80% of the 400 dp width, split either side of the centre.
    expect(mapOffset(points[0]!, view).x).toBeCloseTo(-160, 3);
    expect(mapOffset(points[1]!, view).x).toBeCloseTo(160, 3);
    expect(fitFraming([points[0]!], size)!.worldSize).toBe(256 * 2 ** 15);
    expect(fitFraming([], size)).toBeUndefined();
  });

  test("places a point in dp from the box centre", () => {
    expect(fromCentre(0)).toBe("50%");
    expect(fromCentre(12.5)).toBe("calc(50% + 12.5px)");
    expect(fromCentre(-80)).toBe("calc(50% - 80px)");
  });

  test("draws marker pins and route lines with no tiles or placeholder", () => {
    const map = still({ markers, polylines: [{ path: "/route", width: 6 }], fit: "markers" });
    expect(map.unsupportedNodes).toEqual([]);
    const pins = map.part("marker");
    expect(pins.map((pin) => pin.attrs["aria-label"])).toEqual(["Ferry", "Pier"]);
    const at = pins.map((pin) => [offsetOf(pin.style.left), offsetOf(pin.style.top)]);
    // The root fills the screen: the fit spans 80% of its width (the tighter side), centred.
    expect(at[0]![0]).toBeCloseTo(-SCREEN.width * 0.4, 3);
    expect(at[1]).toEqual([-at[0]![0]!, -at[0]![1]!]);
    expect(map.html).toContain(
      `<polyline fill="none" points="${at[0]!.join(",")} ${at[1]!.join(",")}"`,
    );
    expect(map.html).toContain('<svg aria-hidden="true" height="1"');
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
    expect(pins.map((pin) => pin.style.left)).toEqual(["calc(50% - 80px)", "calc(50% + 80px)"]);
    expect(map.html).toContain("height:400px");
  });

  test("sizes a map by its dp size, else 200 dp tall, else the screen it fills", () => {
    const screen = { width: 390, height: 844 };
    expect(mapSize({ width: { dp: 300 }, height: { dp: 150 } }, screen)).toEqual({
      width: 300,
      height: 150,
    });
    expect(mapSize(undefined, screen)).toEqual({ width: 390, height: 200 });
    expect(mapSize({ height: "fill" }, screen)).toEqual({ width: 390, height: 844 });
  });

  test("an empty map draws the neutral canvas", () => {
    const map = still({ mapStyle: "plain" });
    expect(map.unsupportedNodes).toEqual([]);
    expect(map.html).toContain("background:#e8eaed");
  });

  test("north up and straight down projects exactly as the flat placement", () => {
    const view = { center: mercator(0, 0), worldSize: 256 * 2 ** 4 };
    const point = mercator(1, 2);
    expect(projectOffset(point, view, 300, { bearing: 0, tilt: 0 })).toEqual(
      mapOffset(point, view),
    );
  });

  test("a bearing turns the map the other way about the centre", () => {
    const center = mercator(0, 0);
    const view = { center, worldSize: 1000 };
    const east = { x: center.x + 0.05, y: center.y };
    // Facing east (90°), east is straight ahead: up the screen.
    expect(projectOffset(east, view, 300, { bearing: 90, tilt: 0 })).toEqual({ x: 0, y: -50 });
    // Facing south, east is on the left.
    expect(projectOffset(east, view, 300, { bearing: 180, tilt: 0 })).toEqual({ x: -50, y: 0 });
  });

  test("a tilt pulls the far half in and pushes the near half out", () => {
    const center = mercator(0, 0);
    const view = { center, worldSize: 1000 };
    const eye = eyeDistance(200);
    const offset = (dx: number, dy: number) => ({ x: center.x + dx, y: center.y + dy });
    const tilted = (dx: number, dy: number) =>
      projectOffset(offset(dx, dy), view, eye, { bearing: 0, tilt: 60 })!;
    expect(tilted(0, 0)).toEqual({ x: 0, y: 0 });
    const far = tilted(0.05, -0.05);
    const near = tilted(0.05, 0.05);
    expect(far.y).toBeGreaterThan(-50);
    expect(far.x).toBeLessThan(50);
    expect(near.y).toBeLessThan(100);
    expect(near.x).toBeGreaterThan(50);
    // The eye is 1.5 heights (300 dp) out: a point that far down at 60° sits behind it.
    expect(projectOffset(offset(0, 0.4), view, eye, { bearing: 0, tilt: 60 })).toBeUndefined();
  });

  test("reads and clamps the camera's bearing and tilt", () => {
    expect(cameraOrientation(undefined)).toEqual({ bearing: 0, tilt: 0 });
    expect(cameraOrientation({ bearing: 45, tilt: 30 })).toEqual({ bearing: 45, tilt: 30 });
    expect(cameraOrientation({ bearing: 360, tilt: 90 })).toEqual({ bearing: 0, tilt: 60 });
    expect(cameraOrientation({ bearing: "45", tilt: -5 })).toEqual({ bearing: 0, tilt: 0 });
    expect(groundTransform({ bearing: 45, tilt: 30 }, 200)).toBe(
      "perspective(300px) rotateX(30deg) rotate(-45deg)",
    );
  });

  test("a turned camera draws a turned ground layer and projected pins", () => {
    const map = still({
      markers,
      style: { width: { dp: 412 }, height: { dp: 200 } },
      camera: { lat: 37.77, lng: -122.42, zoom: 12, bearing: 90, tilt: 45 },
    });
    const ground = map.part("ground");
    expect(ground).toHaveLength(1);
    expect(ground[0]!.style.transform).toBe("perspective(300px) rotateX(45deg) rotate(-90deg)");
    // A 412 × 200 box at 45°: its top corners trace back to (±309, −212), about 375 dp out.
    expect(ground[0]!.style).toMatchObject({
      width: "max(752px,300cqmax)",
      height: "max(752px,300cqmax)",
      margin: "calc(max(752px,300cqmax) / -2) 0 0 calc(max(752px,300cqmax) / -2)",
    });
    const pins = map.part("marker");
    expect(pins[0]!.style).toMatchObject({ left: "50%", top: "50%" });
    // The pier lies north-east; facing east it is ahead and to the left.
    expect(offsetOf(pins[1]!.style.left)).toBeLessThan(0);
    expect(offsetOf(pins[1]!.style.top)).toBeLessThan(0);
    expect(map.html).not.toMatch(/\b(src|href)=|url\(/);
  });

  test("a data camera turns too, and a fit frames north up", () => {
    const fromData = renderPrototypeStill({
      ...reference,
      data: { places, cam: { lat: 37.8, lng: -122.4, zoom: 12, bearing: 30 } },
      root: { type: "map", markers, camera: { data: "/cam" } },
    });
    const ground = find(fromData.element, (element) => element.attrs["data-part"] === "ground");
    expect(ground[0]!.style.transform).toBe("perspective(1384.5px) rotateX(0deg) rotate(-30deg)");
    const fitted = still({
      markers,
      fit: "markers",
      camera: { lat: 37.77, lng: -122.42, zoom: 12, bearing: 90 },
    });
    expect(fitted.part("ground")).toEqual([]);
    const left = fitted.part("marker").map((pin) => offsetOf(pin.style.left));
    // North up, the pier lies east of the ferry, either side of the centre.
    expect(left[0]).toBeLessThan(0);
    expect(left[1]).toBe(-left[0]!);
  });

  test("the ground reaches every corner of a short, wide box", () => {
    // At 60° the 390 × 100 box's top corners trace back to about (±461, −237) on the ground,
    // past a fixed three-box overscan's 350 dp.
    expect(groundReach({ width: 390, height: 100 }, 60)).toBeCloseTo(518.6, 0);
    expect(groundReach({ width: 200, height: 200 }, 0)).toBeCloseTo(Math.hypot(100, 100), 6);
    const map = still({
      markers,
      style: { width: { dp: 390 }, height: { dp: 100 } },
      camera: { lat: 37.77, lng: -122.42, zoom: 12, bearing: 90, tilt: 60 },
    });
    expect(map.part("ground")[0]!.style.width).toBe("max(1040px,300cqmax)");
  });

  test("a route clips at the near plane instead of dropping its far vertex", () => {
    const center = mercator(0, 0);
    const view = { center, worldSize: 256 * 2 ** 3 };
    const eye = eyeDistance(200);
    const orientation = { bearing: 0, tilt: 60 };
    const south = mercator(-60, 0);
    const [run, ...rest] = projectLine([center, south], view, eye, orientation);
    expect(rest).toEqual([]);
    expect(run).toHaveLength(2);
    expect(run![0]).toEqual({ x: 0, y: 0 });
    // Latitude −10 lies on the visible part, so the clipped end is past it.
    const tenSouth = projectOffset(mercator(-10, 0), view, eye, orientation)!;
    expect(tenSouth.y).toBeCloseTo(34.242, 3);
    expect(run![1]!.y).toBeGreaterThan(tenSouth.y);
    expect(run![1]!.x).toBe(0);
    // Passing behind the eye and back breaks the line rather than joining its visible ends.
    const runs = projectLine([center, south, mercator(0, 10)], view, eye, orientation);
    expect(runs).toHaveLength(2);
    expect(runs.map((points) => points.length)).toEqual([2, 2]);
  });

  test("a flat line is one run of the flat placement", () => {
    const view = { center: mercator(0, 0), worldSize: 4096 };
    const points = [mercator(0, -1), mercator(1, 1)];
    expect(projectLine(points, view, 300, { bearing: 0, tilt: 0 })).toEqual([
      points.map((point) => mapOffset(point, view)),
    ]);
    expect(projectLine([], view, 300, { bearing: 0, tilt: 0 })).toEqual([]);
  });

  test("a turned fill map sizes its ground from the box as rendered", () => {
    const map = still({
      markers,
      style: { height: "fill" },
      camera: { lat: 37.77, lng: -122.42, zoom: 12, bearing: 90 },
    });
    // The box is a size container, so `cqmax` is its longer rendered side, however tall it fills.
    expect(map.html).toContain("container-type:size");
    expect(map.part("ground")[0]!.style.height).toMatch(/^max\(\d+px,300cqmax\)$/);
    expect(still({ markers }).html).not.toContain("container-type");
  });

  test("a tilted fill map puts its eye far enough out that no horizon shows (#16656)", () => {
    const map = still({
      markers,
      camera: { lat: 37.77, lng: -122.42, zoom: 12, tilt: 60 },
    });
    // The root fills the screen, so the eye is 1.5 screen heights out, not 1.5 × 200 dp.
    const eye = eyeDistance(SCREEN.height);
    expect(map.part("ground")[0]!.style.transform).toBe(
      `perspective(${eye}px) rotateX(60deg) rotate(0deg)`,
    );
    // The horizon sits eye·cot(tilt) above the centre: past the top of any box up to the screen.
    expect(eye / Math.tan((60 * Math.PI) / 180)).toBeGreaterThan(SCREEN.height / 2);
    // The ground's reach covers the whole screen-sized box at that eye.
    const side = Number(/^max\((\d+)px/.exec(String(map.part("ground")[0]!.style.width))![1]!);
    expect(side / 2).toBeGreaterThanOrEqual(groundReach(SCREEN, 60));
  });

  test("a fill map places pins at their zoom, whatever size the box renders at (#16656)", () => {
    const camera = { lat: 37.77, lng: -122.42, zoom: 12 };
    const map = still({ markers, camera });
    const view = { center: mercator(camera.lat, camera.lng), worldSize: 256 * 2 ** 12 };
    const pier = mapOffset(mercator(37.8, -122.4), view);
    expect(map.part("marker")[1]!.style).toMatchObject({
      left: fromCentre(pier.x),
      top: fromCentre(pier.y),
    });
  });
});
