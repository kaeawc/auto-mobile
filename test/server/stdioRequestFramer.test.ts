import { describe, expect, test } from "bun:test";
import {
  type OversizedStdioRequest,
  STDIO_REQUEST_MAX_BYTES,
  StdioRequestFramer,
} from "../../src/server/stdioRequestFramer";

const LIMIT = 64;

function harness(limit = LIMIT) {
  const frames: string[] = [];
  const oversized: OversizedStdioRequest[] = [];
  const framer = new StdioRequestFramer(limit, {
    onFrame: (frame) => frames.push(frame.toString("utf8")),
    onOversized: (request) => oversized.push(request),
  });
  return { framer, frames, oversized };
}

/** A request line of exactly `bytes` bytes (newline excluded). */
function requestOfBytes(bytes: number, id: string | number = 1): string {
  const shell = JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { b: "" } });
  return shell.replace('"b":""', `"b":"${"A".repeat(bytes - shell.length)}"`);
}

describe("StdioRequestFramer", () => {
  test("defaults to the HTTP body cap less the proxy envelope headroom", () => {
    expect(STDIO_REQUEST_MAX_BYTES).toBe(256 * 1024 * 1024 - 64 * 1024);
  });

  test("forwards a message exactly at the limit", () => {
    const { framer, frames, oversized } = harness();
    const line = requestOfBytes(LIMIT);
    expect(line.length).toBe(LIMIT);

    framer.push(Buffer.from(`${line}\n`));

    expect(frames).toEqual([`${line}\n`]);
    expect(oversized).toEqual([]);
  });

  test("refuses a message one byte over the limit and keeps framing later messages", () => {
    const { framer, frames, oversized } = harness();
    const big = requestOfBytes(LIMIT + 1, 7);
    const next = '{"jsonrpc":"2.0","id":8,"method":"ping"}';

    framer.push(Buffer.from(`${big}\n${next}\n`));

    expect(oversized).toEqual([{ requestBytes: LIMIT + 1, limitBytes: LIMIT, id: 7 }]);
    expect(frames).toEqual([`${next}\n`]);
  });

  test("counts an oversized message split across many chunks and resumes after its newline", () => {
    const { framer, frames, oversized } = harness();
    const big = requestOfBytes(LIMIT * 4, "big");
    for (let offset = 0; offset < big.length; offset += 10) {
      framer.push(Buffer.from(big.slice(offset, offset + 10)));
    }
    framer.push(Buffer.from('\n{"jsonrpc":"2.0","id":2,"method":"ping"}\n'));

    expect(oversized).toEqual([{ requestBytes: LIMIT * 4, limitBytes: LIMIT, id: "big" }]);
    expect(frames).toEqual(['{"jsonrpc":"2.0","id":2,"method":"ping"}\n']);
  });

  test("joins a message split across chunks into one frame", () => {
    const { framer, frames } = harness();
    framer.push(Buffer.from('{"jsonrpc":"2.0",'));
    framer.push(Buffer.from('"id":3,"method":"ping"}\n'));
    expect(frames).toEqual(['{"jsonrpc":"2.0","id":3,"method":"ping"}\n']);
  });
});
