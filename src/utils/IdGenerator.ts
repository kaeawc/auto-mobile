import { randomUUID } from "node:crypto";
import type { Timer } from "./SystemTimer";
export { CountingIdGenerator } from "./CountingIdGenerator";

export interface IdGenerator {
  next(): string;
}

export class NodeIdGenerator implements IdGenerator {
  next(): string {
    return randomUUID();
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
