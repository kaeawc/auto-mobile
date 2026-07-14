import { describe, expect, test } from "bun:test";
import { parseEventAllMarkersConfig } from "../../src/utils/eventAllMarkers";

describe("parseEventAllMarkersConfig", () => {
  test("returns an empty list when nothing is configured (feature off)", () => {
    expect(parseEventAllMarkersConfig([], {})).toEqual([]);
  });

  test("parses a comma-separated CLI value", () => {
    expect(parseEventAllMarkersConfig(["--event-all-markers", "@,/,#"], {})).toEqual(["@", "/", "#"]);
  });

  test("parses the --event-all-markers=<csv> form", () => {
    expect(parseEventAllMarkersConfig(["--event-all-markers=@,/,#"], {})).toEqual(["@", "/", "#"]);
  });

  test("trims whitespace and drops empty entries", () => {
    expect(parseEventAllMarkersConfig(["--event-all-markers", " @ , / , "], {})).toEqual(["@", "/"]);
  });

  test("falls back to the env var when no CLI flag is present", () => {
    expect(parseEventAllMarkersConfig([], { AUTOMOBILE_EVENT_ALL_MARKERS: "@,:" })).toEqual(["@", ":"]);
  });

  test("CLI flag wins over the env var", () => {
    expect(
      parseEventAllMarkersConfig(["--event-all-markers", "#"], { AUTOMOBILE_EVENT_ALL_MARKERS: "@" })
    ).toEqual(["#"]);
  });

  test("treats a following flag as a missing value", () => {
    expect(parseEventAllMarkersConfig(["--event-all-markers", "--other-flag"], {})).toEqual([]);
  });
});
