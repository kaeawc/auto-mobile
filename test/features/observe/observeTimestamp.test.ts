import { expect, test } from "bun:test";
import {
  hierarchyUpdatedAtToMillis,
  updatedAtToMillis,
} from "../../../src/features/observe/observeTimestamp";

test("numeric timestamps pass through including nonfinite values", () => {
  for (const value of [0, -5, 1.25, NaN, Infinity, -Infinity]) {
    expect(updatedAtToMillis(value)).toBe(value);
  }
});

test("numeric strings use Number coercion and ISO strings use Date.parse", () => {
  for (const [value, expected] of [
    ["1700000000000", 1700000000000],
    [" 5 ", 5],
    ["1e3", 1000],
    ["", 0],
  ] as const) {
    expect(updatedAtToMillis(value)).toBe(expected);
  }
  const iso = "2026-10-03T12:34:56.789Z";
  expect(updatedAtToMillis(iso)).toBe(Date.parse(iso));
});

test("unparseable strings including nonfinite numeric strings fall back to zero", () => {
  for (const value of ["garbage", "NaN", "Infinity", "-Infinity"]) {
    expect(Number.isNaN(Date.parse(value))).toBe(true);
    expect(updatedAtToMillis(value)).toBe(0);
  }
});

test("hierarchy accepts only finite device-authored numbers", () => {
  expect(hierarchyUpdatedAtToMillis(undefined)).toBeUndefined();
  for (const updatedAt of [undefined, NaN, Infinity, -Infinity, "1700000000000"]) {
    expect(hierarchyUpdatedAtToMillis({ updatedAt })).toBeUndefined();
  }
  for (const updatedAt of [0, -5, 1.25, 1700000000000]) {
    expect(hierarchyUpdatedAtToMillis({ updatedAt })).toBe(updatedAt);
  }
});
