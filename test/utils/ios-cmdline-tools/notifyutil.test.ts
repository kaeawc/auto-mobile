import { describe, expect, test } from "bun:test";
import {
  IOS_NOTIFYUTIL_REGISTERED_SET_TIMEOUT_MS,
  iosNotifyutilGetCommand,
  iosNotifyutilRegisteredSetReadPostCommand,
  parseNotifyutilState,
} from "../../../src/utils/ios-cmdline-tools/notifyutil";

// notifyutil.ts previously had zero tests. `parseNotifyutilState` decides
// whether a Darwin notification key reads registered/on (true), off (false), or
// could-not-be-determined (null). Collapsing unknown into "off" would report
// "DND off" after a probe that actually returned nothing, so the null contract
// is load-bearing. The parser reverses the lines and returns the LAST line that
// ends in a standalone 0/1 (the digit must start the line or follow whitespace).
describe("parseNotifyutilState", () => {
  const rows: ReadonlyArray<{ label: string; raw: string; expected: boolean | null }> = [
    { label: "bare 1 is registered/on", raw: "1", expected: true },
    { label: "bare 0 is off", raw: "0", expected: false },
    { label: "value preceded by a label word", raw: "state 1", expected: true },
    { label: "0 preceded by a label word", raw: "key = 0", expected: false },
    { label: "surrounding whitespace is trimmed", raw: "   1   ", expected: true },
    { label: "trailing CRLF", raw: "1\r\n", expected: true },
    { label: "reads the LAST decisive line (on after off)", raw: "0\n1", expected: true },
    { label: "reads the LAST decisive line (off after on)", raw: "1\n0", expected: false },
    {
      label: "skips non-decisive trailing lines",
      raw: "1\nregistered check complete",
      expected: true,
    },
    { label: "empty input is unknown", raw: "", expected: null },
    { label: "whitespace-only input is unknown", raw: "   \n  ", expected: null },
    { label: "a digit glued to a non-space char is not decisive", raw: "x1", expected: null },
    { label: "a multi-digit number is not a standalone 0/1", raw: "10", expected: null },
    { label: "digit not at end of line is ignored", raw: "1 registered", expected: null },
    { label: "out-of-range digit is unknown", raw: "state 2", expected: null },
    { label: "non-numeric output is unknown", raw: "no such key", expected: null },
    {
      label: "later unknown line does not erase an earlier decisive one",
      raw: "0\nfoo",
      expected: false,
    },
  ];

  for (const { label, raw, expected } of rows) {
    test(`${label} → ${expected}`, () => {
      expect(parseNotifyutilState(raw)).toBe(expected);
    });
  }
});

describe("notifyutil command builders", () => {
  const deviceId = "7B3A3792-DB53-4654-BA94-27A1D305C3B7";
  const key = "com.apple.donotdisturb.state";

  test("iosNotifyutilGetCommand issues a spawn/get for the key", () => {
    expect(iosNotifyutilGetCommand(deviceId, key)).toBe(`spawn ${deviceId} notifyutil -g ${key}`);
  });

  test("registered-set-read-post command sets, gets, and posts in one spawn (value 1)", () => {
    expect(iosNotifyutilRegisteredSetReadPostCommand(deviceId, key, "1")).toBe(
      `spawn ${deviceId} notifyutil -1 ${key} -s ${key} 1 -g ${key} -p ${key}`,
    );
  });

  test("registered-set-read-post command carries the value 0 through unchanged", () => {
    expect(iosNotifyutilRegisteredSetReadPostCommand(deviceId, key, "0")).toBe(
      `spawn ${deviceId} notifyutil -1 ${key} -s ${key} 0 -g ${key} -p ${key}`,
    );
  });

  test("exposes a positive registered-set timeout budget", () => {
    expect(IOS_NOTIFYUTIL_REGISTERED_SET_TIMEOUT_MS).toBeGreaterThan(0);
  });
});
