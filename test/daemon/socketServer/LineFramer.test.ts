import { describe, expect, it } from "bun:test";
import { LineFramer } from "../../../src/daemon/wire/LineFramer";

function makeFramer(maxFrameBytes: number): {
  framer: LineFramer;
  lines: string[];
  overflows: { count: number };
} {
  const lines: string[] = [];
  const overflows = { count: 0 };
  const framer = new LineFramer(maxFrameBytes, {
    onLine: (line) => lines.push(line),
    onOverflow: () => {
      overflows.count++;
    },
  });
  return { framer, lines, overflows };
}

describe("LineFramer", () => {
  it("delivers one frame split across many small chunks with linear scan work", () => {
    const { framer, lines } = makeFramer(1024 * 1024);
    const payload = `{"data":"${"x".repeat(10_000)}"}`;
    const wire = Buffer.from(`${payload}\n`);

    const chunkSize = 7;
    let chunks = 0;
    for (let offset = 0; offset < wire.length; offset += chunkSize) {
      framer.push(wire.subarray(offset, offset + chunkSize));
      chunks++;
    }

    expect(lines).toEqual([payload]);
    // One scan per chunk and every received byte examined exactly once: the
    // pending prefix is never re-scanned.
    expect(framer.scanCount).toBe(chunks);
    expect(framer.scannedBytes).toBe(wire.length - 1);
  });

  it("delivers several frames from one chunk and keeps the trailing partial frame", () => {
    const { framer, lines } = makeFramer(1024);

    framer.push('{"id":"1"}\n{"id":"2"}\n\n{"id":"3"');
    expect(lines).toEqual(['{"id":"1"}', '{"id":"2"}', ""]);

    framer.push("}\n");
    expect(lines).toEqual(['{"id":"1"}', '{"id":"2"}', "", '{"id":"3"}']);
  });

  it("decodes a multi-byte character split across chunks", () => {
    const { framer, lines } = makeFramer(1024);
    const frame = Buffer.from('{"text":"日本語"}\n');
    const split = frame.indexOf(Buffer.from("本")) + 1;

    framer.push(frame.subarray(0, split));
    framer.push(frame.subarray(split, split + 1));
    framer.push(frame.subarray(split + 1));

    expect(lines).toEqual(['{"text":"日本語"}']);
  });

  it("accepts string chunks", () => {
    const { framer, lines } = makeFramer(1024);
    framer.push('{"a":');
    framer.push("1}\n");
    expect(lines).toEqual(['{"a":1}']);
  });

  it("accepts a frame exactly at the limit", () => {
    const { framer, lines, overflows } = makeFramer(8);
    framer.push("12345678\n");
    expect(lines).toEqual(["12345678"]);
    expect(overflows.count).toBe(0);
    expect(framer.hasOverflowed).toBe(false);
  });

  it("rejects an over-limit frame that has no newline yet and drops what it held", () => {
    const { framer, lines, overflows } = makeFramer(8);

    framer.push("1234");
    expect(overflows.count).toBe(0);
    framer.push("56789");
    expect(overflows.count).toBe(1);
    expect(framer.hasOverflowed).toBe(true);

    // A later newline cannot resurrect the frame, and no further work happens.
    const scansBefore = framer.scanCount;
    framer.push("0\n{}\n");
    expect(lines).toEqual([]);
    expect(overflows.count).toBe(1);
    expect(framer.scanCount).toBe(scansBefore);
  });

  it("rejects an over-limit frame whose newline arrives in the same chunk", () => {
    const { framer, lines, overflows } = makeFramer(8);

    framer.push("123456789\n");

    expect(lines).toEqual([]);
    expect(overflows.count).toBe(1);
  });

  it("rejects an over-limit frame that completes across chunks", () => {
    const { framer, lines, overflows } = makeFramer(8);

    framer.push("1234");
    framer.push("5678\n");
    expect(lines).toEqual(["12345678"]);
    framer.push("1234");
    framer.push("56789\n");

    expect(lines).toEqual(["12345678"]);
    expect(overflows.count).toBe(1);
  });

  it("delivers frames that precede an over-limit frame in the same chunk", () => {
    const { framer, lines, overflows } = makeFramer(8);

    framer.push("ok\n123456789\nlater\n");

    expect(lines).toEqual(["ok"]);
    expect(overflows.count).toBe(1);
  });

  it("bounds retained memory for a peer that never sends a newline", () => {
    const { framer, lines, overflows } = makeFramer(1024);
    const chunk = Buffer.alloc(100, 0x61);

    let sent = 0;
    while (!framer.hasOverflowed) {
      framer.push(chunk);
      sent++;
    }

    // 11 chunks is the first total (1100 bytes) over the 1024-byte limit.
    expect(sent).toBe(11);
    expect(overflows.count).toBe(1);
    expect(lines).toEqual([]);
  });
});

for (const newline of [false, true]) {
  for (const split of [0, 5, 255, 300]) {
    it(`overflow passes a bounded head for split ${split}, newline ${newline}`, () => {
      const heads: Array<Buffer | undefined> = [];
      const framer = new LineFramer(512, {
        onLine: () => {
          throw new Error("Oversized frame delivered");
        },
        onOverflow: (head?: Buffer) => heads.push(head),
      });
      const wire = Buffer.from('{"id":"owner","result":"' + "x".repeat(1_000));
      framer.push(wire.subarray(0, split));
      const tail = Buffer.concat([wire.subarray(split), Buffer.from(newline ? "\n" : "")]);
      framer.push(tail);
      expect(heads).toHaveLength(1);
      expect(heads[0]).toEqual(wire.subarray(0, 256));
      // The copied head must not retain the incoming chunk's memory.
      wire.fill(0);
      tail.fill(0);
      expect(heads[0]?.toString()).toStartWith('{"id":"owner"');
      framer.push("ignored\n");
      expect(heads).toHaveLength(1);
    });
  }
}
