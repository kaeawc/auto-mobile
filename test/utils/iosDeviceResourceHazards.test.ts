import { expect, test } from "bun:test";
import {
  assertSafeResourceCombination,
  disabledResourcesOf,
  findUnsafeResourceCombinations,
  iosDeviceResourceHazards,
} from "../../src/utils/iosDeviceResourceHazards";
import { iosDeviceResourceCatalog } from "../../src/utils/iosDeviceResourceCatalog";
import { fakeIosDeviceResourceHazards as hazards } from "../helpers/fakeIosDeviceResourceHazards";

test("requires all disabled members, accepts supersets and deduplicates input", () => {
  expect(findUnsafeResourceCombinations(["calendarServices"], hazards, "post_boot")).toEqual([]);
  expect(
    findUnsafeResourceCombinations(
      ["calendarServices", "reminderServices", "calendarServices", "widgets"],
      hazards,
      "post_boot",
    ),
  ).toEqual([...hazards]);
  expect(findUnsafeResourceCombinations([], hazards, "post_boot")).toEqual([]);
});
test("extracts only explicitly disabled resources", () => {
  expect(
    disabledResourcesOf({
      calendarServices: "disabled",
      reminderServices: "enabled",
      widgets: undefined,
    }),
  ).toEqual(["calendarServices"]);
});
test("real hazards have distinct catalog keys and nonempty evidence", () => {
  for (const hazard of iosDeviceResourceHazards) {
    expect(hazard.reason.trim().length).toBeGreaterThan(0);
    expect(hazard.evidence.trim().length).toBeGreaterThan(0);
    expect(hazard.resources.length).toBeGreaterThan(0);
    expect(new Set(hazard.resources).size).toBe(hazard.resources.length);
    for (const resource of hazard.resources) {
      expect(Object.hasOwn(iosDeviceResourceCatalog, resource)).toBe(true);
    }
  }
});

test("phase filters fake and real hazards", () => {
  const preboot = hazards.map((hazard) => ({ ...hazard, appliesTo: ["preboot"] as const }));
  const disabled = ["calendarServices", "reminderServices"] as const;
  expect(findUnsafeResourceCombinations(disabled, preboot, "post_boot")).toEqual([]);
  expect(findUnsafeResourceCombinations(disabled, preboot, "preboot")).toEqual(preboot);
  expect(findUnsafeResourceCombinations(disabled, iosDeviceResourceHazards, "preboot")).toEqual([]);
  expect(
    findUnsafeResourceCombinations(disabled, iosDeviceResourceHazards, "post_boot"),
  ).toHaveLength(1);
});

test("assertion honors both phases with fake hazards", () => {
  const config = { calendarServices: "disabled", reminderServices: "disabled" } as const;
  for (const phase of ["post_boot", "preboot"] as const) {
    const scoped = hazards.map((hazard) => ({ ...hazard, appliesTo: [phase] }));
    expect(() => assertSafeResourceCombination(config, phase, scoped)).toThrow("fake-spin");
    expect(() =>
      assertSafeResourceCombination(config, phase === "preboot" ? "post_boot" : "preboot", scoped),
    ).not.toThrow();
  }
});
