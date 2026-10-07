import { describe, expect, test } from "bun:test";
import type { ViewHierarchyResult } from "../../../src/models";
import { ElementResolver } from "../../../src/features/utility/ElementResolver";
import { SearchableHierarchy } from "../../../src/features/utility/SearchableNode";

const base = "s2-0123456789abcdef";
const bounds = { left: 0, top: 0, right: 100, bottom: 100 };
const lower = { ...bounds, top: 120, bottom: 220 };
const snapshot = (nodes: unknown[]) => ({
  id: "capture",
  nodes: new SearchableHierarchy().project({
    hierarchy: { node: nodes },
  } as unknown as ViewHierarchyResult),
});
const resolver = new ElementResolver(() => 0);
const tap = { action: "tap" as const };

describe("ElementResolver synthetic id guards (#10476)", () => {
  test("a bare id shared by suffixed duplicates reports the textAny guidance error", () => {
    const capture = snapshot([
      { "view-id": `${base}-1`, bounds, clickable: true },
      { "view-id": `${base}-2`, bounds: lower, clickable: true },
    ]);
    const result = resolver.resolve(capture, { elementId: base }, tap);
    expect(result.chosen).toBeNull();
    expect(result.failureReason).toBe("ambiguous");
    expect(result.error).toContain("is ambiguous in the current capture: 2 elements share");
    expect(result.error).toContain("textAny");
    expect(result.error).toContain(`"${base}-1", "${base}-2"`);
    expect(resolver.resolve(capture, { elementId: `${base}-2` }, tap).chosen?.nodeKey).toBe(
      `${base}-2`,
    );
  });

  test("a legacy bare duplicate family returns the re-observe error, not a node", () => {
    const capture = snapshot([
      { "view-id": base, bounds, clickable: true },
      { "view-id": `${base}-2`, bounds: lower, clickable: true },
    ]);
    const result = resolver.resolve(capture, { elementId: base }, tap);
    expect(result.chosen).toBeNull();
    expect(result.error).toContain("legacy bare duplicate encoding");
  });

  test("a unique bare id and a real resource-id of the same shape still resolve", () => {
    expect(
      resolver.resolve(
        snapshot([{ "view-id": base, bounds, clickable: true }]),
        { elementId: base },
        tap,
      ).chosen?.nodeKey,
    ).toBe(base);
    const real = snapshot([
      { "resource-id": base, bounds, clickable: true },
      { "view-id": `${base}-1`, bounds: lower, clickable: true },
    ]);
    expect(resolver.resolve(real, { elementId: base }, tap).chosen?.nativeId).toBe(base);
  });

  test("an unscoped id on an actionless node stays a diagnostic candidate, never a tap target", () => {
    // Resolver semantics (owner decision on #10287): actionless candidates are
    // dropped from tap selection, so the finder's tap-the-bounds behaviour is not ported.
    const capture = snapshot([{ "resource-id": "label", text: "Info", bounds }]);
    expect(
      resolver.resolve(capture, { elementId: "label" }, { action: "inspect" }).chosen,
    ).not.toBeNull();
    const result = resolver.resolve(capture, { elementId: "label" }, tap);
    expect(result.chosen).toBeNull();
    expect(result.candidates).toHaveLength(0);
  });
});
