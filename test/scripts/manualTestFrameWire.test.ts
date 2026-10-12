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
  expect(decoder.push("a")).toEqual([]);
  expect(decoder.push("b\nc\nd")).toEqual(["ab", "c"]);
  expect(decoder.push("e\n")).toEqual(["de"]);
});
test("UTF-8 split across chunks is decoded only when complete", () => {
  const decoder = new LineDecoder(32);
  const bytes = Buffer.from("☃\n");
  expect(decoder.push(bytes.subarray(0, 1))).toEqual([]);
  expect(decoder.push(bytes.subarray(1, 2))).toEqual([]);
  expect(decoder.push(bytes.subarray(2))).toEqual(["☃"]);
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
  expect(decoder.push("é")).toEqual([]);
  expect(() => decoder.push("éx")).toThrow(HarnessFrameTooLargeError);
  expect(() => new LineDecoder(4, "Test response").push("12345\n")).toThrow(
    "Test response frame exceeds 4 bytes",
  );
  expect(decoder.push("ok\n")).toEqual([]);
});
