export interface Random {
  next(): number;
  int(min: number, max: number): number;
  bytes(count: number): Uint8Array;
  pick<T>(items: readonly T[]): T;
  shuffle<T>(items: readonly T[]): T[];
  uuid(): string;
}

export class CryptoRandom implements Random {
  next(): number {
    const buffer = new Uint32Array(1);
    crypto.getRandomValues(buffer);
    return buffer[0]! / 0x1_0000_0000;
  }

  int(min: number, max: number): number {
    return nextToInt(() => this.next(), min, max);
  }

  bytes(count: number): Uint8Array {
    const buffer = new Uint8Array(count);
    crypto.getRandomValues(buffer);
    return buffer;
  }

  pick<T>(items: readonly T[]): T {
    return nextToPick(() => this.next(), items);
  }

  shuffle<T>(items: readonly T[]): T[] {
    return nextToShuffle(() => this.next(), items);
  }

  uuid(): string {
    return crypto.randomUUID();
  }
}

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

  int(min: number, max: number): number {
    return nextToInt(() => this.next(), min, max);
  }

  bytes(count: number): Uint8Array {
    const bytes = new Uint8Array(count);
    for (let i = 0; i < count; i++) {
      bytes[i] = Math.floor(this.next() * 256);
    }
    return bytes;
  }

  pick<T>(items: readonly T[]): T {
    return nextToPick(() => this.next(), items);
  }

  shuffle<T>(items: readonly T[]): T[] {
    return nextToShuffle(() => this.next(), items);
  }

  uuid(): string {
    const bytes = this.bytes(16);
    bytes[6] = (bytes[6]! & 0x0f) | 0x40;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
  }
}

export const defaultRandom: Random = new CryptoRandom();

const normalizeSeed = (seed: number): number => (Math.floor(seed) >>> 0) || 1;

const assertIntRange = (min: number, max: number): void => {
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    throw new Error(`Random.int requires finite bounds, got ${min}..${max}`);
  }
  if (max < min) {
    throw new Error(`Random.int requires max >= min, got ${min}..${max}`);
  }
};

const nextToInt = (next: () => number, min: number, max: number): number => {
  assertIntRange(min, max);
  return Math.floor(next() * (max - min + 1)) + min;
};

const nextToPick = <T>(next: () => number, items: readonly T[]): T => {
  if (items.length === 0) {
    throw new Error("Random.pick cannot pick from an empty array");
  }
  return items[Math.floor(next() * items.length)]!;
};

const nextToShuffle = <T>(next: () => number, items: readonly T[]): T[] => {
  const copy = items.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    const value = copy[i]!;
    copy[i] = copy[j]!;
    copy[j] = value;
  }
  return copy;
};
