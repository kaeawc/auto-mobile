import { describe, expect, test } from "bun:test";
import type { MutationValue } from "../../src/daemon/sessionBroker/mutations/types";
import { deviceToolMutations } from "../../src/server/deviceMutationAdapters";
import { withoutIdleResetOverlays } from "../../src/server/deviceMutationRecording";
import { RENDER_OVERLAYS } from "../../src/utils/ios-cmdline-tools/SimulatorRenderOverlays";

const SIMULATOR = { iosSimulator: true };
const isOverlayRow = (row: { key: string }) => row.key.startsWith("renderOverlay:");

function priorsFor(rows: readonly { key: string }[], on: readonly string[]): MutationValue[] {
  return rows.map((row) =>
    isOverlayRow(row)
      ? { state: "present", value: on.includes(row.key.replace("renderOverlay:", "")) }
      : { state: "absent" },
  );
}

describe("reset overlay rows are journaled only when an overlay is on (#19016)", () => {
  const resetRows = deviceToolMutations("displayConfig", { reset: true }, "ios", SIMULATOR);

  test("a reset that finds every overlay off journals no overlay row", () => {
    const kept = withoutIdleResetOverlays({ reset: true }, resetRows, priorsFor(resetRows, []));
    expect(kept.rows.some(isOverlayRow)).toBe(false);
    expect(kept.rows.length).toBeGreaterThan(0);
    expect(kept.rows).toHaveLength(kept.priors.length);
  });

  test("a reset that finds an overlay on journals every overlay row", () => {
    const kept = withoutIdleResetOverlays(
      { reset: true },
      resetRows,
      priorsFor(resetRows, ["blendedLayers"]),
    );
    expect(kept.rows.filter(isOverlayRow)).toHaveLength(RENDER_OVERLAYS.length);
  });

  test("a reset that cannot read the overlays journals none", () => {
    const unreadable: MutationValue[] = resetRows.map(() => ({ state: "unobservable" }));
    expect(
      withoutIdleResetOverlays({ reset: true }, resetRows, unreadable).rows.some(isOverlayRow),
    ).toBe(false);
  });

  test("an explicit request keeps its row even when the overlay is off", () => {
    const args = { renderOverlays: { blendedLayers: true } };
    const rows = deviceToolMutations("displayConfig", args, "ios", SIMULATOR);
    const kept = withoutIdleResetOverlays(args, rows, [{ state: "present", value: false }]);
    expect(kept.rows).toEqual(rows);
  });
});
