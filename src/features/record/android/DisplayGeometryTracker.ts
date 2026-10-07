import type { AdbExecutor } from "../../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { readWindowManagerRotation } from "../../../utils/android-cmdline-tools/readWindowManagerRotation";
import { errorMessage } from "../../../utils/describeUnknownError";
import { logger } from "../../../utils/logger";
import type { Timer } from "../../../utils/SystemTimer";
import { queryDisplaySize } from "./AxisRanges";
import type { DisplayChange } from "./types";
import type { DisplaySize, ScreenGeometryTimeline } from "./ScreenGeometryTimeline";

/** The default display: the one the touchscreen node discovered at start is mapped to. */
const PRIMARY_DISPLAY_ID = 0;
/**
 * Timeout for each adb read the tracker issues (`wm size`, and each of the two
 * WindowManager rotation commands). Without it the adb client's 15 s default would
 * apply to a stalled device. Stop-time reads are also raced against the recorder's
 * overall finalisation budget.
 */
export const GEOMETRY_READ_TIMEOUT_MS = 1_000;

/** Narrow read seam over the device for the timeline refresh; faked in tests. */
export interface DisplayGeometryProbe {
  /** 0-3, or null when WindowManager did not report a rotation. Rejects on failure. */
  readRotation(): Promise<number | null>;
  /** Physical size from `wm size`. Rejects on failure. */
  readPhysicalSize(): Promise<DisplaySize>;
}

export function createAdbGeometryProbe(adb: AdbExecutor): DisplayGeometryProbe {
  return {
    readRotation: () => readWindowManagerRotation(adb, { timeoutMs: GEOMETRY_READ_TIMEOUT_MS }),
    readPhysicalSize: () => queryDisplaySize(adb, { timeoutMs: GEOMETRY_READ_TIMEOUT_MS }),
  };
}

function isRotation(value: number | undefined): value is number {
  return value !== undefined && Number.isInteger(value) && value >= 0 && value <= 3;
}

/**
 * Feeds a `ScreenGeometryTimeline` from CtrlProxy's `display_transition` pushes,
 * which already reach the host for the whole recording (they carry the display's
 * rotation and real size). No polling: the device is read again only when a push
 * arrives, plus once at stop to catch a rotation that was never pushed.
 */
export class DisplayGeometryTracker {
  private refreshChain: Promise<void> = Promise.resolve();
  /** Bumped per accepted push; a refresh from an older push is superseded and discarded. */
  private generation = 0;

  constructor(
    readonly timeline: ScreenGeometryTimeline,
    private readonly probe: DisplayGeometryProbe,
    private readonly timer: Timer,
  ) {}

  handleTransition(event: DisplayChange): void {
    if (event.displayId !== PRIMARY_DISPLAY_ID || event.change === "removed") {
      return;
    }
    const at = this.timer.now();
    const generation = ++this.generation;
    this.timeline.noteChangeReported(at);
    // The push already carries the new rotation: apply it before any adb round trip.
    if (isRotation(event.rotation)) {
      this.timeline.apply({ rotation: event.rotation }, at);
    }
    const rotationKnown = isRotation(event.rotation);
    this.refreshChain = this.refreshChain.then(() => this.refresh(at, rotationKnown, generation));
  }

  /**
   * Resolves once every refresh started so far has been applied, including a
   * refresh a push queued while an earlier one was still being awaited.
   */
  async settle(): Promise<void> {
    let chain: Promise<void>;
    do {
      chain = this.refreshChain;
      await chain;
    } while (chain !== this.refreshChain);
  }

  /**
   * Cross-check the tracked rotation against the device once, at stop. Returns a
   * recording-level warning if they disagree (a rotation that was never pushed),
   * otherwise nothing. A read that fails or reports no rotation rejects, so the
   * caller can report the geometry as unconfirmed instead of silently trusting it.
   */
  async verifyAtStop(): Promise<string | undefined> {
    const actual = await this.probe.readRotation();
    if (actual === null) {
      throw new Error("WindowManager did not report a display rotation at stop");
    }
    const tracked = this.timeline.currentRotation;
    if (actual !== tracked) {
      return `display rotation at stop (${actual}) differs from the rotation tracked during recording (${tracked}); a rotation was not reported, so tapAt and swipeOn steps after it may be recorded at the wrong coordinates or direction`;
    }
    return undefined;
  }

  private async refresh(at: number, rotationKnown: boolean, generation: number): Promise<void> {
    if (generation !== this.generation) {
      // A newer push is queued behind this one and re-reads everything; applying this
      // older size now would briefly shadow the newer rotation with a stale geometry.
      return;
    }
    const rotation = rotationKnown ? undefined : await this.readRotationOrNull();
    const display = await this.readSizeOrNull();
    if (generation !== this.generation) {
      return;
    }
    this.timeline.apply({ rotation, display }, at);
  }

  private async readRotationOrNull(): Promise<number | null> {
    try {
      return await this.probe.readRotation();
    } catch (error) {
      logger.warn(
        `[DisplayGeometryTracker] Failed to read rotation after a display change: ${errorMessage(error)}`,
        error,
      );
      return null;
    }
  }

  private async readSizeOrNull(): Promise<DisplaySize | null> {
    try {
      return await this.probe.readPhysicalSize();
    } catch (error) {
      logger.warn(
        `[DisplayGeometryTracker] Failed to read display size after a display change: ${errorMessage(error)}`,
        error,
      );
      return null;
    }
  }
}
