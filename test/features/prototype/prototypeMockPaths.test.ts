import { describe, expect, test } from "bun:test";
import {
  mockPathBearing,
  mockPathDistanceMeters,
  mockPathLengthMeters,
  mockPathPosition,
} from "../../../src/features/prototype/prototypeMockPaths";

describe("mock path geometry", () => {
  test("haversine distance of a degree of longitude on the equator", () => {
    // R * pi / 180 with the IUGG mean radius.
    expect(mockPathDistanceMeters({ lat: 0, lng: 0 }, { lat: 0, lng: 1 })).toBeCloseTo(
      111195.08,
      1,
    );
  });

  test("initial bearings point along the compass", () => {
    const origin = { lat: 0, lng: 0 };
    expect(mockPathBearing(origin, { lat: 1, lng: 0 })).toBeCloseTo(0, 6);
    expect(mockPathBearing(origin, { lat: 0, lng: 1 })).toBeCloseTo(90, 6);
    expect(mockPathBearing(origin, { lat: -1, lng: 0 })).toBeCloseTo(180, 6);
    expect(mockPathBearing(origin, { lat: 0, lng: -1 })).toBeCloseTo(270, 6);
  });

  test("a position walks the segments in order and clamps to both ends", () => {
    const points = [
      { lat: 0, lng: 0 },
      { lat: 0, lng: 0.001 },
      { lat: 0.001, lng: 0.001 },
    ];
    expect(mockPathLengthMeters(points)).toBeCloseTo(222.39, 2);
    expect(mockPathPosition(points, -5)).toEqual({ lat: 0, lng: 0, heading: 90 });
    expect(mockPathPosition(points, 50)).toEqual({ lat: 0, lng: 0.00045, heading: 90 });
    expect(mockPathPosition(points, 150)).toEqual({ lat: 0.000349, lng: 0.001, heading: 0 });
    expect(mockPathPosition(points, 10_000)).toEqual({ lat: 0.001, lng: 0.001, heading: 0 });
  });

  test("repeated points are skipped and a path of one place has heading 0", () => {
    const here = { lat: 51.5, lng: -0.12 };
    expect(mockPathPosition([here, here], 10)).toEqual({ lat: 51.5, lng: -0.12, heading: 0 });
    expect(mockPathPosition([here, here, { lat: 51.6, lng: -0.12 }], 0).heading).toBe(0);
  });

  test("a midpoint follows the great circle, not a straight lat/lng line", () => {
    const start = { lat: 0, lng: -45 };
    const end = { lat: 0, lng: 45 };
    // Both ends on the equator: the great circle is the equator itself.
    expect(mockPathPosition([start, end], mockPathLengthMeters([start, end]) / 2)).toEqual({
      lat: 0,
      lng: 0,
      heading: 90,
    });
    const north = mockPathPosition(
      [
        { lat: 40, lng: -60 },
        { lat: 40, lng: 60 },
      ],
      mockPathLengthMeters([
        { lat: 40, lng: -60 },
        { lat: 40, lng: 60 },
      ]) / 2,
    );
    // Between two points on the same parallel the great circle bulges towards the pole.
    expect(north.lat).toBeGreaterThan(40);
    expect(north.lng).toBeCloseTo(0, 6);
  });
});
