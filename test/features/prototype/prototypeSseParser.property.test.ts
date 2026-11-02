import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { SseParser, type SseEvent } from "../../../src/features/prototype/prototypeSseParser";

const RUN = { seed: 14_268, numRuns: 100 } as const;
const text = fc
  .array(fc.constantFrom("a", "z", "0", "9", " ", ":", "é", "😀"), { maxLength: 12 })
  .map((chars) => chars.join(""));
const terminator = fc.constantFrom("\r\n", "\n", "\r");
const digits = fc
  .array(fc.integer({ min: 0, max: 9 }), { minLength: 1, maxLength: 6 })
  .map((values) => values.join(""));
const retry = fc.oneof(
  digits,
  text.map((value) => `x${value}`),
  fc.constantFrom("", "-1", "+2", "1.5", " 12", "12 ", "１２"),
);
const event = fc.record({
  name: text,
  data: fc.array(text, { minLength: 1, maxLength: 4 }),
  id: fc.option(text, { nil: undefined }),
  retry,
  comment: text,
  end: terminator,
});
const boundaries = fc.array(fc.nat({ max: 10_000 }), { maxLength: 50 });

function parse(chunks: string[]): { events: SseEvent[]; retries: number[] } {
  const events: SseEvent[] = [];
  const retries: number[] = [];
  const parser = new SseParser({
    onEvent: (value) => events.push(value),
    onRetry: (ms) => retries.push(ms),
  });
  chunks.forEach((chunk) => parser.push(chunk));
  return { events, retries };
}

/** Cuts may land inside a field, surrogate pair or CRLF, and may repeat to produce empty pushes. */
function chunk(stream: string, cuts: number[]): string[] {
  const positions = [
    0,
    ...cuts.map((cut) => cut % (stream.length + 1)).sort((a, b) => a - b),
    stream.length,
  ];
  return positions.slice(1).map((end, index) => stream.slice(positions[index], end));
}

describe("SseParser properties", () => {
  test("generated event streams parse identically across arbitrary chunk boundaries", () => {
    fc.assert(
      fc.property(fc.array(event, { minLength: 1, maxLength: 8 }), boundaries, (events, cuts) => {
        const stream =
          "\uFEFF" +
          events
            .map((value) =>
              [
                `: ${value.comment}`,
                `event: ${value.name}`,
                ...value.data.map((line) => `data: ${line}`),
                ...(value.id === undefined ? [] : [`id: ${value.id}`]),
                `retry: ${value.retry}`,
                "",
                "",
              ].join(value.end),
            )
            .join("");
        expect(parse(chunk(stream, cuts))).toEqual(parse([stream]));
      }),
      RUN,
    );
  });

  test("ids persist until replaced, empty ids reset, and NUL ids are ignored", () => {
    const update = fc.option(
      fc.oneof(
        text,
        text.map((value) => `${value}\0`),
      ),
      { nil: undefined },
    );
    fc.assert(
      fc.property(
        fc.array(update, { minLength: 1, maxLength: 20 }),
        terminator,
        boundaries,
        (updates, end, cuts) => {
          let id = "";
          const expected = updates.map((next) => {
            if (next !== undefined && !next.includes("\0")) {
              id = next;
            }
            return id === "" ? undefined : id;
          });
          const stream = updates
            .map(
              (next) => `${next === undefined ? "" : `id: ${next}${end}`}data: value${end}${end}`,
            )
            .join("");
          expect(parse(chunk(stream, cuts)).events.map((value) => value.id)).toEqual(expected);
        },
      ),
      RUN,
    );
  });

  test("only digit-only retry fields dispatch", () => {
    fc.assert(
      fc.property(
        fc.array(retry, { minLength: 1, maxLength: 20 }),
        terminator,
        boundaries,
        (values, end, cuts) => {
          const stream = values.map((value) => `retry: ${value}${end}`).join("");
          const expected = values
            .filter(
              (value) => value.length > 0 && [...value].every((char) => char >= "0" && char <= "9"),
            )
            .map(Number);
          expect(parse(chunk(stream, cuts)).retries).toEqual(expected);
        },
      ),
      RUN,
    );
  });
});
