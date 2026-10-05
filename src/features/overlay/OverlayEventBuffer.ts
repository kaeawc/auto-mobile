import type { OverlayEvent } from "../observe/android/ctrlProxyProtocol";

/** Maximum pending events per (session, device, overlay); overflow drops the oldest. */
export const OVERLAY_EVENT_BUFFER_CAPACITY = 64;
export interface OverlayEventFilter {
  afterSequence?: number;
  eventName?: string;
  kind?: OverlayEvent["kind"];
}
export interface OverlayEventCounts {
  pendingCount: number;
  lastSequence?: number;
  droppedCount: number;
}

/**
 * Destructive single-event delivery. Filters/cursors leave unmatched events pending.
 * The wire high-water rule drops even previously unseen late lower sequences; accepted
 * arrivals are therefore already ordered. Reconnects must reuse this buffer.
 */
export class OverlayEventBuffer {
  private events: OverlayEvent[] = [];
  private lastSequence?: number;
  private droppedCount = 0;

  push(event: OverlayEvent): boolean {
    if (this.lastSequence !== undefined && event.sequence <= this.lastSequence) {
      return false;
    }
    this.lastSequence = event.sequence;
    this.events.push(structuredClone(event));
    if (this.events.length > OVERLAY_EVENT_BUFFER_CAPACITY) {
      this.events.shift();
      this.droppedCount++;
    }
    return true;
  }

  take(filter: OverlayEventFilter): OverlayEvent | undefined {
    const index = this.events.findIndex(
      (event) =>
        event.sequence > (filter.afterSequence ?? -1) &&
        (filter.eventName === undefined || event.name === filter.eventName) &&
        (filter.kind === undefined || event.kind === filter.kind),
    );
    return index < 0 ? undefined : this.events.splice(index, 1)[0];
  }

  status(): OverlayEventCounts {
    return {
      pendingCount: this.events.length,
      ...(this.lastSequence === undefined ? {} : { lastSequence: this.lastSequence }),
      droppedCount: this.droppedCount,
    };
  }

  /** Clear pending events, retaining the high-water mark for reconnect deduplication. */
  clear(): void {
    this.events = [];
  }
}
