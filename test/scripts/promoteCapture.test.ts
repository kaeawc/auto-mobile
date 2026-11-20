import { describe, expect, test } from "bun:test";
import {
  buildPromotion,
  eolPinLine,
  parseCapture,
  parseFixtureDestination,
  sourceCommitOf,
  withEolPin,
  type ParsedCapture,
} from "../../scripts/fixtures/promote-capture";

// Promotion logic only: these are inputs to the promote step, not parser fixtures.
const baseDevice = {
  platform: "android",
  deviceId: "emulator-5554",
  apiLevel: 36,
  osVersion: "16",
  model: "sdk_gphone64_arm64",
} as const;

function capture(overrides: Partial<ParsedCapture["provenance"]> = {}): ParsedCapture {
  return parseCapture(
    JSON.stringify({
      schemaVersion: 1,
      tool: { name: "measureStartup" },
      captureDate: "2026-11-19T12:00:00.000Z",
      automobileVersion: "0.0.96+gabc1234",
      sourceTreeState: "clean",
      device: baseDevice,
      ...overrides,
    }),
    JSON.stringify([
      {
        index: 0,
        argv: ["/Users/dev/Library/Android/sdk/platform-tools/adb", "-s", "emulator-5554", "shell"],
        exitCode: 0,
        durationMs: 5,
        stdout: "serial emulator-5554 at /Users/dev/tmp\n",
        stderr: "",
      },
      {
        index: 1,
        argv: ["adb", "<redacted>"],
        exitCode: 0,
        durationMs: 1,
        stdout: "",
        stderr: "",
        redacted: true,
      },
      {
        index: 2,
        argv: ["adb", "shell", "dumpsys"],
        exitCode: 0,
        durationMs: 1,
        stdout: "head<truncated:fixture-capture-limit>",
        stderr: "",
        truncated: true,
      },
    ]),
  );
}

const destination = parseFixtureDestination("test/fixtures/android-startup/phone/am-start.txt");

describe("promote-capture", () => {
  test("redacts the serial and home directory and records provenance", () => {
    const promotion = buildPromotion({
      capture: capture(),
      commandIndex: 0,
      stream: "stdout",
      destination,
      homeDir: "/Users/dev",
    });
    expect(promotion.fixture).toBe("serial <serial> at ~/tmp\n");
    expect(promotion.provenance).toEqual({
      schemaVersion: 1,
      provenance: "captured",
      tool: "measureStartup",
      argv: ["adb", "-s", "<serial>", "shell"],
      exitCode: 0,
      stream: "stdout",
      captureDate: "2026-11-19T12:00:00.000Z",
      sourceCommit: "abc1234",
      automobileVersion: "0.0.96+gabc1234",
      device: {
        platform: "android",
        formFactor: "phone",
        formFactorDeclared: true,
        model: "sdk_gphone64_arm64",
        osVersion: "16",
        apiLevel: 36,
      },
    });
  });

  test("refuses a redacted command, a missing device, and a form-factor mismatch", () => {
    const input = { commandIndex: 0, stream: "stdout" as const, destination, homeDir: "/h" };
    expect(() => buildPromotion({ ...input, capture: capture(), commandIndex: 1 })).toThrow(
      "redacted at capture time",
    );
    expect(() => buildPromotion({ ...input, capture: capture(), commandIndex: 2 })).toThrow(
      "truncated",
    );
    expect(() => buildPromotion({ ...input, capture: capture({ device: undefined }) })).toThrow(
      "resolved no device",
    );
    const tablet = capture({ device: { ...baseDevice, formFactor: "tablet" } });
    expect(() => buildPromotion({ ...input, capture: tablet })).toThrow("names phone");
  });

  test("requires a clean source commit", () => {
    expect(sourceCommitOf("0.0.96+g0123abcd")).toBe("0123abcd");
    expect(() => sourceCommitOf("0.0.96")).toThrow("names no source commit");
    expect(() => sourceCommitOf("0.0.96+gabc1234.dirty")).toThrow("dirty checkout");
  });

  test.each(["unknown", "dirty"] as const)(
    "refuses a clean-looking version whose tree state is %s",
    (sourceTreeState) => {
      const input = { commandIndex: 0, stream: "stdout" as const, destination, homeDir: "/h" };
      expect(() => buildPromotion({ ...input, capture: capture({ sourceTreeState }) })).toThrow(
        `tree state is ${sourceTreeState}`,
      );
    },
  );

  test("refuses a capture that records no tree state", () => {
    expect(() =>
      parseCapture(
        JSON.stringify({
          schemaVersion: 1,
          tool: { name: "observe" },
          captureDate: "2026-11-19T12:00:00.000Z",
          automobileVersion: "0.0.96+gabc1234",
        }),
        "[]",
      ),
    ).toThrow();
  });

  test("accepts only test/fixtures/<area>/<form-factor>/<name>.txt", () => {
    expect(destination).toEqual({
      relativePath: "test/fixtures/android-startup/phone/am-start.txt",
      area: "android-startup",
      formFactor: "phone",
    });
    expect(() => parseFixtureDestination("test/fixtures/a/phone/x.json")).toThrow(".txt");
    expect(() => parseFixtureDestination("test/fixtures/a/wearable/x.txt")).toThrow("form-factor");
    expect(() => parseFixtureDestination("fixtures/a/phone/x.txt")).toThrow("--dest must be");
  });

  test("pins LF next to the same area, else after the last fixture entry", () => {
    const pin = eolPinLine(destination);
    expect(pin).toBe("test/fixtures/android-startup/phone/* text eol=lf");
    const attributes = [
      "test/fixtures/android-startup/*.txt text eol=lf",
      "test/fixtures/wear/*.txt text eol=lf",
      "*.png filter=lfs",
      "",
    ].join("\n");
    expect(withEolPin(attributes, pin, "android-startup").split("\n").slice(0, 3)).toEqual([
      "test/fixtures/android-startup/*.txt text eol=lf",
      pin,
      "test/fixtures/wear/*.txt text eol=lf",
    ]);
    expect(withEolPin(attributes, pin, "other").split("\n")[2]).toBe(pin);
    expect(withEolPin(`${pin}\n`, pin, "android-startup")).toBe(`${pin}\n`);
  });
});
