import type { Random } from "../../src/utils/Random";

/**
 * Deterministic {@link Random} test double. Lives under test/fakes because no
 * production code needs seedable randomness — only tests that want a repeatable
 * `next()`/`pick()` sequence (e.g. DefaultDeviceMatcher's RANDOM strategy).
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
