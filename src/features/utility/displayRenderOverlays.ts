import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import {
  OsascriptSimulatorRenderOverlayControl,
  RENDER_OVERLAYS,
  type RenderOverlay,
  type RenderOverlayValues,
  type SimulatorRenderOverlayControl,
} from "../../utils/ios-cmdline-tools/SimulatorRenderOverlays";
import { hasDisplayGeometryField } from "./AndroidDisplayGeometry";
import { requestedAccessibilityFields } from "./AccessibilityDisplayPreferences";
import type { DisplayConfigResult, SetDisplayConfigInput } from "./DisplayConfig";

export const RENDER_OVERLAYS_SIMULATOR_ONLY_ERROR =
  "renderOverlays are Core Animation debug overlays of the iOS Simulator; Android devices and " +
  "physical iOS devices have no equivalent control.";

/** Every overlay off: what reset writes, and the Simulator's state after boot. */
export const ALL_RENDER_OVERLAYS_OFF: Record<RenderOverlay, boolean> = Object.fromEntries(
  RENDER_OVERLAYS.map((overlay) => [overlay, false]),
) as Record<RenderOverlay, boolean>;

/** The displayConfig value field for the overlays (#19016): every overlay on or off. */
export interface RenderOverlayDisplayValues {
  renderOverlays?: Record<RenderOverlay, boolean>;
}

/** The displayConfig set field for the overlays: only the named ones change. */
export interface RenderOverlayDisplayInput {
  renderOverlays?: RenderOverlayValues;
}

/** True when the request names at least one overlay. */
export function hasRenderOverlayField(input: RenderOverlayDisplayInput): boolean {
  return RENDER_OVERLAYS.some((overlay) => input.renderOverlays?.[overlay] !== undefined);
}

/** True when a request without its overlays still sets something (or resets). */
function hasNonOverlayField(input: SetDisplayConfigInput): boolean {
  return (
    input.reset === true ||
    input.fontScale !== undefined ||
    input.density !== undefined ||
    input.theme !== undefined ||
    input.contentSize !== undefined ||
    hasDisplayGeometryField(input) ||
    requestedAccessibilityFields(input).length > 0
  );
}

interface RenderOverlayChange {
  previous?: Record<RenderOverlay, boolean>;
  applied?: Record<RenderOverlay, boolean>;
  errors: string[];
}

type DisplayIdentity = Pick<DisplayConfigResult, "deviceId" | "platform" | "supported">;

/**
 * The iOS Simulator's Core Animation render overlays inside displayConfig (#19016). Overlay writes
 * run after the other fields, and both are reported as one result.
 */
export class RenderOverlayDisplay {
  private readonly control: SimulatorRenderOverlayControl;

  constructor(
    private readonly identity: DisplayIdentity,
    private readonly simulator: boolean,
    control?: SimulatorRenderOverlayControl,
  ) {
    this.control = control ?? new OsascriptSimulatorRenderOverlayControl();
  }

  /** The overlays for a read. An unreadable state throws, so the read fails rather than omit it. */
  async read(): Promise<RenderOverlayDisplayValues> {
    return this.simulator
      ? { renderOverlays: await this.control.read(this.identity.deviceId) }
      : {};
  }

  /**
   * Apply `input`: the other fields through `setOthers`, then the named overlays (every overlay
   * off for a reset on a Simulator). A request without overlays goes straight to `setOthers`.
   */
  async set(
    input: SetDisplayConfigInput,
    setOthers: (input: SetDisplayConfigInput) => Promise<DisplayConfigResult>,
  ): Promise<DisplayConfigResult> {
    const named = hasRenderOverlayField(input);
    if (named && !this.simulator) {
      return { ...this.identity, success: false, error: RENDER_OVERLAYS_SIMULATOR_ONLY_ERROR };
    }
    const { renderOverlays: requested, ...rest } = input;
    if (!named && !(input.reset === true && this.simulator)) {
      return setOthers(rest);
    }
    const display = hasNonOverlayField(rest) ? await setOthers(rest) : undefined;
    if (display && !display.success && display.previous === undefined) {
      return display;
    }
    const target = input.reset === true ? ALL_RENDER_OVERLAYS_OFF : (requested ?? {});
    return this.merge(display, await this.apply(target));
  }

  /** Write `target` and verify each named overlay against the read-back. */
  private async apply(target: RenderOverlayValues): Promise<RenderOverlayChange> {
    const udid = this.identity.deviceId;
    try {
      const change = await this.control.set(udid, target);
      const errors = RENDER_OVERLAYS.filter(
        (overlay) => target[overlay] !== undefined && change.applied[overlay] !== target[overlay],
      ).map(
        (overlay) =>
          `Simulator render overlay ${overlay} read back ${change.applied[overlay] ? "on" : "off"} ` +
          `after requesting ${target[overlay] ? "on" : "off"}`,
      );
      return { previous: change.previous, applied: change.applied, errors };
    } catch (error) {
      logger.warn(
        `[DisplayConfig] render overlay write failed on ${udid}: ${errorMessage(error)}`,
        error,
      );
      return { errors: [`Setting Simulator render overlays failed: ${errorMessage(error)}`] };
    }
  }

  private merge(
    display: DisplayConfigResult | undefined,
    change: RenderOverlayChange,
  ): DisplayConfigResult {
    const errors = [...(display?.error ? [display.error] : []), ...change.errors];
    const error = errors.length > 0 ? errors.join("; ") : undefined;
    const message = error ?? display?.message;
    return {
      ...display,
      ...this.identity,
      ...(display ? { supported: display.supported } : {}),
      success: error === undefined,
      applied: { ...display?.applied, ...overlayValues(change.applied) },
      previous: { ...display?.previous, ...overlayValues(change.previous) },
      ...(error ? { error } : {}),
      ...(message === undefined ? {} : { message }),
    };
  }
}

function overlayValues(
  renderOverlays: Record<RenderOverlay, boolean> | undefined,
): RenderOverlayDisplayValues {
  return renderOverlays ? { renderOverlays } : {};
}
