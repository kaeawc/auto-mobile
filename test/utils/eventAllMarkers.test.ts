import { describe, expect, test } from "bun:test";
import {
  hasEventAllMarkersCliOverride,
  parseEventAllMarkersConfig,
} from "../../src/utils/eventAllMarkers";

describe("parseEventAllMarkersConfig", () => {
  test("returns an empty list when nothing is configured (feature off)", () => {
    expect(parseEventAllMarkersConfig([], {})).toEqual([]);
  });

  test("parses a comma-separated CLI value", () => {
    expect(parseEventAllMarkersConfig(["--event-all-markers", "@,/,#"], {})).toEqual([
      "@",
      "/",
      "#",
    ]);
  });

  test("parses the --event-all-markers=<csv> form", () => {
    expect(parseEventAllMarkersConfig(["--event-all-markers=@,/,#"], {})).toEqual(["@", "/", "#"]);
  });

  test("empty --event-all-markers= overrides the env var with no markers", () => {
    expect(
      parseEventAllMarkersConfig(["--event-all-markers="], { AUTOMOBILE_EVENT_ALL_MARKERS: "@" }),
    ).toEqual([]);
  });

  test("trims whitespace and drops empty entries", () => {
    expect(parseEventAllMarkersConfig(["--event-all-markers", " @ , / , "], {})).toEqual([
      "@",
      "/",
    ]);
  });

  test("falls back to the env var when no CLI flag is present", () => {
    expect(parseEventAllMarkersConfig([], { AUTOMOBILE_EVENT_ALL_MARKERS: "@,:" })).toEqual([
      "@",
      ":",
    ]);
  });

  test("CLI flag wins over the env var", () => {
    expect(
      parseEventAllMarkersConfig(["--event-all-markers", "#"], {
        AUTOMOBILE_EVENT_ALL_MARKERS: "@",
      }),
    ).toEqual(["#"]);
  });

  test("treats a following flag as a missing value", () => {
    expect(parseEventAllMarkersConfig(["--event-all-markers", "--other-flag"], {})).toEqual([]);
  });
});

describe("hasEventAllMarkersCliOverride", () => {
  test("detects inline values including an explicit empty override", () => {
    expect(hasEventAllMarkersCliOverride(["--event-all-markers="])).toBe(true);
    expect(hasEventAllMarkersCliOverride(["--event-all-markers=@"])).toBe(true);
  });

  test("detects space-separated values", () => {
    expect(hasEventAllMarkersCliOverride(["--event-all-markers", "@"])).toBe(true);
  });

  test("does not treat missing or flag-shaped values as overrides", () => {
    expect(hasEventAllMarkersCliOverride([])).toBe(false);
    expect(hasEventAllMarkersCliOverride(["--event-all-markers"])).toBe(false);
    expect(hasEventAllMarkersCliOverride(["--event-all-markers", "--debug"])).toBe(false);
  });
});
