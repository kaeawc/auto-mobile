import { describe, expect, test } from "bun:test";
import {
  isCapturedObservation,
  observeResultFromFixture,
  observeResultFromJsonText,
  viewHierarchyFromFixture,
} from "./observeFixture";
import androidHome from "../fixtures/android-launcher/launcher-home-emulator-5602.json";
import legacyScroll from "../fixtures/observe/diff/scroll-before.json";

describe("observeFixture", () => {
  test("accepts a captured Android observation", () => {
    expect(observeResultFromFixture(androidHome).viewHierarchy).toBeDefined();
  });

  test("round-trips an observation stored as JSON text", () => {
    const parsed = observeResultFromJsonText(JSON.stringify(androidHome), "home");
    expect(parsed.observationId).toBe(androidHome.observationId);
  });

  test("fills display and observationId for captures that predate them", () => {
    const filled = observeResultFromFixture(legacyScroll, "scroll");
    expect(filled.observationId).toBe("fixture-scroll");
    expect(filled.display.key).toBe("default");
  });

  test("accepts a captured hierarchy and rejects one without a hierarchy object", () => {
    expect(viewHierarchyFromFixture(androidHome.viewHierarchy).hierarchy).toBeDefined();
    expect(() => viewHierarchyFromFixture({ hierarchy: 3 }, "bad")).toThrow(
      "bad is not a captured ViewHierarchyResult",
    );
  });

  test("rejects non-observations and malformed hierarchies", () => {
    expect(isCapturedObservation(null)).toBe(false);
    expect(isCapturedObservation({ ...androidHome, updatedAt: "now" })).toBe(false);
    expect(isCapturedObservation({ ...androidHome, viewHierarchy: { hierarchy: 3 } })).toBe(false);
    expect(() => observeResultFromFixture({}, "empty")).toThrow("empty is not a captured");
  });
});
