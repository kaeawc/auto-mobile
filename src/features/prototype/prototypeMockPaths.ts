/**
 * Mock path geometry for the actor `advance` step (#14211): positions a distance along a polyline
 * of `{lat, lng}` points on a sphere. Segment lengths are haversine great-circle distances, a
 * position inside a segment is the great-circle intermediate point, and the heading is the
 * segment's initial bearing, clockwise from true north.
 *
 * Outputs are rounded (lat/lng to 6 decimals, about 0.1 m; heading to 0.1 degree) so the
 * on-device twins can replay the shared actor fixtures exactly.
 */

export interface MockPathPoint {
  lat: number;
  lng: number;
}

export interface MockPathPosition extends MockPathPoint {
  /** Degrees clockwise from true north, in [0, 360). */
  heading: number;
}

/** The IUGG mean Earth radius. */
export const MOCK_PATH_EARTH_RADIUS_METERS = 6_371_008.8;

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;
const toDegrees = (radians: number): number => (radians * 180) / Math.PI;
const round = (value: number, digits: number): number => {
  const scale = 10 ** digits;
  // `|| 0` folds a rounded -0 into 0 so JSON output stays stable.
  return Math.round(value * scale) / scale || 0;
};

/** Central angle between two points, in radians (haversine). */
function centralAngle(a: MockPathPoint, b: MockPathPoint): number {
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(a.lat)) * Math.cos(toRadians(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
}

export function mockPathDistanceMeters(a: MockPathPoint, b: MockPathPoint): number {
  return MOCK_PATH_EARTH_RADIUS_METERS * centralAngle(a, b);
}

/** Initial bearing from `a` towards `b`, in degrees [0, 360). */
export function mockPathBearing(a: MockPathPoint, b: MockPathPoint): number {
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const dLng = toRadians(b.lng - a.lng);
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return (toDegrees(Math.atan2(y, x)) + 360) % 360;
}

/** The point `fraction` of the way from `a` to `b` along their great circle. */
function intermediate(a: MockPathPoint, b: MockPathPoint, fraction: number): MockPathPoint {
  const delta = centralAngle(a, b);
  if (delta === 0) {
    return a;
  }
  const lat1 = toRadians(a.lat);
  const lng1 = toRadians(a.lng);
  const lat2 = toRadians(b.lat);
  const lng2 = toRadians(b.lng);
  const wa = Math.sin((1 - fraction) * delta) / Math.sin(delta);
  const wb = Math.sin(fraction * delta) / Math.sin(delta);
  const x = wa * Math.cos(lat1) * Math.cos(lng1) + wb * Math.cos(lat2) * Math.cos(lng2);
  const y = wa * Math.cos(lat1) * Math.sin(lng1) + wb * Math.cos(lat2) * Math.sin(lng2);
  const z = wa * Math.sin(lat1) + wb * Math.sin(lat2);
  return {
    lat: toDegrees(Math.atan2(z, Math.sqrt(x * x + y * y))),
    lng: toDegrees(Math.atan2(y, x)),
  };
}

export function mockPathLengthMeters(points: readonly MockPathPoint[]): number {
  return points
    .slice(1)
    .reduce((total, point, index) => total + mockPathDistanceMeters(points[index]!, point), 0);
}

/**
 * The position `meters` along `points`, clamped to its ends. Zero-length segments are skipped; a
 * path whose points all coincide sits at its first point with heading 0.
 */
export function mockPathPosition(
  points: readonly MockPathPoint[],
  meters: number,
): MockPathPosition {
  let walked = 0;
  let heading = 0;
  let at: MockPathPoint = points[0]!;
  for (let index = 1; index < points.length; index++) {
    const from = points[index - 1]!;
    const to = points[index]!;
    const length = mockPathDistanceMeters(from, to);
    if (length === 0) {
      continue;
    }
    heading = mockPathBearing(from, to);
    const remaining = meters - walked;
    if (remaining <= length) {
      at = intermediate(from, to, Math.max(0, remaining) / length);
      return position(at, heading);
    }
    walked += length;
    at = to;
  }
  return position(at, heading);
}

function position(point: MockPathPoint, heading: number): MockPathPosition {
  return {
    lat: round(point.lat, 6),
    lng: round(point.lng, 6),
    heading: round(heading, 1) % 360,
  };
}
