import {
  UNKNOWN_PROTOTYPE_EVENT_KIND,
  type PrototypeEvent,
  type PrototypeEventKind,
} from "../observe/android/ctrlProxyProtocol";

/** Maximum pending events per (session, device, prototype); overflow drops the oldest. */
export const PROTOTYPE_EVENT_BUFFER_CAPACITY = 64;
/** An event of a kind this host knows: the only ones buffered and returned by awaitEvent. */
export type DeliverablePrototypeEvent = PrototypeEvent & { kind: PrototypeEventKind };
export interface PrototypeEventFilter {
  afterSequence?: number;
  eventName?: string;
  kind?: PrototypeEventKind;
}

function isDeliverable(event: PrototypeEvent): event is DeliverablePrototypeEvent {
  return event.kind !== UNKNOWN_PROTOTYPE_EVENT_KIND;
}
export interface PrototypeEventCounts {
  pendingCount: number;
  lastSequence?: number;
  droppedCount: number;
}

/**
 * Destructive single-event delivery. Filters/cursors leave unmatched events pending.
 * The wire high-water rule drops even previously unseen late lower sequences; accepted
 * arrivals are therefore already ordered. Reconnects must reuse this buffer.
 */
export class PrototypeEventBuffer {
  private events: DeliverablePrototypeEvent[] = [];
  private lastSequence?: number;
  private droppedCount = 0;

  /**
   * Returns whether the event was buffered. A duplicate or late sequence is not. Neither is an
   * event of a kind this host does not know (a newer device): it only raises the high-water mark,
   * so the ledger stays in step with the device and nothing unreadable is handed to a waiter.
   */
  push(event: PrototypeEvent): boolean {
    if (this.lastSequence !== undefined && event.sequence <= this.lastSequence) {
      return false;
    }
    this.lastSequence = event.sequence;
    if (!isDeliverable(event)) {
      return false;
    }
    this.events.push(structuredClone(event));
    if (this.events.length > PROTOTYPE_EVENT_BUFFER_CAPACITY) {
      this.events.shift();
      this.droppedCount++;
    }
    return true;
  }

  /**
   * Raises the high-water mark to a sequence the device reported without sending the events, so a
   * later duplicate at or below it is rejected and status shows where the ledger stands.
   */
  advanceTo(sequence: number): void {
    if (this.lastSequence === undefined || sequence > this.lastSequence) {
      this.lastSequence = sequence;
    }
  }

  take(filter: PrototypeEventFilter): DeliverablePrototypeEvent | undefined {
    const index = this.events.findIndex(
      (event) =>
        event.sequence > (filter.afterSequence ?? -1) &&
        (filter.eventName === undefined || event.name === filter.eventName) &&
        (filter.kind === undefined || event.kind === filter.kind),
    );
    return index < 0 ? undefined : this.events.splice(index, 1)[0];
  }

  status(): PrototypeEventCounts {
    return {
      pendingCount: this.events.length,
      ...(this.lastSequence === undefined ? {} : { lastSequence: this.lastSequence }),
      droppedCount: this.droppedCount,
    };
  }

  /**
   * Begin a new sequence epoch (a fresh show): drop pending events and the high-water mark.
   * The cumulative dropped count is kept; it is documented as cumulative until dismiss/release.
   */
  startEpoch(): void {
    this.events = [];
    this.lastSequence = undefined;
  }

  /** Clear pending events, retaining the high-water mark for reconnect deduplication. */
  clear(): void {
    this.events = [];
  }
}
