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
