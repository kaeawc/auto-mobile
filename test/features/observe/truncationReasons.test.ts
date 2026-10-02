import { describe, expect, test } from "bun:test";
import {
  WINDOW_TRUNCATION_REASON_MEANINGS,
  normalizeWindowTruncationReasons,
  collectWindowTruncations,
} from "../../../src/features/observe/truncationReasons";

describe("window truncation vocabulary", () => {
  test("windowTruncations vocabulary maps the three known capture codes to meanings", () => {
    expect(WINDOW_TRUNCATION_REASON_MEANINGS).toEqual({
      max_nodes: "This window's share of the node budget was exhausted.",
      max_depth: "The tree was deeper than the depth cap.",
      cancelled: "The capture was cancelled mid-walk.",
    });
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
        { id: 1, hierarchy: { packageName: "com.example.root" }, truncationReasons: ["max_nodes"] },
        {
          id: 2,
          hierarchy: { $: { package: "com.example.wrapped" } },
          truncationReasons: ["cancelled"],
        },
        {
          id: 3,
          packageName: "com.example.window",
          hierarchy: { packageName: "other" },
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
