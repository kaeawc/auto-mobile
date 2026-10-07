import { describe, expect, test } from "bun:test";
import {
  evaluateDeviceDisconnects,
  selectImmediateDisconnectCandidates,
} from "../../src/daemon/disconnectMonitor";
import type { Platform } from "../../src/models";
import { isPhysicalAndroidUsbSerial } from "../../src/utils/androidSerial";

const PHONE = "57281FDCH00462";
const EMULATOR = "emulator-5554";
const WIFI = "192.168.1.20:5555";
const SIM = "11111111-2222-3333-4444-555555555555";

const platforms = new Map<string, Platform>([
  [PHONE, "android"],
  [EMULATOR, "android"],
  [WIFI, "android"],
  [SIM, "ios"],
]);
const candidates = new Set(platforms.keys());

describe("isPhysicalAndroidUsbSerial", () => {
  test.each([
    [PHONE, true],
    [EMULATOR, false],
    [WIFI, false],
    ["adb-ABC._adb-tls-connect._tcp", false],
  ])("%s -> %p", (serial, expected) => {
    expect(isPhysicalAndroidUsbSerial(serial)).toBe(expected);
  });
});

describe("selectImmediateDisconnectCandidates", () => {
  test("selects only absent, non-offline physical USB Android candidates", () => {
    expect(
      selectImmediateDisconnectCandidates(candidates, platforms, new Set(), new Set()),
    ).toEqual(new Set([PHONE]));
  });

  test("selects nothing for a present or ADB-offline phone", () => {
    expect(
      selectImmediateDisconnectCandidates(candidates, platforms, new Set([PHONE]), new Set()),
    ).toEqual(new Set());
    expect(
      selectImmediateDisconnectCandidates(candidates, platforms, new Set(), new Set([PHONE])),
    ).toEqual(new Set());
  });

  test("skips a phone whose adbd AutoMobile is restarting", () => {
    const restarting = { isRestarting: (id: string) => id === PHONE };
    expect(
      selectImmediateDisconnectCandidates(candidates, platforms, new Set(), new Set(), restarting),
    ).toEqual(new Set());
  });

  test("selects nothing when the offline probe result is unknown", () => {
    expect(
      selectImmediateDisconnectCandidates(candidates, platforms, new Set(), undefined),
    ).toEqual(new Set());
  });
});

describe("evaluateDeviceDisconnects with immediate candidates", () => {
  const evaluate = (
    misses: Map<string, number>,
    succeededPlatforms: Set<Platform>,
    immediate: Set<string>,
  ) =>
    evaluateDeviceDisconnects({
      deviceDisconnectMisses: misses,
      confirmedDisconnectedDeviceIds: new Set(),
      bootedDeviceIds: new Set(),
      candidateDeviceIds: new Set([PHONE, EMULATOR]),
      succeededPlatforms,
      candidatePlatforms: platforms,
      immediateDisconnectDeviceIds: immediate,
    });

  test("one miss disconnects the phone while the emulator only counts a miss", () => {
    const misses = new Map<string, number>();
    const result = evaluate(misses, new Set(["android"]), new Set([PHONE]));
    expect(result.disconnected).toEqual([PHONE]);
    expect(misses.get(PHONE)).toBe(3);
    expect(misses.get(EMULATOR)).toBe(1);
  });

  test("a failed Android listing never fast-paths the phone", () => {
    const misses = new Map<string, number>();
    const result = evaluate(misses, new Set(["ios"]), new Set([PHONE]));
    expect(result.disconnected).toEqual([]);
    expect(misses.has(PHONE)).toBe(false);
  });
});
