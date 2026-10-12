import { expect, test } from "bun:test";
import {
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
    expect(decodeAdbHostResponse(Buffer.from(bytes))).toEqual(expected);
  }
});
