import { expect, test } from "bun:test";
import {
  EmulatorOutputTailRegistry,
  MAX_EMULATOR_OUTPUT_SOURCES,
  MAX_EMULATOR_OUTPUT_TAIL_BYTES,
} from "../../../src/utils/android-cmdline-tools/EmulatorOutputTail";

test("looks up only the exact serial and PID and reads the current live snapshot", () => {
  const tails = new EmulatorOutputTailRegistry();
  const identity: { deviceId?: string } = {};
  let output = "startup";
  const remove = tails.register(123, { deviceId: () => identity.deviceId, snapshot: () => output });
  expect(tails.tailFor("emulator-5554", 123)).toBeUndefined();
  identity.deviceId = "emulator-5554";
  expect(tails.tailFor(identity.deviceId, 124)).toBeUndefined();
  expect(tails.tailFor("emulator-5556", 123)).toBeUndefined();
  expect(tails.tailFor(identity.deviceId, 123)).toBe("startup");
  output = "post-launch host mic failure";
  expect(tails.tailFor(identity.deviceId, 123)).toBe(output);
  remove();
  expect(tails.tailFor(identity.deviceId, 123)).toBeUndefined();
});

test("caps UTF-8 lookup bytes without splitting a character", () => {
  const tails = new EmulatorOutputTailRegistry();
  tails.register(1, {
    deviceId: () => "emulator-5554",
    snapshot: () => "old" + "🎙".repeat(MAX_EMULATOR_OUTPUT_TAIL_BYTES) + "end",
  });
  const output = tails.tailFor("emulator-5554", 1) ?? "";
  expect(Buffer.byteLength(output)).toBeLessThanOrEqual(MAX_EMULATOR_OUTPUT_TAIL_BYTES);
  expect(output).toEndWith("end");
  expect(output).not.toContain("old");
  expect(output).not.toContain("�");
});

test("latches raw host failure before either tail bound evicts it", () => {
  const tails = new EmulatorOutputTailRegistry();
  let output = "";
  tails.register(123, { deviceId: () => "emulator-5554", snapshot: () => output });
  const observe = (chunk: string) => {
    tails.observe(123, chunk);
    output = (output + chunk)
      .split("\n")
      .slice(-50)
      .join("\n")
      .slice(-16 * 1024);
  };
  observe("coreaudio: Could not initialize record\n");
  const info = `INFO | ${"ordinary output ".repeat(24)}\n`;
  expect(Buffer.byteLength(info) * 60).toBeGreaterThan(16 * 1024);
  for (let line = 0; line < 60; line++) {
    observe(info);
  }
  expect(tails.tailFor("emulator-5554", 123)).not.toContain("Could not initialize record");
  expect(tails.hostMicrophoneFailed("emulator-5554", 123)).toBe(true);
  expect(tails.hostMicrophoneFailed("emulator-5556", 123)).toBe(false);
  expect(tails.hostMicrophoneFailed("emulator-5554", 124)).toBe(false);
});

test("latch is set from a chunk even when the failure never fits in the snapshot", () => {
  const tails = new EmulatorOutputTailRegistry();
  tails.register(123, { deviceId: () => "emulator-5554", snapshot: () => "INFO | trimmed" });
  tails.observe(123, "kAudioHardwareIllegalOperation\n" + "INFO | log churn\n".repeat(2_000));
  expect(tails.hostMicrophoneFailed("emulator-5554", 123)).toBe(true);
});

test("latches share the source cap, replacement, removal and exit lifetime", () => {
  const tails = new EmulatorOutputTailRegistry();
  let alive = true;
  const source = {
    deviceId: () => "emulator-5554",
    snapshot: () => "",
    alive: () => alive,
  };
  const staleRemove = tails.register(1, source);
  tails.observe(1, "Could not initialize record");
  for (let pid = 2; pid <= MAX_EMULATOR_OUTPUT_SOURCES + 1; pid++) {
    tails.register(pid, source);
    tails.observe(pid, "Could not initialize record");
  }
  expect(tails.hostMicrophoneFailed("emulator-5554", 1)).toBe(false);
  expect(tails.hostMicrophoneFailed("emulator-5554", 2)).toBe(true);
  const remove = tails.register(1, source);
  expect(tails.hostMicrophoneFailed("emulator-5554", 1)).toBe(false);
  tails.observe(1, "Could not initialize record");
  staleRemove();
  expect(tails.hostMicrophoneFailed("emulator-5554", 1)).toBe(true);
  remove();
  tails.observe(1, "Could not initialize record");
  expect(tails.hostMicrophoneFailed("emulator-5554", 1)).toBe(false);
  alive = false;
  expect(tails.hostMicrophoneFailed("emulator-5554", 3)).toBe(false);
  alive = true;
  expect(tails.hostMicrophoneFailed("emulator-5554", 3)).toBe(false);
});

test("caps source count and stale exit cleanup cannot remove a replacement", () => {
  const tails = new EmulatorOutputTailRegistry();
  const source = { deviceId: () => "emulator-5554", snapshot: () => "captured" };
  const staleRemove = tails.register(1, source);
  for (let pid = 2; pid <= MAX_EMULATOR_OUTPUT_SOURCES + 1; pid++) {
    tails.register(pid, source);
  }
  expect(tails.tailFor("emulator-5554", 1)).toBeUndefined();
  expect(tails.tailFor("emulator-5554", 2)).toBe("captured");
  const remove = tails.register(1, { ...source, snapshot: () => "replacement" });
  staleRemove();
  expect(tails.tailFor("emulator-5554", 1)).toBe("replacement");
  expect(tails.tailFor("emulator-5554", 2)).toBeUndefined();
  remove();
  expect(tails.tailFor("emulator-5554", 1)).toBeUndefined();
});
