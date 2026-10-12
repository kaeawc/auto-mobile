import { expect, test } from "bun:test";
import {
  AdbHostResponseAccumulator,
  ADB_HOST_MAX_RESPONSE_BYTES,
  encodeAdbHostRequest,
  decodeAdbHostResponse,
} from "../../scripts/manual-test/adbHostQuery";

test("ADB host requests use a four-hex-digit UTF-8 byte length", () => {
  expect(encodeAdbHostRequest("host:devices-l").toString()).toBe("000ehost:devices-l");
  expect(encodeAdbHostRequest("é").toString()).toBe("0002é");
  expect(() => encodeAdbHostRequest("x".repeat(0x10000))).toThrow("length limit");
});
test("ADB host decoder handles OKAY FAIL and malformed frames", () => {
  for (const [bytes, expected] of [
    ["OKAY0000", { ok: true, payload: "" }],
    ["OKAY000eemu1 device x\n", { ok: true, payload: "emu1 device x\n" }],
    ["OKAY0002é", { ok: true, payload: "é" }],
    ["OKAY000Ax123456789", { ok: true, payload: "x123456789" }],
    ["FAIL0006denied", { ok: false, reason: "denied" }],
    ["FAIL0000", { ok: false, reason: "" }],
    ["", { ok: false, reason: "Incomplete ADB host response" }],
    ["OK", { ok: false, reason: "Incomplete ADB host response" }],
    ["OKAY00", { ok: false, reason: "Incomplete ADB host response" }],
    ["NOPE0000", { ok: false, reason: "Invalid ADB host response status" }],
    ["OKAYzzzz", { ok: false, reason: "Invalid ADB host response length" }],
    ["OKAY00+1x", { ok: false, reason: "Invalid ADB host response length" }],
    ["OKAY0005four", { ok: false, reason: "Incomplete ADB host response" }],
    ["FAIL0005four", { ok: false, reason: "Incomplete ADB host response" }],
    ["OKAY0001extra", { ok: false, reason: "ADB host response length mismatch" }],
  ] as const) {
    const encoded = Buffer.from(bytes);
    expect(decodeAdbHostResponse(encoded)).toEqual(expected);
    const accumulator = new AdbHostResponseAccumulator();
    const result = accumulator.push(encoded);
    expect(accumulator.finish()).toEqual(expected);
    expect(result).toEqual(
      "reason" in expected && expected.reason === "Incomplete ADB host response"
        ? undefined
        : expected,
    );
  }
});

test("ADB accumulator preserves chunked completion and FAIL results", () => {
  for (const text of [
    "OKAY0002é",
    "FAIL0006denied",
    "FAIL0000",
    "FAIL001bIncomplete ADB host response",
  ]) {
    const bytes = Buffer.from(text);
    const acc = new AdbHostResponseAccumulator();
    for (let i = 0; i < 7; i++) {
      expect(acc.push(bytes.subarray(i, i + 1))).toBeUndefined();
    }
    expect(acc.push(bytes.subarray(7))).toEqual(decodeAdbHostResponse(bytes));
    expect(acc.finish()).toEqual(decodeAdbHostResponse(bytes));
  }
});
test("ADB accumulator refuses more than the protocol maximum and stays refused", () => {
  expect(ADB_HOST_MAX_RESPONSE_BYTES).toBe(65543);
  const acc = new AdbHostResponseAccumulator();
  expect(acc.push(Buffer.from("OKAYffff"))).toBeUndefined();
  const chunk = Buffer.alloc(1024, 120);
  for (let i = 0; i < 63; i++) {
    expect(acc.push(chunk)).toBeUndefined();
  }
  const result = { ok: false, reason: "ADB host response exceeds 65543 bytes" };
  expect(acc.push(chunk)).toEqual(result);
  expect(acc.finish()).toEqual(result);
  expect(acc.push(Buffer.from("ignored"))).toEqual(result);
});

test("ADB accumulator admits exactly the protocol maximum", () => {
  const acc = new AdbHostResponseAccumulator();
  expect(acc.push(Buffer.from("OKAYffff"))).toBeUndefined();
  const payload = Buffer.alloc(0xffff, 120);
  expect(acc.push(payload)).toEqual({ ok: true, payload: payload.toString("utf8") });
});
