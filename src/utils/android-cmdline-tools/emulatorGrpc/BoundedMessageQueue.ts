/** How a queue holds back its producer: pause when full, resume once drained below the low mark. */
export interface MessageFlow {
  pause(): void;
  resume(): void;
}

/** Messages held before the producer is paused; one streamed audio packet is ~20 ms. */
export const MESSAGE_QUEUE_HIGH_WATER = 64;
/** Messages left when the producer is resumed. */
export const MESSAGE_QUEUE_LOW_WATER = 16;

/**
 * Decoded messages waiting for a reader. It pauses the producer at the high mark and resumes it at
 * the low mark, so a slow reader bounds memory instead of letting the network fill the queue.
 */
export class BoundedMessageQueue {
  private readonly messages: Uint8Array[] = [];
  private paused = false;

  constructor(
    private readonly flow: MessageFlow,
    private readonly highWater = MESSAGE_QUEUE_HIGH_WATER,
    private readonly lowWater = MESSAGE_QUEUE_LOW_WATER,
  ) {}

  push(messages: Uint8Array[]): void {
    this.messages.push(...messages);
    if (!this.paused && this.messages.length >= this.highWater) {
      this.paused = true;
      this.flow.pause();
    }
  }

  shift(): Uint8Array | undefined {
    const next = this.messages.shift();
    if (this.paused && this.messages.length <= this.lowWater) {
      this.paused = false;
      this.flow.resume();
    }
    return next;
  }
}
