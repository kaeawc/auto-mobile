import type { Random } from "./Random";

/**
 * Deterministic {@link Random} (mulberry32): the same seed always yields the same sequence, for
 * callers that must replay a run, such as a mock backend's seeded latency and faults. Not for
 * anything security-sensitive.
 */
export class SeededRandom implements Random {
  private state: number;

  constructor(seed: number = 1) {
    this.state = normalizeSeed(seed);
  }

  reseed(seed: number): void {
    this.state = normalizeSeed(seed);
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let value = this.state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) {
      throw new Error("Random.pick cannot pick from an empty array");
    }
    return items[Math.floor(this.next() * items.length)]!;
  }
}

const normalizeSeed = (seed: number): number => Math.floor(seed) >>> 0 || 1;
