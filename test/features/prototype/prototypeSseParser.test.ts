import { describe, expect, test } from "bun:test";
import { SseParser, type SseEvent } from "../../../src/features/prototype/prototypeSseParser";

function parse(chunks: string[], seed?: string): { events: SseEvent[]; retries: number[] } {
  const events: SseEvent[] = [];
  const retries: number[] = [];
  const parser = new SseParser({
    onEvent: (event) => events.push(event),
    onRetry: (ms) => retries.push(ms),
  });
  if (seed !== undefined) {
    parser.seedLastEventId(seed);
  }
  chunks.forEach((chunk) => parser.push(chunk));
  return { events, retries };
}

const stream =
  "﻿: comment\r\nevent: tick\r\ndata: one\r\ndata: two\r\nid: 7\r\n\r\n" +
  "data:no-space\n\nretry: 1500\ndata\n\nevent: x\n\ndata: last\r\rdata: cr\r\n\n";

const expected: SseEvent[] = [
  { event: "tick", data: "one\ntwo", id: "7" },
  { data: "no-space", id: "7" },
  { data: "", id: "7" },
  { data: "last", id: "7" },
  { data: "cr", id: "7" },
];

describe("SseParser", () => {
  test("parses CRLF, LF and CR terminators, comments, BOM, multi-line data and retry", () => {
    const { events, retries } = parse([stream]);
    expect(events).toEqual(expected);
    expect(retries).toEqual([1500]);
  });

  test("an event cut at any chunk boundary parses identically", () => {
    for (let at = 0; at <= stream.length; at++) {
      const { events, retries } = parse([stream.slice(0, at), stream.slice(at)]);
      expect(events).toEqual(expected);
      expect(retries).toEqual([1500]);
    }
  });

  test("a stream fed one character at a time parses identically", () => {
    expect(parse([...stream]).events).toEqual(expected);
  });

  test("a CRLF split across chunks counts as one line end", () => {
    const { events } = parse(["data: a\r", "\ndata: b\r\n\r", "\n"]);
    expect(events).toEqual([{ data: "a\nb" }]);
  });

  test("an event without data is not dispatched, and its name does not leak into the next", () => {
    expect(parse(["event: ghost\n\ndata: real\n\n"]).events).toEqual([{ data: "real" }]);
  });

  test("an id persists across events until replaced, and an id with NUL is ignored", () => {
    const { events } = parse([
      "id: 1\ndata: a\n\ndata: b\n\nid: 2\0x\ndata: c\n\nid: 3\ndata: d\n\n",
    ]);
    expect(events.map((event) => event.id)).toEqual(["1", "1", "1", "3"]);
  });

  test("a seeded last event id is reported until the stream sets one", () => {
    expect(parse(["data: a\n\nid: 9\ndata: b\n\n"], "5").events.map((e) => e.id)).toEqual([
      "5",
      "9",
    ]);
  });

  test("a retry that is not digits is ignored", () => {
    expect(parse(["retry: 12x\nretry: -1\nretry:\n"]).retries).toEqual([]);
  });

  test("an unterminated final event is not dispatched", () => {
    expect(parse(["data: partial"]).events).toEqual([]);
  });

  test("pendingChars includes the event name and the retained id", () => {
    const parser = new SseParser({ onEvent: () => {} });
    parser.push("event: abc\nid: 12345\n");
    expect(parser.pendingChars).toBe(3 + 5);
  });

  test("pendingChars counts the line and the data lines being assembled", () => {
    const parser = new SseParser({ onEvent: () => {} });
    parser.push("data: abcd\ndata: ef");
    expect(parser.pendingChars).toBe(4 + 0 + "data: ef".length);
    parser.push("\n\n");
    expect(parser.pendingChars).toBe(0);
  });
});
