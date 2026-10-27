import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import contract from "../../../schemas/prototype-spec-contract.json";
import {
  PROTOTYPE_CHANNEL_DEFAULT_RECONNECT,
  prototypeChannelBackoffDelay,
  type PrototypeChannelReconnect,
} from "../../../src/features/prototype/prototypeChannelBackoff";
import {
  coalescePrototypeChannelFrames,
  type PrototypeChannelFrameActions,
} from "../../../src/features/prototype/prototypeChannelCoalesce";
import * as limits from "../../../src/features/prototype/prototypeChannelLimits";
import { applyPrototypeDataWrite } from "../../../src/features/prototype/prototypeDataWrite";
import { prototypeSpecSchema } from "../../../src/features/prototype/prototypeSpec";
import { validatePrototypeSpec } from "../../../src/features/prototype/prototypeValidation";
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

describe("limits", () => {
  test("come from the contract", () => {
    expect(limits.MAX_PROTOTYPE_CHANNELS).toBe(4);
    expect(limits.MAX_PROTOTYPE_CHANNEL_FRAME_BYTES).toBe(65536);
    expect(limits.MAX_PROTOTYPE_CHANNEL_SEND_BYTES).toBe(16384);
    expect(limits.MAX_PROTOTYPE_CHANNELS_OPEN).toBe(8);
    expect(limits.PROTOTYPE_CHANNEL_FLUSH_MS).toBe(50);
    expect(limits.MAX_PROTOTYPE_CHANNELS).toBe(contract.limits.MAX_PROTOTYPE_CHANNELS);
  });

  test("the contract bounds the structural fields the same way the Zod mirror does", () => {
    const channel = contract.definitions.channel.fields;
    expect(channel.routes.rule.max).toBe(limits.MAX_PROTOTYPE_CHANNEL_ROUTES);
    expect(channel.protocols.rule.max).toBe(limits.MAX_PROTOTYPE_CHANNEL_PROTOCOLS);
    expect(channel.headers.rule.maxEntries).toBe(limits.MAX_PROTOTYPE_CHANNEL_HEADERS);
    expect(contract.platformModules.realtime.calls.send.args.body.value.maxBytes).toBe(
      limits.MAX_PROTOTYPE_CHANNEL_SEND_BYTES,
    );
  });
});

describe("applyPrototypeDataWrite upsert and maxItems", () => {
  const data = {
    messages: [
      { id: "a", text: "one" },
      { id: "b", text: "two" },
    ],
  };
  const upsert = (value: unknown, extra: Record<string, unknown> = {}) =>
    applyPrototypeDataWrite(data, {
      op: "upsert",
      path: "/data/messages",
      key: "/id",
      value,
      ...extra,
    });

  test("replaces the element with the same key", () => {
    const result = upsert({ id: "b", text: "edited" });
    expect(result).toEqual({
      success: true,
      data: {
        messages: [
          { id: "a", text: "one" },
          { id: "b", text: "edited" },
        ],
      },
    });
  });

  test("appends when no element has the key", () => {
    const result = upsert({ id: "c", text: "three" });
    expect(result.success && (result.data.messages as unknown[]).length).toBe(3);
  });

  test("an element without the key member never matches", () => {
    const result = applyPrototypeDataWrite(
      { messages: [{ text: "anonymous" }] },
      { op: "upsert", path: "/data/messages", key: "/id", value: { id: "a" } },
    );
    expect(result.success && (result.data.messages as unknown[]).length).toBe(2);
  });

  test("matches structurally, not by reference, for object and number keys", () => {
    const rows = {
      rows: [
        { k: { a: [1, 2] }, v: 1 },
        { k: 7, v: 2 },
      ],
    };
    const first = applyPrototypeDataWrite(rows, {
      op: "upsert",
      path: "/data/rows",
      key: "/k",
      value: { k: { a: [1, 2] }, v: 9 },
    });
    const second = applyPrototypeDataWrite(rows, {
      op: "upsert",
      path: "/data/rows",
      key: "/k",
      value: { k: 7, v: 8 },
    });
    expect(first.success && first.data.rows).toEqual([
      { k: { a: [1, 2] }, v: 9 },
      { k: 7, v: 2 },
    ]);
    expect(second.success && second.data.rows).toEqual([
      { k: { a: [1, 2] }, v: 1 },
      { k: 7, v: 8 },
    ]);
  });

  test("a value without the key member is invalid", () => {
    expect(upsert({ text: "no id" })).toEqual({
      success: false,
      error: { code: "invalid_value", message: "upsertData value has no member at /id" },
    });
  });

  test("a missing or non-array target is refused", () => {
    expect(
      applyPrototypeDataWrite(data, {
        op: "upsert",
        path: "/data/nope",
        key: "/id",
        value: { id: 1 },
      }),
    ).toMatchObject({ success: false, error: { code: "not_found" } });
    expect(
      applyPrototypeDataWrite(
        { messages: {} },
        { op: "upsert", path: "/data/messages", key: "/id", value: { id: 1 } },
      ),
    ).toMatchObject({ success: false, error: { code: "not_array" } });
  });

  test("maxItems drops the oldest items after an upsert append", () => {
    const result = upsert({ id: "c" }, { maxItems: 2 });
    expect(result).toEqual({
      success: true,
      data: { messages: [{ id: "b", text: "two" }, { id: "c" }] },
    });
  });

  test("maxItems also trims an array that is already over the cap", () => {
    const result = upsert({ id: "b", text: "edited" }, { maxItems: 1 });
    expect(result).toEqual({ success: true, data: { messages: [{ id: "b", text: "edited" }] } });
  });

  test("appendData maxItems keeps only the newest items", () => {
    const result = applyPrototypeDataWrite(
      { log: [1, 2, 3] },
      { op: "append", path: "/data/log", value: 4, maxItems: 3 },
    );
    expect(result).toEqual({ success: true, data: { log: [2, 3, 4] } });
  });

  test("maxItems out of range is invalid", () => {
    for (const maxItems of [0, 501, 1.5]) {
      expect(
        applyPrototypeDataWrite(
          { log: [] },
          { op: "append", path: "/data/log", value: 1, maxItems },
        ),
      ).toMatchObject({ success: false, error: { code: "invalid_value" } });
    }
  });

  test("without maxItems nothing is dropped", () => {
    const result = applyPrototypeDataWrite(
      { log: [1, 2] },
      { op: "append", path: "/data/log", value: 3 },
    );
    expect(result).toEqual({ success: true, data: { log: [1, 2, 3] } });
  });
});

describe("channels in the spec schema and validator", () => {
  const spec = read("../valid/realtime-channels.json");

  test("the shared fixture parses with the Zod mirror and validates", () => {
    expect(prototypeSpecSchema.safeParse(spec).success).toBe(true);
    expect(validatePrototypeSpec(spec).success).toBe(true);
  });

  test("{event} accepts the empty pointer and a pointer, and nothing else", () => {
    const withEvent = (event: unknown) => ({
      ...spec,
      channels: {
        ...spec.channels,
        driver: {
          ...spec.channels.driver,
          routes: [{ actions: [{ type: "setData", path: "/data/driver", value: { event } }] }],
        },
      },
    });
    expect(validatePrototypeSpec(withEvent("")).success).toBe(true);
    expect(validatePrototypeSpec(withEvent("/a/b")).success).toBe(true);
    expect(validatePrototypeSpec(withEvent("a/b")).success).toBe(false);
    expect(validatePrototypeSpec(withEvent(1)).success).toBe(false);
  });

  test("a channel timer follow-up cannot smuggle a request or navigation action", () => {
    const nested = {
      ...spec,
      channels: {
        ...spec.channels,
        driver: {
          ...spec.channels.driver,
          routes: [
            {
              actions: [
                {
                  type: "startTimer",
                  id: "t",
                  afterMs: 100,
                  actions: [{ type: "request", url: "https://example.com/" }],
                },
              ],
            },
          ],
        },
      },
    };
    const result = validatePrototypeSpec(nested);
    expect(result.success).toBe(false);
    expect(!result.success && result.error.path).toBe(
      "channels.driver.routes[0].actions[0].actions[0]",
    );
  });
});
