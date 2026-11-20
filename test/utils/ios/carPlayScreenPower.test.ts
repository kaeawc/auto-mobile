import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { ActionableError } from "../../../src/models/ActionableError";
import {
  DefaultCarPlayScreenPowerer,
  parseCarPlayPowerState,
} from "../../../src/utils/ios/carPlayScreenPower";
import { FakeCarPlayScreenPowerer } from "../../fakes/FakeCarPlayScreenPowerer";

// carplay-power-helper power-on output captured on a fresh iOS 26.5 iPhone 17 Pro simulator.
const state = {
  carPlay: { powerState: 1, found: true, screenID: 2 },
  screens: [
    { width: 720, id: 3, name: "Wireless", screenType: 2, powerState: 0, height: 480 },
    { width: 800, id: 2, name: "TVOut", screenType: 1, powerState: 1, height: 480 },
    { width: 1206, id: 1, name: "LCD", screenType: 0, powerState: 1, height: 2622 },
  ],
};
const encoded = JSON.stringify(state);

describe("CarPlay screen power", () => {
  test("parses the Swift state and rejects malformed contracts", () => {
    expect(parseCarPlayPowerState(encoded)).toEqual(state);
    for (const value of [
      "not json",
      "{}",
      encoded + encoded,
      JSON.stringify({ ...state, extra: true }),
      encoded.replace('"width":720', '"width":"720"'),
      encoded.replace('"screenID":2', '"screenID":-1'),
    ]) {
      expect(() => parseCarPlayPowerState(value)).toThrow(ActionableError);
    }
  });
  test("runs status and power-on argv through the seam", async () => {
    const calls: string[][] = [];
    const powerer = new DefaultCarPlayScreenPowerer(
      async (file, args) => {
        calls.push([file, ...args]);
        return { stdout: encoded, stderr: "" };
      },
      { AUTOMOBILE_CARPLAY_POWER_HELPER_PATH: "/helper with spaces" },
    );
    expect(await powerer.status("udid")).toEqual(state);
    await powerer.powerOn("udid");
    expect(calls).toEqual([
      ["/helper with spaces", "udid", "status"],
      ["/helper with spaces", "udid", "power-on"],
    ]);
  });
  test("caps power-on's exec timeout at the caller's budget and forwards its signal", async () => {
    const seen: unknown[] = [];
    const powerer = new DefaultCarPlayScreenPowerer(
      async (_file, _args, options) => {
        seen.push(options);
        return { stdout: encoded, stderr: "" };
      },
      { AUTOMOBILE_CARPLAY_POWER_HELPER_PATH: "/helper" },
    );
    const signal = new AbortController().signal;
    await powerer.powerOn("udid", { signal, timeoutMs: 7000 });
    await powerer.powerOn("udid");
    expect(seen).toEqual([
      { timeout: 7000, maxBuffer: 1024 * 1024, signal },
      { timeout: 135000, maxBuffer: 1024 * 1024 },
    ]);
  });
  test("maps every stable helper error from stderr", async () => {
    for (const code of [
      "device-not-found",
      "device-not-booted",
      "private-api-unavailable",
      "unsupported-runtime",
      "no-carplay-screen",
      "power-on-failed",
    ]) {
      const powerer = new DefaultCarPlayScreenPowerer(
        async () => {
          throw Object.assign(new Error("exit 1"), {
            stderr: JSON.stringify({ error: { code, message: "remedy" } }),
          });
        },
        { AUTOMOBILE_CARPLAY_POWER_HELPER_PATH: "/helper" },
      );
      await expect(powerer.status("id")).rejects.toThrow(`[${code}] remedy`);
    }
  });
  test("reports unset, missing executable and invalid stderr actionably", async () => {
    const unset = new DefaultCarPlayScreenPowerer(async () => {
      throw new Error("must not execute");
    }, {});
    await expect(unset.status("id")).rejects.toThrow("AUTOMOBILE_CARPLAY_POWER_HELPER_PATH");
    for (const error of [
      Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
      Object.assign(new Error("bad exit"), { stderr: "broken json" }),
    ]) {
      const powerer = new DefaultCarPlayScreenPowerer(
        async () => {
          throw error;
        },
        { AUTOMOBILE_CARPLAY_POWER_HELPER_PATH: "/missing" },
      );
      await expect(powerer.status("id")).rejects.toThrow(ActionableError);
    }
  });
  test("fake records calls and returns configured state", async () => {
    const fake = new FakeCarPlayScreenPowerer(state);
    expect(await fake.status("one")).toEqual(state);
    await fake.powerOn("two");
    expect(fake.calls).toEqual([
      { udid: "one", action: "status" },
      { udid: "two", action: "power-on" },
    ]);
  });
  test("both Swift CI runners register the package beside audio-loopback", () => {
    for (const file of ["scripts/ios/swift-build.sh", "scripts/ios/swift-test.sh"]) {
      // Windows checkouts use CRLF line endings.
      const script = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
      expect(script).toContain('"audio-loopback"\n    "carplay-power"');
    }
  });
});
