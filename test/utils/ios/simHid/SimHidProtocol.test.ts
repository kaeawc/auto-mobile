import { describe, expect, test } from "bun:test";
import {
  outcomeFromAck,
  parseSimHidAck,
  parseSimHidStartupLine,
} from "../../../../src/utils/ios/simHid/SimHidProtocol";

describe("SimHidProtocol", () => {
  test("parses acks and rejects other shapes", () => {
    expect(parseSimHidAck({ id: "1", ok: true, sent: true, elapsedMs: 0.5 })).toEqual({
      id: "1",
      ok: true,
      sent: true,
      elapsedMs: 0.5,
    });
    expect(
      parseSimHidAck({
        id: "2",
        ok: false,
        sent: false,
        error: { code: "unsupported-key", message: "m" },
      }),
    ).toEqual({
      id: "2",
      ok: false,
      sent: false,
      error: { code: "unsupported-key", message: "m" },
    });
    expect(parseSimHidAck({ id: 3, ok: true, sent: true })).toBeUndefined();
    expect(parseSimHidAck({ event: "ready" })).toBeUndefined();
    expect(parseSimHidAck(null)).toBeUndefined();
  });

  test("maps acks to routing outcomes by whether anything was sent", () => {
    expect(outcomeFromAck({ id: "1", ok: true, sent: true, elapsedMs: 2 })).toEqual({
      status: "delivered",
      elapsedMs: 2,
    });
    expect(
      outcomeFromAck({
        id: "1",
        ok: false,
        sent: false,
        error: { code: "unsupported-key", message: "no" },
      }),
    ).toEqual({ status: "unavailable", reason: "sim-hid-helper unsupported-key: no" });
    expect(outcomeFromAck({ id: "1", ok: false, sent: true })).toEqual({
      status: "indeterminate",
      reason: "sim-hid-helper reported a failure",
    });
  });

  test("parses the startup line", () => {
    expect(parseSimHidStartupLine({ event: "ready", initMs: 12.3 })).toEqual({
      event: "ready",
      initMs: 12.3,
    });
    expect(
      parseSimHidStartupLine({
        event: "error",
        error: { code: "device-not-booted", message: "m" },
      }),
    ).toEqual({ event: "error", error: { code: "device-not-booted", message: "m" } });
    expect(parseSimHidStartupLine({ event: "error" })).toBeUndefined();
    expect(parseSimHidStartupLine("ready")).toBeUndefined();
  });
});
