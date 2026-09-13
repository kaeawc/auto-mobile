import { describe, expect, test } from "bun:test";
import {
  screenshotDeviceToken,
  screenshotFileBelongsToDevice,
  screenshotFileDeviceToken,
  screenshotFileName,
} from "../../../src/utils/screenshot/screenshotFormats";

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
});
