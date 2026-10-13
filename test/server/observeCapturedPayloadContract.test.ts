import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { CtrlProxyHierarchy } from "../../src/features/observe/android/CtrlProxyHierarchy";
import type {
  AccessibilityHierarchy,
  HierarchyDelegateContext,
} from "../../src/features/observe/android/types";
import { scopeObserveResultToLayer } from "../../src/features/observe/hierarchyLayer";
import { sanitizeObserveResult } from "../../src/features/observe/output/ObserveResultOutput";
import type { ObserveResult } from "../../src/models/ObserveResult";
import {
  observeResultSchema,
  observeToolResultSchema,
  observationSummarySchema,
  viewHierarchyResultSchema,
} from "../../src/server/toolOutputSchemas";
import { FakeTimer } from "../fakes/FakeTimer";
import { observationOf } from "../helpers/prototypeWindowCapture";

const fixtureRoot = resolve(import.meta.dir, "../fixtures");
const filesIn = (dir: string, suffix = ".json") =>
  readdirSync(resolve(fixtureRoot, dir))
    .filter((name) => name.endsWith(suffix))
    .map((name) => `${dir}/${name}`);
const androidFiles = [
  ...filesIn("android-launcher", ".json"),
  ...filesIn("android-overlay-window", ".raw.json"),
  ...filesIn("android-focus"),
  "android-enabled/playground-disabled-control-api36.json",
  "android-settings/open-by-default-radio-rows.observe.json",
  "identify-interactions/playground-text-fields.json",
];
// Load and parse immutable captured JSON once; conversion and projection remain inside each test.
const captures = [
  ...androidFiles,
  "observe/ios-fractional-bounds.json",
  "observe-output/ios-overlay-window/ios-floating-overlay-over-settings.raw.json",
].map((name) => ({
  name,
  platform: name.startsWith("observe") ? ("ios" as const) : ("android" as const),
  observation: JSON.parse(readFileSync(resolve(fixtureRoot, name), "utf8")) as ObserveResult,
}));
const wires = captures
  .filter(
    ({ name }) =>
      name.startsWith("android-overlay-window") ||
      name === "android-launcher/launcher-recents-emulator-5600.json",
  )
  .map(({ name, observation }) => ({
    name,
    wire: JSON.parse(observation.rawViewHierarchy!.json!) as AccessibilityHierarchy,
  }));
const subject = new CtrlProxyHierarchy({ timer: new FakeTimer() } as HierarchyDelegateContext);
const nonNullableKeys = Object.entries(viewHierarchyResultSchema.shape)
  .filter(([, schema]) => !schema.safeParse(null).success)
  .map(([key]) => key);
const windowKeys = Object.entries(
  viewHierarchyResultSchema.shape.windows.unwrap().unwrap().element.shape,
)
  .filter(([, schema]) => !schema.safeParse(null).success)
  .map(([key]) => key);
function assertContract(out: ObserveResult): void {
  const parsed = observeResultSchema.safeParse(out);
  expect(
    parsed.success,
    parsed.success
      ? ""
      : parsed.error.issues.map((issue) => `${issue.path.join("/")}: ${issue.message}`).join("\n"),
  ).toBe(true);
  const hierarchy = out.viewHierarchy;
  const nulls = hierarchy ? nonNullableKeys.filter((key) => hierarchy[key] === null) : [];
  for (const [index, window] of (hierarchy?.windows ?? []).entries()) {
    nulls.push(
      ...windowKeys.filter((key) => window[key] === null).map((key) => `windows/${index}/${key}`),
    );
  }
  expect(nulls).toEqual([]);
}
const modes = ["skeleton", "full", "raw"] as const;
const layers = [undefined, "app", "prototype"] as const;
for (const mode of modes) {
  for (const layer of layers) {
    describe(`${mode} / ${layer ?? "all layers"}`, () => {
      for (const { name, observation, platform } of captures) {
        test(`old host: ${name}`, () => {
          const originalReasons = observation.viewHierarchy?.truncationReasons;
          const scoped = scopeObserveResultToLayer(observation, layer, platform);
          const out = sanitizeObserveResult(scoped, {
            project: mode === "raw" ? "full" : mode,
            dropElements: true,
            compact: true,
          });
          assertContract(out);
          expect(observation.viewHierarchy?.truncationReasons).toBe(originalReasons);
        });
      }
      for (const { name, observation, platform } of captures.filter(
        ({ name }) =>
          name === "android-overlay-window/floating-overlay-over-button-elevated.raw.json" ||
          name === "observe-output/ios-overlay-window/ios-floating-overlay-over-settings.raw.json",
      )) {
        test(`per-display and embedded output: ${name}`, () => {
          const scoped = scopeObserveResultToLayer(observation, layer, platform);
          const out = sanitizeObserveResult(scoped, {
            project: mode === "raw" ? "full" : mode,
            dropElements: true,
            compact: true,
          });
          assertContract(out);
          // finalizeToolResponse sanitizes each display entry through this same boundary.
          const parsed = observeToolResultSchema.safeParse({ ...out, displays: [out] });
          expect(parsed.success, parsed.success ? "" : parsed.error.message).toBe(true);
          expect(observationSummarySchema.safeParse(out).success).toBe(true);
        });
      }
      for (const { name, wire } of wires) {
        test(`wire ingestion: ${name}`, () => {
          const hierarchy = subject.convertToViewHierarchyResult(wire);
          expect(Object.hasOwn(hierarchy, "truncationReasons")).toBe(false);
          const scoped = scopeObserveResultToLayer(observationOf(hierarchy), layer, "android");
          assertContract(
            sanitizeObserveResult(scoped, {
              project: mode === "raw" ? "full" : mode,
              dropElements: true,
              compact: true,
            }),
          );
        });
      }
    });
  }
}
test("captured truncation array survives full output and lifts into skeleton", () => {
  // Only reasons change: no committed capture currently advertises a device truncation.
  const hierarchy = subject.convertToViewHierarchyResult({
    ...wires[0].wire,
    truncationReasons: ["max_nodes"],
  });
  const observation = observationOf(hierarchy);
  expect(
    sanitizeObserveResult(observation, { project: "full", dropElements: true }).viewHierarchy
      ?.truncationReasons,
  ).toEqual(["max_nodes"]);
  expect(
    sanitizeObserveResult(observation, { project: "skeleton", dropElements: true })
      .truncationReasons,
  ).toEqual(["max_nodes"]);
});

test("rootless captured wire omits null optional objects and malformed reasons", () => {
  // Simulate the runner's optional-field sentinels on an otherwise captured payload.
  const wire = Object.assign(structuredClone(wires[0].wire), {
    hierarchy: undefined,
    systemInsets: null,
    insets: null,
    truncationReasons: "max_nodes",
  });
  for (const window of wire.windows ?? []) {
    Object.assign(window, { bounds: null, hierarchy: null });
  }
  const hierarchy = subject.convertToViewHierarchyResult(wire as AccessibilityHierarchy);
  for (const window of hierarchy.windows ?? []) {
    expect(Object.hasOwn(window, "bounds")).toBe(false);
    expect(Object.hasOwn(window, "hierarchy")).toBe(false);
  }
  for (const key of ["systemInsets", "insets", "truncationReasons"]) {
    expect(Object.hasOwn(hierarchy, key)).toBe(false);
  }
  assertContract(
    sanitizeObserveResult(observationOf(hierarchy), { project: "full", dropElements: true }),
  );
});

test("legacy captured output omits schema-declared null objects without mutating its source", () => {
  const source = structuredClone(captures[0].observation);
  const hierarchy = source.viewHierarchy!;
  // Exercise each declared object sentinel using the captured observation, never a synthetic tree.
  Object.assign(hierarchy, {
    hierarchy: null,
    "accessibility-focused-element": null,
    systemInsets: null,
    insets: null,
    truncationReasons: null,
  });
  for (const window of hierarchy.windows ?? []) {
    Object.assign(window, { bounds: null, hierarchy: null });
  }
  const before = JSON.stringify(source);
  const out = sanitizeObserveResult(source, { project: "full", dropElements: true });
  assertContract(out);
  expect(JSON.stringify(source)).toBe(before);
  for (const key of nonNullableKeys) {
    expect(Object.hasOwn(out.viewHierarchy!, key)).toBe(false);
  }
  for (const window of out.viewHierarchy!.windows ?? []) {
    expect(Object.hasOwn(window, "bounds")).toBe(false);
    expect(Object.hasOwn(window, "hierarchy")).toBe(false);
  }
});
