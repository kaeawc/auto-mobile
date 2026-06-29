export interface Random {
  next(): number;
  pick<T>(items: readonly T[]): T;
}

export class CryptoRandom implements Random {
  next(): number {
    const buffer = new Uint32Array(1);
    crypto.getRandomValues(buffer);
    return buffer[0]! / 0x1_0000_0000;
  }

  pick<T>(items: readonly T[]): T {
    return nextToPick(() => this.next(), items);
  }
}

export const defaultRandom: Random = new CryptoRandom();

const nextToPick = <T>(next: () => number, items: readonly T[]): T => {
  if (items.length === 0) {
    throw new Error("Random.pick cannot pick from an empty array");
  }
  return items[Math.floor(next() * items.length)]!;
};
