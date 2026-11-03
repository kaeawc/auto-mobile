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
/**
 * Extents narrower than this share of the world are a point: wrapping a lone longitude into the
 * gap search shifts it by whole worlds, which leaves rounding noise instead of a zero width.
 */
const POINT_EXTENT = 1e-9;

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

/** `dx` moved to the nearest copy of the world, in `[-0.5, 0.5)`. */
export function wrapOffset(dx: number): number {
  return dx - Math.floor(dx + 0.5);
}

/** A line's x coordinates as it is drawn: each one the short way round from the one before. */
function unwrappedXs(points: readonly MapPoint[]): number[] {
  return points.reduce<number[]>(
    (xs, point, index) => [
      ...xs,
      index === 0 ? point.x : xs[index - 1]! + wrapOffset(point.x - points[index - 1]!.x),
    ],
    [],
  );
}

interface Span {
  readonly start: number;
  readonly end: number;
}

function mergeSpans(spans: readonly Span[]): Span[] {
  return spans
    .toSorted((a, b) => a.start - b.start)
    .reduce<Span[]>((merged, span) => {
      const last = merged.at(-1);
      return last && span.start <= last.end
        ? [...merged.slice(0, -1), { start: last.start, end: Math.max(last.end, span.end) }]
        : [...merged, span];
    }, []);
}

/**
 * The left and right x of the smallest arc covering every span, unwrapped so `right` may pass 1:
 * the arc starts just after the widest stretch of the world no span covers. Copies of the spans one
 * and two worlds over make every gap that opens in `[1, 2)` a real one, each listed once.
 */
function horizontalBounds(spans: readonly Span[]): Span {
  const base = spans.map(({ start, end }) => {
    const from = start - Math.floor(start);
    return { start: from, end: from + end - start };
  });
  const merged = mergeSpans(
    [0, 1, 2].flatMap((shift) =>
      base.map(({ start, end }) => ({ start: start + shift, end: end + shift })),
    ),
  );
  const gaps = merged.slice(1).flatMap((next, index) => {
    const before = merged[index]!.end;
    return before >= 1 && before < 2
      ? [{ width: next.start - before, start: next.start - 1, end: before }]
      : [];
  });
  const widest = gaps.reduce<(typeof gaps)[number] | undefined>(
    (best, gap) => (best && best.width >= gap.width ? best : gap),
    undefined,
  );
  if (widest) {
    return { start: widest.start, end: widest.end };
  }
  return wrappedBounds(spans);
}

/** `span` moved whole to the copy of the world that puts its middle nearest `center`, as drawn. */
function placeSpan(span: Span, center: number): Span {
  const middle = (span.start + span.end) / 2;
  const shift = center + wrapOffset(middle - center) - middle;
  return { start: span.start + shift, end: span.end + shift };
}

function union(spans: readonly Span[]): Span {
  return {
    start: Math.min(...spans.map((span) => span.start)),
    end: Math.max(...spans.map((span) => span.end)),
  };
}

/**
 * Bounds for spans that together leave no gap round the world. Each span is placed as
 * `mapPercent`/`routePercents` draw it: whole, on the copy whose middle is nearest the framing
 * centre. Seeded on the widest span, the centre moves to the middle of the placed spans' union;
 * the bounds are then symmetric round that centre and cover every span as placed from it (at least
 * one world wide), so fitting and drawing agree and no span is clipped, even past one world.
 */
function wrappedBounds(spans: readonly Span[]): Span {
  const longest = spans.reduce((best, span) =>
    span.end - span.start > best.end - best.start ? span : best,
  );
  const seeded = union(spans.map((span) => placeSpan(span, (longest.start + longest.end) / 2)));
  const center = (seeded.start + seeded.end) / 2;
  const placed = union(spans.map((span) => placeSpan(span, center)));
  const half = Math.max(0.5, center - placed.start, placed.end - center);
  return { start: center - half, end: center + half };
}

/**
 * The framing that fits `points` and the drawn `lines` in `size` with a margin; undefined when there
 * is nothing to fit. A line is fitted over the span it is drawn across, not just its vertices.
 */
export function fitFraming(
  points: readonly MapPoint[],
  size: { width: number; height: number },
  lines: readonly (readonly MapPoint[])[] = [],
): MapFraming | undefined {
  const drawn = lines.filter((line) => line.length > 0);
  const ys = [...points, ...drawn.flat()].map((point) => point.y);
  if (ys.length === 0) {
    return undefined;
  }
  const spans = [
    ...points.map((point) => ({ start: point.x, end: point.x })),
    ...drawn.map((line) => {
      const xs = unwrappedXs(line);
      return { start: Math.min(...xs), end: Math.max(...xs) };
    }),
  ];
  const { start: left, end: right } = horizontalBounds(spans);
  const [top, bottom] = [Math.min(...ys), Math.max(...ys)];
  const middle = (left + right) / 2;
  const center = { x: middle - Math.floor(middle), y: (top + bottom) / 2 };
  const fits = [
    right - left > POINT_EXTENT ? (size.width * FIT_FILL) / (right - left) : Infinity,
    bottom - top > POINT_EXTENT ? (size.height * FIT_FILL) / (bottom - top) : Infinity,
  ];
  const fitted = Math.min(...fits);
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
  points: { markers: MapPoint[]; lines: MapPoint[][] },
  size: { width: number; height: number },
): { view: MapFraming; orientation: MapOrientation } {
  const fitted =
    node.fit === "markers"
      ? fitFraming(points.markers, size)
      : node.fit === "route"
        ? fitFraming([], size, points.lines)
        : undefined;
  if (fitted) {
    return { view: fitted, orientation: NORTH_UP };
  }
  const camera = cameraFraming(node, scope);
  if (camera) {
    return { view: camera, orientation: cameraOrientation(cameraRecord(node, scope)) };
  }
  const view = fitFraming(points.markers, size, points.lines) ?? {
    center: { x: 0.5, y: 0.5 },
    worldSize: TILE_SIZE,
  };
  return { view, orientation: NORTH_UP };
}

/** Where a world offset from the centre falls in the box, as a percentage of each side. */
function offsetPercent(
  dx: number,
  dy: number,
  view: MapFraming,
  size: { width: number; height: number },
): { left: number; top: number } {
  const round = (value: number) => Number(value.toFixed(3));
  return {
    left: round(50 + (dx * view.worldSize * 100) / size.width),
    top: round(50 + (dy * view.worldSize * 100) / size.height),
  };
}

/**
 * Where a world point falls in the box, as a percentage of each side (outside is 0–100 too), taking
 * the copy of the world nearest the centre so the 180° line does not split the view.
 */
export function mapPercent(
  point: MapPoint,
  view: MapFraming,
  size: { width: number; height: number },
): { left: number; top: number } {
  return offsetPercent(wrapOffset(point.x - view.center.x), point.y - view.center.y, view, size);
}

/**
 * A line's horizontal world offsets from the centre: each point the short way round from the one
 * before, the line anchored by its middle, as fitting frames it, so a line wider than half the
 * world keeps the copy it was fitted on.
 */
function routeOffsets(points: readonly MapPoint[], view: MapFraming): number[] {
  const xs = unwrappedXs(points);
  const middle = (Math.min(...xs) + Math.max(...xs)) / 2;
  const shift = wrapOffset(middle - view.center.x) - middle;
  return xs.map((x) => x + shift);
}

/**
 * A line's points in the box: the first as `mapPercent` places it, each next one the short way
 * round from the one before, so a segment crossing the 180° line does not span the world.
 */
export function routePercents(
  points: readonly MapPoint[],
  view: MapFraming,
  size: { width: number; height: number },
): { left: number; top: number }[] {
  const offsets = routeOffsets(points, view);
  return points.map((point, index) =>
    offsetPercent(offsets[index]!, point.y - view.center.y, view, size),
  );
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

/** A world offset from the centre turned by `-bearing` about the box centre, in dp. */
function turnGround(offset: GroundPoint, view: MapFraming, bearing: number): GroundPoint {
  const dx = offset.x * view.worldSize;
  const dy = offset.y * view.worldSize;
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
 * at or behind the near plane. North up and straight down, this is `mapPercent`; like it, a
 * point takes the copy of the world nearest the centre.
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
  const offset = { x: wrapOffset(point.x - view.center.x), y: point.y - view.center.y };
  const ground = turnGround(offset, view, orientation.bearing);
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
    return points.length > 0 ? [routePercents(points, view, size)] : [];
  }
  if (points.length === 0) {
    return [];
  }
  const limit = nearLimit(orientation.tilt, size.height);
  const offsets = routeOffsets(points, view);
  const ground = points.map((point, index) =>
    turnGround({ x: offsets[index]!, y: point.y - view.center.y }, view, orientation.bearing),
  );
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
 * `groundReach` (plus a pixel) out, so the tilted, turned plane covers the box at any aspect ratio.
 * A `fill` box can render larger than the dp size the reach is computed from, so the square is also
 * at least three times the box's longer side (`cqmax`, the box being a size container), which
 * covers it at any bearing; the box clips the rest.
 */
function groundLayer(background: string, orientation: MapOrientation, size: Size): WebElement {
  const reach = Math.ceil(groundReach(size, orientation.tilt)) + 1;
  const side = `max(${reach * 2}px,300cqmax)`;
  return el("div", {
    attrs: { "aria-hidden": "true", "data-part": "ground" },
    style: {
      position: "absolute",
      left: "50%",
      top: "50%",
      width: side,
      height: side,
      margin: `calc(${side} / -2) 0 0 calc(${side} / -2)`,
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
        lines: lines.map((line) => line.points),
      },
      size,
    );
    const turned = orientation.bearing !== 0 || orientation.tilt !== 0;
    const background = MAP_BACKGROUNDS[String(node.mapStyle)] ?? MAP_BACKGROUNDS.streets!;
    const { attrs, style: css } = kit.base(node, scope, {
      position: "relative",
      overflow: "hidden",
      background: turned ? MAP_BACKGROUNDS.plain! : background,
      // Lets the ground layer size itself from the box as rendered (`cqmax`); the map's content is
      // all absolutely placed, so size containment changes nothing else.
      ...(turned ? { "container-type": "size" } : {}),
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
