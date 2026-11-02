import { GESTURE_THRESHOLDS } from "./types";
import type { GestureEvent, PointerToolType, TouchSlot, HoverSample } from "./types";

interface Episode {
  /** The pen made contact with the screen at some point in the episode. */
  touched: boolean;
  samples: HoverSample[];
}

const hoverEvent = (
  toolType: PointerToolType,
  arrivedAt: number,
  episode: Episode,
): GestureEvent => ({
  type: "hover",
  arrivedAt,
  toolType,
  ...(episode.samples.length ? { hover: episode.samples } : {}),
});

/**
 * Spots a pen that comes into range and leaves again without ever touching the screen. Each such episode
 * retains a bounded position/distance path and is reported once when it ends. A
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
    this.nodeEpisode ??= { touched: false, samples: [] };
  }

  /** Drivers differ on whether the touch or the tool key comes first within one frame. */
  penTouched(): void {
    this.nodeEpisode ??= { touched: false, samples: [] };
    this.nodeEpisode.touched = true;
  }

  penLeft(toolType: PointerToolType, arrivedAt: number): GestureEvent | null {
    const episode = this.nodeEpisode;
    this.nodeEpisode = undefined;
    return episode && !episode.touched ? hoverEvent(toolType, arrivedAt, episode) : null;
  }

  slotHovering(slotId: number, slot: TouchSlot, arrivedAt: number, kernelAtMs?: number): void {
    if (!this.slotEpisodes.has(slotId)) {
      this.slotEpisodes.set(slotId, { touched: false, samples: [] });
    }
    this.sample(this.slotEpisodes.get(slotId)!, slot, arrivedAt, kernelAtMs);
  }

  penHovering(slot: TouchSlot, arrivedAt: number, kernelAtMs?: number): void {
    if (this.nodeEpisode) {
      this.sample(this.nodeEpisode, slot, arrivedAt, kernelAtMs);
    }
  }

  private sample(episode: Episode, slot: TouchSlot, arrivedAt: number, kernelAtMs?: number): void {
    if (
      episode.touched ||
      !Number.isFinite(slot.x) ||
      !Number.isFinite(slot.y) ||
      slot.distance === undefined ||
      !Number.isFinite(slot.distance)
    ) {
      return;
    }
    if (episode.samples.length >= GESTURE_THRESHOLDS.PEN_MAX_SAMPLES) {
      episode.samples = episode.samples.filter((_, index) => index === 0 || index % 2 === 1);
    }
    episode.samples.push({
      x: slot.x,
      y: slot.y,
      distance: slot.distance,
      arrivedAt,
      ...(kernelAtMs === undefined ? {} : { kernelAtMs }),
    });
  }

  slotTouching(slotId: number): void {
    this.slotEpisodes.set(slotId, { touched: true, samples: [] });
  }

  slotReleased(
    slotId: number,
    toolType: PointerToolType | undefined,
    arrivedAt: number,
  ): GestureEvent | null {
    const episode = this.slotEpisodes.get(slotId);
    this.slotEpisodes.delete(slotId);
    return episode && !episode.touched && toolType
      ? hoverEvent(toolType, arrivedAt, episode)
      : null;
  }
}
