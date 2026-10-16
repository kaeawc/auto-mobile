import { buildScaler, type CoordScaler, type TimedCoordScaler } from "./AxisRanges";

/**
 * How far either side of a gesture a reported display change makes that gesture
 * ambiguous (#10174). It is a bracket built from named terms, not a measured
 * latency: the device debounces display callbacks by `TRANSITION_DEBOUNCE_MS = 100`
 * (`RotationProvenanceTracker.kt`), then the push is launched on the service scope,
 * crosses the WebSocket and waits for the host event loop. 500 ms is that 100 ms
 * debounce plus a 400 ms transport allowance; issue #9142 measured 222-361 ms
 * touch-up to host receipt for accessibility events (debounce and WebSocket hop
 * included), so the allowance is above that observation, but no measurement of
 * `display_transition` pushes exists. A touch started in the gap is classified with the
 * previous rotation. The same window, before the gesture, covers a geometry refresh
 * that was still in flight when the touch began. A push later than this window is
 * not labelled here; the stop-time cross-check (`DisplayGeometryTracker.verifyAtStop`)
 * is the backstop for it.
 */
export const GEOMETRY_SETTLE_MS = 500;

export interface TouchAxes {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
}

/** Physical (unrotated) display size, as `wm size` reports it. */
export interface DisplaySize {
  width: number;
  height: number;
}

interface GeometrySample {
  /** 0=portrait, 1=landscape90, 2=reverse-portrait, 3=landscape270 */
  rotation: number;
  display: DisplaySize;
}

/**
 * What a refresh learned. `undefined` means "not re-read, keep the previous
 * value"; `null` means "re-read and failed", which keeps the previous value but
 * marks the entry as unreliable.
 */
export interface GeometryUpdate {
  rotation?: number | null;
  display?: DisplaySize | null;
}

interface GeometryEntry extends GeometrySample {
  reportedAt: number;
  caveats: readonly string[];
  scaler: CoordScaler;
}

export const ROTATION_UNKNOWN_CAVEAT =
  "display rotation could not be read; touch coordinates and swipe directions may be mapped with the wrong rotation";
export const SIZE_UNKNOWN_CAVEAT =
  "display size could not be read after a display change; touch coordinates may be scaled with the wrong size";

/**
 * What the foldable captures show (emulator-5602, test/fixtures/android-touch-node/):
 * `getevent -p` lists the same 11 touch nodes with the same 0..32767 axis ranges in the
 * opened (2076x2152) and closed (1080x2364) postures, so the raw range never changes and
 * only the display size moves the mapped pixels. `dumpsys input` shows the closed posture
 * also enabling `virtio_input_multi_touch_7` (a second node on the cover panel's
 * viewport), which `getevent -p` cannot reveal. A recording reads only the node chosen
 * when it started, so the caveat stays: after a size change this recording may be
 * mapping, or missing, touches that belong to the other panel.
 */
function panelChangedCaveat(from: DisplaySize, to: DisplaySize): string {
  return `display size changed from ${from.width}x${from.height} to ${to.width}x${to.height} (fold/unfold?); touches are still read from the touch node chosen when recording started, so coordinates may refer to a different panel`;
}

/**
 * Timeline of the screen geometry (rotation and display size) a recording has
 * seen, so each touch is mapped with the geometry in force when it started.
 *
 * Clock: every time here is host time from the recorder's injected `Timer`, the
 * same clock `GetEventReader` stamps frames with (`RawTouchFrame.arrivedAt` is
 * when the line was read; the device's monotonic `[ seconds ]` stamp in getevent
 * output is deliberately unused). A display change is stamped when its push
 * arrives. The lag between the real rotation and that arrival is not measured;
 * `GEOMETRY_SETTLE_MS` brackets it and affected gestures carry a warning.
 */
export class ScreenGeometryTimeline implements TimedCoordScaler {
  private readonly entries: GeometryEntry[];
  private readonly changeReports: number[] = [];
  private readonly baselineDisplay: DisplaySize;

  constructor(
    private readonly axes: TouchAxes,
    initial: GeometrySample,
    startedAt: number,
    startCaveats: readonly string[] = [],
  ) {
    this.baselineDisplay = initial.display;
    this.entries = [this.entry(initial, startedAt, startCaveats)];
  }

  scalerAt(time: number): CoordScaler {
    return this.entryAt(time).scaler;
  }

  /** Latest rotation the timeline holds, used to cross-check at stop. */
  get currentRotation(): number {
    return this.entries[this.entries.length - 1].rotation;
  }

  /**
   * When the latest entry free of caveats took effect (the start entry if none is).
   * A rotation the device never pushed can have happened any time after it, so a
   * stop-time mismatch makes touches from here on suspect.
   */
  get lastKnownGoodAt(): number {
    for (let index = this.entries.length - 1; index >= 0; index--) {
      if (this.entries[index].caveats.length === 0) {
        return this.entries[index].reportedAt;
      }
    }
    return this.entries[0].reportedAt;
  }

  /** A display change push arrived; the geometry refresh for it may still be in flight. */
  noteChangeReported(at: number): void {
    this.changeReports.push(at);
  }

  /** Append a new entry derived from the latest one, effective from `reportedAt`. */
  apply(update: GeometryUpdate, reportedAt: number): void {
    const previous = this.entries[this.entries.length - 1];
    const caveats: string[] = [];
    if (update.rotation === null) {
      caveats.push(ROTATION_UNKNOWN_CAVEAT);
    }
    if (update.display === null) {
      caveats.push(SIZE_UNKNOWN_CAVEAT);
    }
    const sample: GeometrySample = {
      rotation: update.rotation ?? previous.rotation,
      display: update.display ?? previous.display,
    };
    if (
      sample.display.width !== this.baselineDisplay.width ||
      sample.display.height !== this.baselineDisplay.height
    ) {
      caveats.push(panelChangedCaveat(this.baselineDisplay, sample.display));
    }
    // Overlapping refreshes complete in order, but never let an entry predate the last.
    this.entries.push(this.entry(sample, Math.max(reportedAt, previous.reportedAt), caveats));
  }

  /**
   * Warnings for a touch that started at `downAt` and ended at `upAt`. Call this
   * after the recording has had time to receive late display pushes.
   */
  warningsFor(downAt: number, upAt: number): string[] {
    const warnings = new Set(this.entryAt(downAt).caveats);
    const spans = this.changeReports.some((at) => at > downAt && at <= upAt);
    if (spans) {
      warnings.add(
        "gesture spans a display rotation/size change; its coordinates and direction mix two geometries",
      );
    } else if (
      this.changeReports.some(
        (at) => at >= downAt - GEOMETRY_SETTLE_MS && at <= upAt + GEOMETRY_SETTLE_MS,
      )
    ) {
      warnings.add(
        `display rotation/size changed within ${GEOMETRY_SETTLE_MS} ms of this gesture; its coordinates or direction may use a stale rotation`,
      );
    }
    return [...warnings];
  }

  private entryAt(time: number): GeometryEntry {
    let found = this.entries[0];
    for (const candidate of this.entries) {
      if (candidate.reportedAt > time) {
        break;
      }
      found = candidate;
    }
    return found;
  }

  private entry(
    sample: GeometrySample,
    reportedAt: number,
    caveats: readonly string[],
  ): GeometryEntry {
    return {
      ...sample,
      reportedAt,
      caveats,
      scaler: buildScaler({
        ...this.axes,
        displayWidth: sample.display.width,
        displayHeight: sample.display.height,
        rotation: sample.rotation,
      }),
    };
  }
}
