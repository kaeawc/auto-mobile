import { describe, expect, test } from "bun:test";
import { buildPenSampleStep } from "../../../../src/features/record/android/penSampleStep";
import { strokeRequest } from "../../../../src/features/action/pointer/richStylus";
import { dragPathSchema } from "../../../../src/server/dragPathTool";
import type { GestureEvent } from "../../../../src/features/record/android/types";
import { DRAG_PATH_MAX_TOTAL_MS } from "../../../../src/features/action/dragPathPlan";
import { exportLossWarning } from "../../../../src/features/record/android/penExportWarnings";

function stroke(): GestureEvent {
  return {
    type: "stroke",
    toolType: "stylus",
    arrivedAt: 100,
    pressure: { min: 0.2, max: 0.8, mean: 0.5, normalized: true },
    path: [
      { x: 10, y: 20, pressure: 0.2, arrivedAt: 0 },
      { x: 30, y: 40, pressure: 0.8, arrivedAt: 100 },
    ],
  };
}

describe("sampled pen plan export", () => {
  test("preserves tilt and held barrel buttons alongside per-point pressure", () => {
    const step = buildPenSampleStep({
      ...stroke(),
      tilt: 0.55,
      buttons: ["stylusPrimary", "stylusSecondary"],
    });
    expect(step?.params.pointer).toEqual({
      toolType: "stylus",
      pressure: 0.5,
      tilt: 0.55,
      buttons: ["primary", "secondary"],
    });
    const params = dragPathSchema.parse(step?.params);
    const request = strokeRequest(params.pointer!, params.points, { path: true });
    expect(request.points.map((point) => point.pressure)).toEqual([0.2, 0.8]);
    expect(request.points.map((point) => point.tilt)).toEqual([0.55, 0.55]);
    expect(request.buttons).toBe(96);
  });

  test("keeps eraser strokes outside the sampled stylus exporter", () => {
    expect(buildPenSampleStep({ ...stroke(), toolType: "eraser" })).toBeNull();
  });

  test("uses kernel timestamps 100 ms apart when samples arrive together", () => {
    const path = [
      { x: 10, y: 20, pressure: 0.2, arrivedAt: 500, kernelAtMs: 78826389.007 },
      { x: 30, y: 40, pressure: 0.8, arrivedAt: 500, kernelAtMs: 78826489.007 },
    ];
    expect(buildPenSampleStep({ ...stroke(), path })?.params.points).toEqual([
      { x: 10, y: 20, pressure: 0.2 },
      { x: 30, y: 40, pressure: 0.8, durationMs: 100 },
    ]);
  });

  test("falls back to arrival deltas when either kernel timestamp is absent", () => {
    const path = [
      { x: 10, y: 20, pressure: 0.2, arrivedAt: 0, kernelAtMs: 80000 },
      { x: 30, y: 40, pressure: 0.5, arrivedAt: 125 },
      { x: 50, y: 60, pressure: 0.8, arrivedAt: 275, kernelAtMs: 90000 },
    ];
    expect(buildPenSampleStep({ ...stroke(), path })?.params.points).toEqual([
      { x: 10, y: 20, pressure: 0.2 },
      { x: 30, y: 40, pressure: 0.5, durationMs: 125 },
      { x: 50, y: 60, pressure: 0.8, durationMs: 150 },
    ]);
  });

  test("drops 31 samples one second apart rather than exporting a 30 second stroke", () => {
    const path = Array.from({ length: 31 }, (_, index) => ({
      x: index,
      y: 20,
      pressure: index / 30,
      arrivedAt: index * 1000,
    }));
    expect(buildPenSampleStep({ ...stroke(), path })).toBeNull();
  });

  test("exports a stroke exactly at the replay duration limit", () => {
    const path = Array.from({ length: 21 }, (_, index) => ({
      x: index,
      y: 20,
      pressure: index / 20,
      arrivedAt: 500,
      kernelAtMs: 100000 + index * (DRAG_PATH_MAX_TOTAL_MS / 20),
    }));
    const step = buildPenSampleStep({ ...stroke(), path });
    expect(step?.tool).toBe("dragPath");
    expect(dragPathSchema.safeParse(step?.params).success).toBe(true);
    expect(exportLossWarning({ ...stroke(), path }, step)).toBeUndefined();
  });

  test("checks the aggregate of clamped exported segments", () => {
    const path = Array.from({ length: 5 }, (_, index) => ({
      x: index,
      y: 20,
      pressure: index / 4,
      arrivedAt: index * 10000,
    }));
    const step = buildPenSampleStep({ ...stroke(), path });
    const params = dragPathSchema.parse(step?.params);
    expect(params.points.slice(1).map((point) => point.durationMs)).toEqual([
      5000, 5000, 5000, 5000,
    ]);
  });

  test.each([0, -100])("clamps a %i ms kernel delta to the minimum segment duration", (delta) => {
    const path = [
      { x: 10, y: 20, pressure: 0.2, arrivedAt: 0, kernelAtMs: 1000 },
      { x: 30, y: 40, pressure: 0.8, arrivedAt: 100, kernelAtMs: 1000 + delta },
    ];
    const params = dragPathSchema.parse(buildPenSampleStep({ ...stroke(), path })?.params);
    expect(params.points[1].durationMs).toBe(1);
  });

  test("a stroke without a known path retains its existing warning", () => {
    const gesture = { ...stroke(), path: undefined };
    expect(exportLossWarning(gesture, buildPenSampleStep(gesture))).toContain(
      "without a known position or path",
    );
  });

  test("warns about the replay duration limit instead of claiming the path is unknown", () => {
    const gesture = {
      ...stroke(),
      path: Array.from({ length: 31 }, (_, index) => ({
        x: index,
        y: 20,
        pressure: index / 30,
        arrivedAt: 500,
        kernelAtMs: 100000 + index * 1000,
      })),
    };
    const warning = exportLossWarning(gesture, buildPenSampleStep(gesture));
    expect(warning).toContain(`${DRAG_PATH_MAX_TOTAL_MS / 1000} second`);
    expect(warning).toContain("not exported");
    expect(warning).not.toContain("without a known position or path");
  });
});
