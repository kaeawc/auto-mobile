import { resolvePrototypeDataPointer } from "../prototypeData";
import { bindText, record, type Raw } from "../prototypeTemplate";
import { el, type WebElement } from "./webNodes";
import type { NodeRenderer, WebRenderKit, WebRenderScope } from "./webRender";
import { cssColor } from "./webStyle";

/** A point in normalized Web Mercator: the world is the unit square, north up. */
export interface MapPoint {
  readonly x: number;
  readonly y: number;
}

/** What the camera frames: the world point at the centre and the world's width in dp. */
export interface MapFraming {
  readonly center: MapPoint;
  readonly worldSize: number;
}

/**
 * How the camera is turned: `bearing` degrees clockwise from north (the map turns the other way)
 * and `tilt` degrees from straight down (the top of the map recedes).
 */
export interface MapOrientation {
  readonly bearing: number;
  readonly tilt: number;
}

const NORTH_UP: MapOrientation = { bearing: 0, tilt: 0 };
/** The eye sits this many map heights from the ground plane, as Mapbox GL places its camera. */
const EYE_DISTANCE = 1.5;

const TILE_SIZE = 256;
const MAX_LATITUDE = 85.051_128_78;
/** The height an unsized map takes, and the zoom a single fitted point is framed at. */
const DEFAULT_MAP_HEIGHT = 200;
const SINGLE_POINT_ZOOM = 15;
/** A fitted framing leaves this share of the box around its points. */
const FIT_FILL = 0.8;

export function mercator(lat: number, lng: number): MapPoint {
  const clamped = Math.max(-MAX_LATITUDE, Math.min(MAX_LATITUDE, lat));
  const sin = Math.sin((clamped * Math.PI) / 180);
  return {
    x: (lng + 180) / 360,
    y: 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI),
  };
}

function latLng(value: unknown): MapPoint | undefined {
  const item = record(value);
  const lat = Number(item?.lat);
  const lng = Number(item?.lng);
  return item && item.lat !== "" && item.lng !== "" && Number.isFinite(lat) && Number.isFinite(lng)
    ? mercator(lat, lng)
    : undefined;
}

function dataItems(pointer: unknown, scope: WebRenderScope): unknown[] {
  const value = typeof pointer === "string" ? resolvePrototypeDataPointer(scope.data, pointer) : [];
  return Array.isArray(value) ? value : [];
}

interface MapMarker {
  readonly point: MapPoint;
  readonly title: string;
}

/** One marker per object item of `markers.path`, its templates bound under `markers.as`. */
function mapMarkers(node: Raw, scope: WebRenderScope): MapMarker[] {
  const markers = record(node.markers);
  if (!markers || typeof markers.as !== "string") {
    return [];
  }
  const binding = { alias: markers.as, index: false };
  return dataItems(markers.path, scope).flatMap((item) => {
    const values = record(item);
    if (!values) {
      return [];
    }
    const bind = (field: unknown) =>
      typeof field === "string" ? bindText(field, { binding, values }) : "";
    const point = latLng({ lat: bind(markers.lat), lng: bind(markers.lng) });
    return point ? [{ point, title: bind(markers.title) }] : [];
  });
}

interface MapLine {
  readonly points: MapPoint[];
  readonly width: number;
  readonly color: string;
}

function mapLines(node: Raw, scope: WebRenderScope): MapLine[] {
  const lines = Array.isArray(node.polylines) ? node.polylines.map(record) : [];
  const primary = cssColor("primary", scope.style) ?? "#6750a4";
  return lines.flatMap((line) => {
    const points = dataItems(line?.path, scope).flatMap((item) => {
      const point = latLng(item);
      return point ? [point] : [];
    });
    return points.length > 0
      ? [
          {
            points,
            width: typeof line?.width === "number" ? line.width : 4,
            color: cssColor(line?.color, scope.style) ?? primary,
          },
        ]
      : [];
  });
}

/** The framing that fits `points` in `size` with a margin; undefined when there are none. */
export function fitFraming(
  points: readonly MapPoint[],
  size: { width: number; height: number },
): MapFraming | undefined {
  if (points.length === 0) {
    return undefined;
  }
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const [left, right, top, bottom] = [
    Math.min(...xs),
    Math.max(...xs),
    Math.min(...ys),
    Math.max(...ys),
  ];
  const center = { x: (left + right) / 2, y: (top + bottom) / 2 };
  const spans = [
    right > left ? (size.width * FIT_FILL) / (right - left) : Infinity,
    bottom > top ? (size.height * FIT_FILL) / (bottom - top) : Infinity,
  ];
  const fitted = Math.min(...spans);
  const worldSize = Math.min(
    Number.isFinite(fitted) ? fitted : TILE_SIZE * 2 ** SINGLE_POINT_ZOOM,
    TILE_SIZE * 2 ** 22,
  );
  return { center, worldSize };
}

/** The camera object: a literal camera, or one read from `/data`. */
function cameraRecord(node: Raw, scope: WebRenderScope): Raw | undefined {
  const authored = record(node.camera);
  return typeof authored?.data === "string"
    ? record(resolvePrototypeDataPointer(scope.data, authored.data))
    : authored;
}

/** One orientation angle, clamped to the schema's range; anything non-numeric is 0. */
function angle(value: unknown, max: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(max, value)) % 360
    : 0;
}

/** The camera's bearing and tilt, north up and straight down when it names none. */
export function cameraOrientation(camera: Raw | undefined): MapOrientation {
  return { bearing: angle(camera?.bearing, 360), tilt: angle(camera?.tilt, 60) };
}

/** The camera framing: a literal camera, or one read from `/data`; undefined when it has none. */
function cameraFraming(node: Raw, scope: WebRenderScope): MapFraming | undefined {
  const camera = cameraRecord(node, scope);
  const center = latLng(camera);
  const zoom = Number(camera?.zoom);
  return center && Number.isFinite(zoom)
    ? { center, worldSize: TILE_SIZE * 2 ** Math.max(0, Math.min(22, zoom)) }
    : undefined;
}

/**
 * `fit: markers` or `route` frames those points; otherwise the camera, else every point, else the
 * whole world. Only a camera framing turns by the camera's bearing and tilt: a fit, like both
 * platforms' bounds fit, frames north up.
 */
function framing(
  node: Raw,
  scope: WebRenderScope,
  points: { markers: MapPoint[]; route: MapPoint[] },
  size: { width: number; height: number },
): { view: MapFraming; orientation: MapOrientation } {
  const fitted =
    node.fit === "markers"
      ? fitFraming(points.markers, size)
      : node.fit === "route"
        ? fitFraming(points.route, size)
        : undefined;
  if (fitted) {
    return { view: fitted, orientation: NORTH_UP };
  }
  const camera = cameraFraming(node, scope);
  if (camera) {
    return { view: camera, orientation: cameraOrientation(cameraRecord(node, scope)) };
  }
  const view = fitFraming([...points.markers, ...points.route], size) ?? {
    center: { x: 0.5, y: 0.5 },
    worldSize: TILE_SIZE,
  };
  return { view, orientation: NORTH_UP };
}

/** Where a world point falls in the box, as a percentage of each side (outside is 0–100 too). */
export function mapPercent(
  point: MapPoint,
  view: MapFraming,
  size: { width: number; height: number },
): { left: number; top: number } {
  const round = (value: number) => Number(value.toFixed(3));
  return {
    left: round(50 + ((point.x - view.center.x) * view.worldSize * 100) / size.width),
    top: round(50 + ((point.y - view.center.y) * view.worldSize * 100) / size.height),
  };
}

/** A point on the turned ground plane, in dp from the box centre, before the tilt. */
interface GroundPoint {
  readonly x: number;
  readonly y: number;
}

type Size = { width: number; height: number };
type Percent = { left: number; top: number };

/** A point nearer than this share of the eye distance is clipped, so nothing divides by ~0. */
const NEAR_PLANE = 0.1;

function radians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/** The world point turned by `-bearing` about the box centre, in dp. */
function turnGround(point: MapPoint, view: MapFraming, bearing: number): GroundPoint {
  const dx = (point.x - view.center.x) * view.worldSize;
  const dy = (point.y - view.center.y) * view.worldSize;
  const turn = radians(-bearing);
  return {
    x: dx * Math.cos(turn) - dy * Math.sin(turn),
    y: dx * Math.sin(turn) + dy * Math.cos(turn),
  };
}

/** The furthest a ground point may lie toward the viewer (down the box) and still be drawn. */
function nearLimit(tilt: number, height: number): number {
  const sin = Math.sin(radians(tilt));
  return sin > 0 ? (EYE_DISTANCE * height * (1 - NEAR_PLANE)) / sin : Infinity;
}

/** A ground point tilted away under the perspective eye, as a percentage of each side. */
function projectGround(point: GroundPoint, size: Size, tilt: number): Percent {
  const eye = EYE_DISTANCE * size.height;
  const scale = eye / (eye - point.y * Math.sin(radians(tilt)));
  const round = (value: number) => Number(value.toFixed(3));
  return {
    left: round(50 + (point.x * scale * 100) / size.width),
    top: round(50 + (point.y * Math.cos(radians(tilt)) * scale * 100) / size.height),
  };
}

/**
 * Where a world point falls under a turned camera, as a percentage of each side: the map turns by
 * `-bearing` about the box centre, then the ground plane tilts away under a perspective eye
 * `EYE_DISTANCE` heights out, exactly as `groundTransform` turns the canvas. Undefined for a point
 * at or behind the near plane. North up and straight down, this is `mapPercent`.
 */
export function projectPercent(
  point: MapPoint,
  view: MapFraming,
  size: Size,
  orientation: MapOrientation,
): Percent | undefined {
  if (orientation.bearing === 0 && orientation.tilt === 0) {
    return mapPercent(point, view, size);
  }
  const ground = turnGround(point, view, orientation.bearing);
  return ground.y > nearLimit(orientation.tilt, size.height)
    ? undefined
    : projectGround(ground, size, orientation.tilt);
}

/**
 * A line's visible runs: each segment is clipped to the near plane on the ground (where clipping is
 * linear, before the perspective division), and a run breaks where the line passes behind it.
 */
export function projectLine(
  points: readonly MapPoint[],
  view: MapFraming,
  size: Size,
  orientation: MapOrientation,
): Percent[][] {
  if (orientation.bearing === 0 && orientation.tilt === 0) {
    return points.length > 0 ? [points.map((point) => mapPercent(point, view, size))] : [];
  }
  const limit = nearLimit(orientation.tilt, size.height);
  const ground = points.map((point) => turnGround(point, view, orientation.bearing));
  const runs: GroundPoint[][] = [];
  let run: GroundPoint[] = [];
  const at = (from: GroundPoint, to: GroundPoint): GroundPoint => {
    const share = (limit - from.y) / (to.y - from.y);
    return { x: from.x + (to.x - from.x) * share, y: limit };
  };
  for (const [index, point] of ground.entries()) {
    const previous = ground[index - 1];
    const inside = point.y <= limit;
    if (previous && previous.y <= limit !== inside) {
      run.push(at(previous, point));
      if (!inside) {
        runs.push(run);
        run = [];
      }
    }
    if (inside) {
      run.push(point);
    }
  }
  runs.push(run);
  return runs
    .filter((points) => points.length > 0)
    .map((points) => points.map((point) => projectGround(point, size, orientation.tilt)));
}

/**
 * How far from the box centre the turned ground must reach to cover the whole box: each box
 * corner traced back through the perspective onto the ground plane. The bearing turns the plane
 * about the centre, so the farthest corner's distance covers every bearing.
 */
export function groundReach(size: Size, tilt: number): number {
  const eye = EYE_DISTANCE * size.height;
  const [sin, cos] = [Math.sin(radians(tilt)), Math.cos(radians(tilt))];
  const corners = [-1, 1].flatMap((sx) =>
    [-1, 1].map((sy) => ({ X: (sx * size.width) / 2, Y: (sy * size.height) / 2 })),
  );
  return Math.max(
    ...corners.map(({ X, Y }) => {
      // Screen Y = y·cos·eye/(eye − y·sin), solved for y; the box stays below the horizon at 60°.
      const y = (Y * eye) / (eye * cos + Y * sin);
      const x = (X * (eye - y * sin)) / eye;
      return Math.hypot(x, y);
    }),
  );
}

/** The CSS transform that turns the ground canvas the way `projectPercent` turns points. */
export function groundTransform(orientation: MapOrientation, height: number): string {
  const eye = Number((EYE_DISTANCE * height).toFixed(3));
  return `perspective(${eye}px) rotateX(${orientation.tilt}deg) rotate(${-orientation.bearing}deg)`;
}

/** A `{dp}` dimension, as the style maps it to CSS; anything else (unsized, `fill`) falls back. */
function dpSize(value: unknown, fallback: number): number {
  const dp = record(value)?.dp;
  return typeof dp === "number" && dp > 0 ? dp : fallback;
}

function routeLayer(lines: MapLine[], project: (points: MapPoint[]) => Percent[][]) {
  return el(
    "svg",
    {
      attrs: { viewBox: "0 0 100 100", preserveAspectRatio: "none", "aria-hidden": "true" },
      style: {
        position: "absolute",
        inset: "0",
        width: "100%",
        height: "100%",
        overflow: "visible",
      },
    },
    lines.flatMap((line) =>
      project(line.points).map((run) =>
        el("polyline", {
          attrs: {
            points: run.map(({ left, top }) => `${left},${top}`).join(" "),
            fill: "none",
            stroke: line.color,
            "stroke-width": String(line.width),
            "stroke-linecap": "round",
            "stroke-linejoin": "round",
            "vector-effect": "non-scaling-stroke",
          },
        }),
      ),
    ),
  );
}

function markerPin(
  marker: MapMarker,
  at: { left: number; top: number },
  color: string,
): WebElement {
  return el("span", {
    attrs: { role: "img", "aria-label": marker.title, title: marker.title, "data-part": "marker" },
    style: {
      position: "absolute",
      left: `${at.left}%`,
      top: `${at.top}%`,
      width: "20px",
      height: "20px",
      transform: "translate(-50%,-100%) rotate(-45deg)",
      "transform-origin": "50% 100%",
      "border-radius": "50% 50% 50% 0",
      "background-color": color,
      border: "2px solid #fff",
      "box-sizing": "border-box",
    },
  });
}

/**
 * The canvas on its own layer, turned like the camera: a square centred on the box that reaches
 * `groundReach` (plus a pixel) out, so the tilted, turned plane covers the box at any aspect ratio;
 * the box clips it.
 */
function groundLayer(background: string, orientation: MapOrientation, size: Size): WebElement {
  const reach = Math.ceil(groundReach(size, orientation.tilt)) + 1;
  return el("div", {
    attrs: { "aria-hidden": "true", "data-part": "ground" },
    style: {
      position: "absolute",
      left: "50%",
      top: "50%",
      width: `${reach * 2}px`,
      height: `${reach * 2}px`,
      margin: `-${reach}px 0 0 -${reach}px`,
      background,
      transform: groundTransform(orientation, size.height),
    },
  });
}

const MAP_BACKGROUNDS: Readonly<Record<string, string>> = {
  plain: "#e8eaed",
  // Streets: a faint road grid over land, since tiles are not fetched.
  streets:
    "repeating-linear-gradient(0deg,transparent 0 46px,#fff 46px 50px),repeating-linear-gradient(90deg,transparent 0 46px,#fff 46px 50px),#ebe7df",
};

/**
 * A map with no tiles (the page fetches nothing): a neutral canvas with the route lines and marker
 * pins placed by Web Mercator under the framing. A camera `bearing` or `tilt` turns the canvas on
 * its own ground layer (oversized so a tilted plane still fills the box) and projects the lines and
 * pins to match; the pins stay upright, as both platforms draw them.
 */
const mapRenderer =
  (kit: WebRenderKit): NodeRenderer =>
  (node, scope) => {
    const style = record(node.style);
    const size = {
      width: dpSize(style?.width, scope.screenWidth),
      height: dpSize(style?.height, DEFAULT_MAP_HEIGHT),
    };
    const markers = mapMarkers(node, scope);
    const lines = mapLines(node, scope);
    const { view, orientation } = framing(
      node,
      scope,
      {
        markers: markers.map((marker) => marker.point),
        route: lines.flatMap((line) => line.points),
      },
      size,
    );
    const turned = orientation.bearing !== 0 || orientation.tilt !== 0;
    const background = MAP_BACKGROUNDS[String(node.mapStyle)] ?? MAP_BACKGROUNDS.streets!;
    const { attrs, style: css } = kit.base(node, scope, {
      position: "relative",
      overflow: "hidden",
      background: turned ? MAP_BACKGROUNDS.plain! : background,
      "align-self": "stretch",
      height: `${DEFAULT_MAP_HEIGHT}px`,
    });
    const pin = cssColor("error", scope.style) ?? "#b3261e";
    return el("div", { attrs: { "aria-label": "Map", ...attrs, role: "img" }, style: css }, [
      ...(turned ? [groundLayer(background, orientation, size)] : []),
      ...(lines.length > 0
        ? [routeLayer(lines, (points) => projectLine(points, view, size, orientation))]
        : []),
      ...markers.flatMap((marker) => {
        const at = projectPercent(marker.point, view, size, orientation);
        return at ? [markerPin(marker, at, pin)] : [];
      }),
    ]);
  };

export function webMapRenderers(kit: WebRenderKit): Record<string, NodeRenderer> {
  return { map: mapRenderer(kit) };
}
