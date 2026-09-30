import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import type { Random } from "../../../src/utils/Random";
import { ViewHierarchy } from "../../../src/features/observe/ViewHierarchy";
import { sanitizeObserveResult } from "../../../src/features/observe/output/ObserveResultOutput";
import { CtrlProxyHierarchy } from "../../../src/features/observe/ios/CtrlProxyHierarchy";
import { cleanupIosXCTestHierarchy } from "../../../src/features/observe/ios/cleanupIosHierarchy";
import { SeededRandom } from "../../fakes/SeededRandom";

const RUN_OPTIONS = { seed: 1_234_567, numRuns: 80 } as const;

const CORE_KEYS = [
  "text",
  "resource-id",
  "content-desc",
  "bounds",
  "clickable",
  "focusable",
  "hint-text",
  "value",
] as const;

const VALUES: readonly unknown[] = ["", " ", "true", "false", "label", true, false, null];

const SHARED_KEYS = [
  "text",
  "resource-id",
  "content-desc",
  "bounds",
  "clickable",
  "focusable",
  "enabled",
  "checked",
  "selected",
  "hint-text",
] as const;

// These are intentional policy differences in the current implementations.
// The table is kept next to the differential assertion so expanding its key
// set requires an explicit decision about each known divergence.
const DOCUMENTED_DIFFERENCES = [
  {
    key: "unknown-attribute",
    attrKey: "unknown-attribute",
    policy: "ViewHierarchy uses an allow-list; the other three retain unknown attributes.",
    attrs: { "unknown-attribute": "kept" },
    survives: [false, true, true, true],
  },
  {
    key: "null-value",
    attrKey: "text",
    policy:
      "CtrlProxy cleanAttributes removes null; cleanupIosHierarchy preserves it. Both Android passes also preserve it.",
    attrs: { text: null },
    survives: [true, true, false, true],
  },
  {
    key: "false-string-on-non-boolean",
    attrKey: "text",
    policy:
      "ViewHierarchy drops string 'false' for every allowed key; output trim and iOS cleaners only drop it for known boolean keys.",
    attrs: { text: "false" },
    survives: [false, true, true, true],
  },
  {
    key: "enabled-default-true",
    attrKey: "enabled",
    policy:
      "The structural iOS cleanup pass preserves attributes; the other cleaners omit enabled=true as the default.",
    attrs: { enabled: "true" },
    survives: [false, false, false, true],
  },
  {
    key: "known-boolean-default-false",
    attrKey: "clickable",
    policy:
      "The structural iOS cleanup pass preserves attributes; the other cleaners omit clickable=false as the default.",
    attrs: { clickable: "false" },
    survives: [false, false, false, true],
  },
] as const;

function generatedAttrs(random: Random): Record<string, unknown> {
  const attrs: Record<string, unknown> = {};
  for (const key of [...SHARED_KEYS, "className", "hint-text", "value", "package"]) {
    if (random.next() < 0.72) {
      attrs[key] =
        key === "bounds" ? { left: 0, top: 1, right: 2, bottom: 3 } : random.pick(VALUES);
    }
  }
  // Exercise the enabled default and duplicate-view-id rule in generated cases.
  if (random.next() < 0.5) {
    attrs.enabled = random.pick([true, false, "true", "false"]);
  }
  return attrs;
}

const viewCleaner = Object.create(ViewHierarchy.prototype) as ViewHierarchy;
const ctrlCleaner = new CtrlProxyHierarchy({} as never) as unknown as {
  cleanAttributes(attrs: Record<string, unknown>): Record<string, unknown>;
  filterHierarchyNode(
    node: { $: Record<string, unknown>; node?: { $: Record<string, unknown> }[] },
    isRoot?: boolean,
  ): { $: Record<string, unknown> } | null;
};

function cleanAndroidNode(attrs: Record<string, unknown>): Record<string, unknown> {
  return viewCleaner.cleanNodeProperties({ $: { ...attrs } });
}

function trimOutputNode(attrs: Record<string, unknown>): Record<string, unknown> {
  const result = sanitizeObserveResult(
    { viewHierarchy: { hierarchy: { node: { ...attrs } } } } as never,
    { dropElements: false, project: "full" },
  );
  return result.viewHierarchy!.hierarchy!.node as unknown as Record<string, unknown>;
}

function cleanCtrlProxyNode(attrs: Record<string, unknown>): Record<string, unknown> {
  return ctrlCleaner.filterHierarchyNode({ $: { ...attrs } }, true)?.$ ?? {};
}

function cleanIosNode(attrs: Record<string, unknown>): Record<string, unknown> {
  const result = cleanupIosXCTestHierarchy({ hierarchy: { ...attrs } });
  return result.hierarchy as Record<string, unknown>;
}

function cleanerOutputs(attrs: Record<string, unknown>): Record<string, Record<string, unknown>> {
  return {
    viewHierarchy: cleanAndroidNode(attrs),
    outputTrim: trimOutputNode(attrs),
    ctrlProxyIos: cleanCtrlProxyNode(attrs),
    cleanupIos: cleanIosNode(attrs),
  };
}

describe("observe node cleaners (property-based)", () => {
  test("each node cleaner is idempotent for seeded generated attributes", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 0xffff_ffff }), (caseSeed) => {
        const attrs = generatedAttrs(new SeededRandom(caseSeed));
        const once = cleanerOutputs(attrs);
        const twice = {
          viewHierarchy: cleanAndroidNode(once.viewHierarchy),
          outputTrim: trimOutputNode(once.outputTrim),
          ctrlProxyIos: cleanCtrlProxyNode(once.ctrlProxyIos),
          cleanupIos: cleanIosNode(once.cleanupIos),
        };
        expect(twice).toEqual(once);
      }),
      RUN_OPTIONS,
    );
  });

  test("the four cleaners agree on shared non-empty, non-default attributes", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 0xffff_ffff }), (caseSeed) => {
        const attrs = generatedAttrs(new SeededRandom(caseSeed));
        const outputs = cleanerOutputs(attrs);
        for (const key of SHARED_KEYS) {
          const value = attrs[key];
          if (value === undefined || value === "" || value === null) {
            continue;
          }
          if (key === "enabled" && (value === true || value === "true")) {
            continue;
          }
          if (value === false || value === "false") {
            continue;
          }
          const presence = Object.values(outputs).map((cleaned) => key in cleaned);
          expect(presence, `attribute ${key} in ${JSON.stringify(attrs)}`).toEqual([
            presence[0],
            presence[0],
            presence[0],
            presence[0],
          ]);
        }
      }),
      RUN_OPTIONS,
    );
  });

  test("resolver attributes with meaningful values survive cleaning", () => {
    const attrs: Record<string, unknown> = {
      text: "Save",
      "resource-id": "app:id/save",
      "content-desc": "Save",
      bounds: { left: 1, top: 2, right: 3, bottom: 4 },
      className: "UIButton",
      clickable: "true",
      focusable: "true",
      "hint-text": "Save draft",
      value: "draft",
    };
    const outputs = cleanerOutputs(attrs);
    for (const key of CORE_KEYS) {
      expect(outputs.outputTrim[key]).toEqual(attrs[key]);
      expect(outputs.ctrlProxyIos[key]).toEqual(attrs[key]);
      expect(outputs.cleanupIos[key]).toEqual(attrs[key]);
    }
    for (const key of CORE_KEYS.filter(
      (candidate) => candidate !== "className" && candidate !== "value",
    )) {
      expect(outputs.viewHierarchy[key]).toEqual(attrs[key]);
    }
    expect(outputs.ctrlProxyIos.value).toEqual(attrs.value);
    expect(outputs.cleanupIos.value).toEqual(attrs.value);
  });

  test.todo("#6479: ViewHierarchy.cleanNodeProperties currently drops className", () => {
    expect(cleanAndroidNode({ className: "UIButton" })).toEqual({ className: "UIButton" });
  });

  test.todo("#6479: CtrlProxy cleanAttributes drops explicit enabled=false", () => {
    expect(cleanCtrlProxyNode({ enabled: "false" }).enabled).toBe("false");
  });

  test("matches the documented policy-difference table", () => {
    for (const difference of DOCUMENTED_DIFFERENCES) {
      const actual = Object.values(cleanerOutputs(difference.attrs)).map(
        (cleaned) => difference.attrKey in cleaned,
      );
      expect(actual, difference.policy).toEqual(difference.survives);
    }
  });
});
