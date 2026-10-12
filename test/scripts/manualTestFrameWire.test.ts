import { expect, test } from "bun:test";
import {
  encodeDaemonFrame,
  encodeJsonLine,
  LineDecoder,
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
  const decoder = new LineDecoder();
  expect(decoder.push("a")).toEqual([]);
  expect(decoder.push("b\nc\nd")).toEqual(["ab", "c"]);
  expect(decoder.remainder().toString()).toBe("d");
  expect(decoder.push("e\n")).toEqual(["de"]);
});
test("UTF-8 split across chunks is decoded only when complete", () => {
  const decoder = new LineDecoder();
  const bytes = Buffer.from("☃\n");
  expect(decoder.push(bytes.subarray(0, 1))).toEqual([]);
  expect(decoder.push(bytes.subarray(1, 2))).toEqual([]);
  expect(decoder.push(bytes.subarray(2))).toEqual(["☃"]);
});
test("first-line mode preserves binary newlines and invalid UTF-8 byte for byte", () => {
  const decoder = new LineDecoder();
  const binary = Buffer.from([255, 10, 0, 127]);
  expect(decoder.push(Buffer.concat([Buffer.from('{"success":true}\n'), binary]), 1)).toEqual([
    '{"success":true}',
  ]);
  expect(decoder.remainder()).toEqual(binary);
});

test("raw null params remain null", () => {
  expect(
    JSON.parse(encodeDaemonFrame({ id: "x", method: "input/tap", params: null })).params,
  ).toBeNull();
});
