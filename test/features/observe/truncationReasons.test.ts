import { createFlatNodeForTest } from "./flatHierarchyBuilders";
import { describe, expect, test } from "bun:test";
import {
  WINDOW_TRUNCATION_REASON_MEANINGS,
  normalizeWindowTruncationReasons,
  collectWindowTruncations,
  captureFidelityTruncationReasons,
  isHostOutputTruncationReason,
  normalizeHierarchyOptionalFields,
} from "../../../src/features/observe/truncationReasons";
import { isViewHierarchyResult } from "../../../src/models/ViewHierarchyResult";
import { SnapshotReferenceStore } from "../../../src/features/observe/SnapshotReferenceStore";
import { CountingIdGenerator } from "../../../src/utils/IdGenerator";
import { FakeTimer } from "../../fakes/FakeTimer";
import { buildObserveResult } from "../../helpers/observeFixture";

describe("hierarchy optional list normalization", () => {
  for (const fields of [{ windows: null }, {}, { windows: null, contentHiddenRegions: null }]) {
    test(`normalizes ${JSON.stringify(fields)} like empty lists for observe snapshots`, () => {
      const wire: unknown = {
        hierarchy: {},
        frameContext: "frame-1",
        nativeScale: 1,
        ...fields,
      };
      if (!isViewHierarchyResult(wire)) {
        throw new Error("Expected hierarchy wire fixture");
      }
      const normalized = normalizeHierarchyOptionalFields(wire);
      const emptyLists = normalizeHierarchyOptionalFields({
        hierarchy: {},
        frameContext: "frame-1",
        nativeScale: 1,
        windows: [],
        contentHiddenRegions: [],
      });
      expect(collectWindowTruncations(normalized.windows)).toEqual(
        collectWindowTruncations(emptyLists.windows),
      );
      const capture = (viewHierarchy: typeof normalized) => {
        const store = new SnapshotReferenceStore(new FakeTimer(), new CountingIdGenerator("ref"));
        return store.capture(
          "tv-device",
          buildObserveResult({
            updatedAt: 0,
            rotation: 0,
            screenSize: { width: 1920, height: 1080 },
            systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
            viewHierarchy,
          }),
        );
      };
      expect(capture(normalized)).toEqual(capture(emptyLists));
      expect(capture(normalized).status).toBe("captured");
      expect(normalized.windows).toBeUndefined();
      expect(normalized.contentHiddenRegions).toBeUndefined();
      expect(wire).toMatchObject(fields);
    });
  }
});

describe("window truncation vocabulary", () => {
  test("windowTruncations vocabulary maps the known capture codes to meanings", () => {
    expect(WINDOW_TRUNCATION_REASON_MEANINGS).toEqual({
      max_nodes: "This window's share of the node budget was exhausted.",
      max_depth: "The tree was deeper than the depth cap.",
      max_children: "A node had more children than the device's per-node child cap.",
      cancelled: "The capture was cancelled mid-walk.",
    });
  });

  test("device child cap remains a capture-fidelity reason distinct from the host output cap", () => {
    const reasons = ["max_children", "max_children[node kept 64 of 70]", "future_code"];
    expect(isHostOutputTruncationReason("max_children")).toBe(false);
    expect(isHostOutputTruncationReason(reasons[1])).toBe(true);
    expect(captureFidelityTruncationReasons(reasons)).toEqual(["max_children", "future_code"]);
    expect(normalizeWindowTruncationReasons([...reasons, "max_children"])).toEqual([
      "max_children",
      "future_code",
    ]);
    expect(collectWindowTruncations([{ id: 7, truncationReasons: reasons }])).toEqual([
      { windowId: 7, reasons: ["max_children", "future_code"] },
    ]);
  });

  test("windowTruncations normalization preserves unknown strings and order while discarding invalid entries", () => {
    expect(
      normalizeWindowTruncationReasons([
        "future_code",
        null,
        "max_nodes",
        "",
        42,
        "future_code",
        "max_depth",
        "cancelled",
        "max_children[node kept 64 of 70]",
        false,
      ]),
    ).toEqual(["future_code", "max_nodes", "max_depth", "cancelled"]);
    for (const reasons of [undefined, null, [], "max_nodes", {}]) {
      expect(normalizeWindowTruncationReasons(reasons)).toEqual([]);
    }
  });

  test("windowTruncations package attribution uses window or linked root metadata only", () => {
    // Metadata fakes exercise package lookup, not hierarchy parsing or root linking.
    expect(
      collectWindowTruncations([
        {
          id: 1,
          hierarchy: createFlatNodeForTest({ packageName: "com.example.root" }),
          truncationReasons: ["max_nodes"],
        },
        {
          id: 2,
          hierarchy: { $: { package: "com.example.wrapped" } },
          truncationReasons: ["cancelled"],
        },
        {
          id: 3,
          packageName: "com.example.window",
          hierarchy: createFlatNodeForTest({ packageName: "other" }),
          truncationReasons: ["max_depth"],
        },
        { id: 4, truncationReasons: ["future_code"] },
        { truncationReasons: ["max_nodes"] },
        { id: 5, truncationReasons: ["max_children[node kept 64 of 70]"] },
      ]),
    ).toEqual([
      { windowId: 1, package: "com.example.root", reasons: ["max_nodes"] },
      { windowId: 2, package: "com.example.wrapped", reasons: ["cancelled"] },
      { windowId: 3, package: "com.example.window", reasons: ["max_depth"] },
      { windowId: 4, reasons: ["future_code"] },
    ]);
    for (const windows of [undefined, null, []]) {
      expect(collectWindowTruncations(windows)).toBeUndefined();
    }
  });
});
