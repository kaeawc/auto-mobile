import { expect, test } from "bun:test";
import {
  encodeDaemonFrame,
  encodeJsonLine,
  LineDecoder,
  HarnessFrameTooLargeError,
} from "../../scripts/manual-test/frameWire";

for (const [method, type] of [
  ["daemon/refreshDevices", "daemon_request"],
  ["ide/status", "daemon_request"],
  ["input/tap", "daemon_request"],
  ["tools/call", "mcp_request"],
]) {
  test(`exact wire bytes for ${method}`, () => {
    expect(encodeDaemonFrame({ id: "id", method, params: { text: "a\nb" } })).toBe(
      `{"id":"id","type":"${type}","method":"${method}","params":{"text":"a\\nb"}}\n`,
    );
  });
}
test("explicit type, timeout, defaults and exactly one trailing newline", () => {
  expect(
    encodeDaemonFrame({ id: "x", method: "input/tap", type: "mcp_request", timeoutMs: 10 }),
  ).toBe('{"id":"x","type":"mcp_request","method":"input/tap","params":{},"timeoutMs":10}\n');
  expect(encodeJsonLine({ a: "\n" }).split("\n")).toHaveLength(2);
  expect(() => encodeJsonLine(undefined)).toThrow("JSON value");
});
test("split chunks and several complete lines keep the partial tail", () => {
  const decoder = new LineDecoder(32);
  expect(decoder.push("a").lines).toEqual([]);
  expect(decoder.push("b\nc\nd").lines).toEqual(["ab", "c"]);
  expect(decoder.push("e\n").lines).toEqual(["de"]);
});
test("UTF-8 split across chunks is decoded only when complete", () => {
  const decoder = new LineDecoder(32);
  const bytes = Buffer.from("☃\n");
  expect(decoder.push(bytes.subarray(0, 1)).lines).toEqual([]);
  expect(decoder.push(bytes.subarray(1, 2)).lines).toEqual([]);
  expect(decoder.push(bytes.subarray(2)).lines).toEqual(["☃"]);
});
test("first-line mode preserves binary newlines and invalid UTF-8 byte for byte", () => {
  const decoder = new LineDecoder(32);
  const binary = Buffer.from([255, 10, 0, 127]);
  expect(decoder.pushFirst(Buffer.from('{"succ'))).toEqual({ raw: Buffer.alloc(0) });
  expect(decoder.pushFirst(Buffer.concat([Buffer.from('ess":true}\n'), binary]))).toEqual({
    line: '{"success":true}',
    raw: binary,
  });
  expect(decoder.pushFirst(binary)).toEqual({ raw: binary });
});

test("raw null params remain null", () => {
  expect(
    JSON.parse(encodeDaemonFrame({ id: "x", method: "input/tap", params: null })).params,
  ).toBeNull();
});

test("decoder overflow identifies the byte limit and ignores later input", () => {
  const decoder = new LineDecoder(4, "Test response");
  expect(decoder.push("é").lines).toEqual([]);
  const { lines, overflow } = decoder.push("éx");
  expect(lines).toEqual([]);
  expect(overflow).toBeInstanceOf(HarnessFrameTooLargeError);
  expect(overflow?.limitBytes).toBe(4);
  expect(overflow?.message).toBe("Test response frame exceeds 4 bytes");
  expect(new LineDecoder(4, "Test response").push("12345\n").overflow?.message).toBe(
    "Test response frame exceeds 4 bytes",
  );
  const later = decoder.push("ok\n");
  expect(later).toEqual({ lines: [], overflow });
  expect(later.overflow).toBe(overflow);
});
test("complete lines precede overflow in the same chunk and overflow stays terminal", () => {
  const decoder = new LineDecoder(4, "Test response");
  const result = decoder.push("ok\n12345\nlater\n");
  expect(result.lines).toEqual(["ok"]);
  expect(result.overflow).toBeInstanceOf(HarnessFrameTooLargeError);
  const later = decoder.push("ok\n");
  expect(later).toEqual({ lines: [], overflow: result.overflow });
  expect(later.overflow).toBe(result.overflow);
  const first = decoder.pushFirst(Buffer.from("ok\nraw"));
  expect(first).toEqual({ raw: Buffer.alloc(0), overflow: result.overflow });
  expect(first.overflow).toBe(result.overflow);
});
test("first-line overflow reports the same error and never exposes trailing raw bytes", () => {
  const decoder = new LineDecoder(4, "Test ack");
  const result = decoder.pushFirst(Buffer.from("12345\nraw"));
  expect(result.line).toBeUndefined();
  expect(result.raw).toEqual(Buffer.alloc(0));
  expect(result.overflow?.message).toBe("Test ack frame exceeds 4 bytes");
  const first = decoder.pushFirst(Buffer.from("ok\nraw"));
  expect(first).toEqual({ raw: Buffer.alloc(0), overflow: result.overflow });
  expect(first.overflow).toBe(result.overflow);
  const later = decoder.push("ok\n");
  expect(later).toEqual({ lines: [], overflow: result.overflow });
  expect(later.overflow).toBe(result.overflow);
});
