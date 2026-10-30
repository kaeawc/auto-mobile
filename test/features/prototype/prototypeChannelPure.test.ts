import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  PROTOTYPE_CHANNEL_DEFAULT_RECONNECT,
  prototypeChannelBackoffDelay,
  type PrototypeChannelReconnect,
} from "../../../src/features/prototype/prototypeChannelBackoff";
import {
  coalescePrototypeChannelFrames,
  type PrototypeChannelFrameActions,
} from "../../../src/features/prototype/prototypeChannelCoalesce";
import { PROTOTYPE_CHANNEL_FLUSH_MS } from "../../../src/features/prototype/prototypeChannelLimits";
import { prototypeSpecSchema } from "../../../src/features/prototype/prototypeSpec";
import type { Random } from "../../../src/utils/Random";
const realtime = path.resolve(import.meta.dir, "../../fixtures/prototype-spec/realtime");
const read = (name: string) => JSON.parse(readFileSync(path.join(realtime, name), "utf8"));

/** A fixed random sequence, cycled; the shared vectors pin this exact consumption order. */
class SequenceRandom implements Random {
  private index = 0;
  constructor(private readonly values: readonly number[]) {}
  next(): number {
    return this.values[this.index++ % this.values.length]!;
  }
  pick<T>(items: readonly T[]): T {
    return items[0]!;
  }
}

describe("reconnect backoff (shared vectors)", () => {
  const vectors: {
    cases: {
      name: string;
      reconnect: PrototypeChannelReconnect;
      randoms: number[];
      expected: { attempt: number; delayMs: number | null }[];
    }[];
  } = read("backoff.json");

  for (const vector of vectors.cases) {
    test(vector.name, () => {
      const random = new SequenceRandom(vector.randoms);
      const actual = vector.expected.map(({ attempt }) => ({
        attempt,
        delayMs: prototypeChannelBackoffDelay(attempt, vector.reconnect, random) ?? null,
      }));
      expect(actual).toEqual(vector.expected);
    });
  }

  test("full jitter never exceeds the capped exponential ceiling", () => {
    const reconnect = { initialDelayMs: 200, maxDelayMs: 1500, maxAttempts: 10 };
    for (const random of [0, 0.5, 0.999999]) {
      for (let attempt = 1; attempt <= 10; attempt++) {
        const delay = prototypeChannelBackoffDelay(
          attempt,
          reconnect,
          new SequenceRandom([random]),
        );
        expect(delay).toBeLessThan(Math.min(1500, 200 * 2 ** (attempt - 1)));
      }
    }
  });

  test("the documented defaults apply when reconnect is omitted", () => {
    expect(PROTOTYPE_CHANNEL_DEFAULT_RECONNECT).toEqual({
      maxAttempts: 8,
      initialDelayMs: 500,
      maxDelayMs: 30000,
    });
    expect(prototypeChannelBackoffDelay(9, {}, new SequenceRandom([0.5]))).toBeUndefined();
  });
});

describe("frame coalescing (shared vectors)", () => {
  const vectors: {
    cases: {
      name: string;
      frames: PrototypeChannelFrameActions[];
      expected: PrototypeChannelFrameActions[];
    }[];
  } = read("coalesce.json");

  for (const vector of vectors.cases) {
    test(vector.name, () => {
      expect(coalescePrototypeChannelFrames(vector.frames)).toEqual(vector.expected);
    });
  }
});

test("shared vectors stay within the reconnect contract and flush budget", () => {
  const vectors = read("backoff.json");
  for (const { reconnect } of vectors.cases) {
    const result = prototypeSpecSchema.safeParse({
      id: "backoff",
      window: { placement: { type: "fullscreen" } },
      requires: { platform: ["realtime"] },
      channels: {
        c: {
          kind: "websocket",
          url: "wss://example.com",
          reconnect: { ...PROTOTYPE_CHANNEL_DEFAULT_RECONNECT, ...reconnect },
        },
      },
      root: { type: "text", text: "backoff" },
    });
    expect(result.success).toBe(true);
  }
  expect(read("coalesce.json").flushMs).toBe(PROTOTYPE_CHANNEL_FLUSH_MS);
});
