import { randomUUID } from "node:crypto";
import type { Timer } from "./SystemTimer";

export interface IdGenerator {
  next(): string;
}

export class NodeIdGenerator implements IdGenerator {
  next(): string {
    return randomUUID();
  }
}

export class CountingIdGenerator implements IdGenerator {
  private counter = 0;

  constructor(private readonly prefix: string = "id") {}

  next(): string {
    this.counter++;
    return `${this.prefix}-${this.counter}`;
  }

  reset(): void {
    this.counter = 0;
  }
}

export const defaultIdGenerator: IdGenerator = new NodeIdGenerator();

/**
 * Formats an identifier whose ordering should remain visible to operators while
 * its uniqueness comes from an injected generator. Keep the generator at the
 * boundary so unit tests can use CountingIdGenerator rather than time or
 * randomness.
 */
export function createTimestampedId(
  prefix: string,
  timer: Pick<Timer, "now">,
  idGenerator: IdGenerator = defaultIdGenerator,
): string {
  return `${prefix}_${timer.now()}_${idGenerator.next()}`;
}
