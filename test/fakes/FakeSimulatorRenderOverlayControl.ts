import {
  RENDER_OVERLAYS,
  type RenderOverlay,
  type RenderOverlayChange,
  type RenderOverlayValues,
  type SimulatorRenderOverlayControl,
} from "../../src/utils/ios-cmdline-tools/SimulatorRenderOverlays";

/** In-memory Simulator render overlays: every overlay starts off, as after a boot. */
export class FakeSimulatorRenderOverlayControl implements SimulatorRenderOverlayControl {
  readonly states = new Map<string, Record<RenderOverlay, boolean>>();
  readonly writes: Array<{ udid: string; values: RenderOverlayValues }> = [];
  readonly reads: string[] = [];
  failure?: Error;
  /** Overlays a write leaves unchanged, to model a write the Simulator does not adopt. */
  readonly stuck = new Set<RenderOverlay>();

  state(udid: string): Record<RenderOverlay, boolean> {
    return {
      ...(Object.fromEntries(RENDER_OVERLAYS.map((overlay) => [overlay, false])) as Record<
        RenderOverlay,
        boolean
      >),
      ...this.states.get(udid),
    };
  }

  async read(udid: string): Promise<Record<RenderOverlay, boolean>> {
    this.reads.push(udid);
    if (this.failure) {
      throw this.failure;
    }
    return this.state(udid);
  }

  async set(udid: string, values: RenderOverlayValues): Promise<RenderOverlayChange> {
    this.writes.push({ udid, values });
    if (this.failure) {
      throw this.failure;
    }
    const previous = this.state(udid);
    const applied = { ...previous };
    for (const overlay of RENDER_OVERLAYS) {
      const value = values[overlay];
      if (value !== undefined && !this.stuck.has(overlay)) {
        applied[overlay] = value;
      }
    }
    this.states.set(udid, applied);
    return { previous, applied };
  }
}
