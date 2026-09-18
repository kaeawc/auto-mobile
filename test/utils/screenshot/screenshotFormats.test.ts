import { describe, expect, test } from "bun:test";
import { CountingIdGenerator } from "../../../src/utils/IdGenerator";
import {
  screenshotDeviceToken,
  screenshotFileBelongsToDevice,
  screenshotFileDeviceToken,
  screenshotFileName,
  screenshotTempIdToken,
} from "../../../src/utils/screenshot/screenshotFormats";

describe("screenshotTempIdToken", function () {
  test("strips unsupported characters and appends a digest", function () {
    expect(screenshotTempIdToken("normal_id")).toMatch(/^normalid-[0-9a-f]{12}$/);
  });

  test("distinguishes ids with the same stripped label", function () {
    expect(screenshotTempIdToken("a_b")).not.toBe(screenshotTempIdToken("ab"));
  });

  test("uses a non-empty label for punctuation-only ids", function () {
    expect(screenshotTempIdToken(";../")).toMatch(/^unknown-[0-9a-f]{12}$/);
  });

  test("is deterministic", function () {
    expect(screenshotTempIdToken("stable")).toBe(screenshotTempIdToken("stable"));
  });
});

describe("screenshotDeviceToken", function () {
  test("is injective across device ids that sanitize to the same characters", function () {
    const dotted = screenshotDeviceToken("host.name:5555");
    const dashed = screenshotDeviceToken("host-name:5555");

    expect(dotted).not.toBe(dashed);
  });

  test("is stable for the same device id", function () {
    expect(screenshotDeviceToken("127.0.0.1:5555")).toBe(screenshotDeviceToken("127.0.0.1:5555"));
  });

  test("only contains filename-safe characters and no separator underscores", function () {
    const token = screenshotDeviceToken("emulator 5554/../weird:id");

    expect(token).toMatch(/^[A-Za-z0-9-]+$/);
  });

  test("distinguishes device ids that differ only past the sanitized prefix length", function () {
    const long = "a".repeat(80);
    expect(screenshotDeviceToken(`${long}1`)).not.toBe(screenshotDeviceToken(`${long}2`));
  });

  test("produces a token for an empty device id", function () {
    expect(screenshotDeviceToken("")).toMatch(/^[A-Za-z0-9-]+$/);
  });
});

describe("screenshotFileBelongsToDevice", function () {
  test("accepts only the device that produced the capture", function () {
    const fileName = screenshotFileName(1234, "host.name:5555", "abc123", "png");

    expect(screenshotFileBelongsToDevice(fileName, "host.name:5555")).toBe(true);
    expect(screenshotFileBelongsToDevice(fileName, "host-name:5555")).toBe(false);
  });

  test("round-trips the device token through the canonical file name", function () {
    const fileName = screenshotFileName(9, "emulator-5554", "id", "jpg");

    expect(screenshotFileDeviceToken(fileName)).toBe(screenshotDeviceToken("emulator-5554"));
  });

  test("returns undefined for names outside the canonical shape", function () {
    expect(screenshotFileDeviceToken("screenshot.png")).toBeUndefined();
  });

  test("round-trips an injected unique id that contains underscores", function () {
    const uniqueId = new CountingIdGenerator("capture_run").next();
    const fileName = screenshotFileName(1234, "emulator-5554", uniqueId, "png");

    expect(screenshotFileDeviceToken(fileName)).toBe(screenshotDeviceToken("emulator-5554"));
    expect(screenshotFileBelongsToDevice(fileName, "emulator-5554")).toBe(true);
  });

  test("rejects a name whose timestamp segment is not numeric", function () {
    expect(screenshotFileDeviceToken("screenshot_notatimestamp_token_id.png")).toBeUndefined();
  });

  test("rejects a name that stops before the unique id segment", function () {
    expect(screenshotFileDeviceToken("screenshot_1234_token.png")).toBeUndefined();
  });
});
