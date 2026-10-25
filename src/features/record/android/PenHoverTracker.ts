import type { GestureEvent, PointerToolType } from "./types";

interface Episode {
  /** The pen made contact with the screen at some point in the episode. */
  touched: boolean;
}

const hoverEvent = (toolType: PointerToolType, arrivedAt: number): GestureEvent => ({
  type: "hover",
  arrivedAt,
  toolType,
});

/**
 * Spots a pen that comes into range and leaves again without ever touching the screen. Hover is not
 * recorded, so each such episode is reported once, when it ends, for the recorder to warn about. A
 * pen that touches during the episode is an ordinary contact, and the hover around it is not a loss.
 *
 * A single-touch node has one episode, from the tool key going down to it coming up. A multitouch
 * node has one per slot, from the pen first reporting a hover distance to its tracking id ending.
 */
export class PenHoverTracker {
  private nodeEpisode: Episode | undefined;
  private readonly slotEpisodes = new Map<number, Episode>();

  /** An episode already open (a touch reported first, or a tool switch) is kept, not restarted. */
  penEntered(): void {
    this.nodeEpisode ??= { touched: false };
  }

  /** Drivers differ on whether the touch or the tool key comes first within one frame. */
  penTouched(): void {
    this.nodeEpisode ??= { touched: false };
    this.nodeEpisode.touched = true;
  }

  penLeft(toolType: PointerToolType, arrivedAt: number): GestureEvent | null {
    const episode = this.nodeEpisode;
    this.nodeEpisode = undefined;
    return episode && !episode.touched ? hoverEvent(toolType, arrivedAt) : null;
  }

  slotHovering(slotId: number): void {
    if (!this.slotEpisodes.has(slotId)) {
      this.slotEpisodes.set(slotId, { touched: false });
    }
  }

  slotTouching(slotId: number): void {
    this.slotEpisodes.set(slotId, { touched: true });
  }

  slotReleased(
    slotId: number,
    toolType: PointerToolType | undefined,
    arrivedAt: number,
  ): GestureEvent | null {
    const episode = this.slotEpisodes.get(slotId);
    this.slotEpisodes.delete(slotId);
    return episode && !episode.touched && toolType ? hoverEvent(toolType, arrivedAt) : null;
  }
}
