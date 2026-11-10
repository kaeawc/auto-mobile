import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { ActionableError } from "../../../src/models/ActionableError";
import {
  DefaultCarPlayScreenPowerer,
  parseCarPlayPowerState,
} from "../../../src/utils/ios/carPlayScreenPower";
import { FakeCarPlayScreenPowerer } from "../../fakes/FakeCarPlayScreenPowerer";

// Matches CarPlayPowerCore's Codable CarPlayPowerState contract.
const state = {
  screens: [{ id: 3, name: "Wireless", screenType: 2, powerState: 1, width: 720, height: 480 }],
  carPlay: { found: true, powerState: 1, enabled: null },
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
    ]) {
      expect(() => parseCarPlayPowerState(value)).toThrow(ActionableError);
    }
  });
  test("runs argv through the seam, including enable only when requested", async () => {
    const calls: string[][] = [];
    const powerer = new DefaultCarPlayScreenPowerer(
      async (file, args) => {
        calls.push([file, ...args]);
        return { stdout: encoded, stderr: "" };
      },
      { AUTOMOBILE_CARPLAY_POWER_HELPER_PATH: "/helper with spaces" },
    );
    expect(await powerer.status("udid")).toEqual(state);
    await powerer.powerOn("udid", { enable: true });
    expect(calls).toEqual([
      ["/helper with spaces", "udid", "status"],
      ["/helper with spaces", "udid", "power-on", "--enable"],
    ]);
  });
  test("maps every stable helper error from stderr", async () => {
    for (const code of [
      "device-not-found",
      "device-not-booted",
      "private-api-unavailable",
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
    await fake.powerOn("two", { enable: false });
    expect(fake.calls).toEqual([
      { udid: "one", action: "status" },
      { udid: "two", action: "power-on", enable: false },
    ]);
  });
  test("both Swift CI runners register the package beside audio-loopback", () => {
    for (const file of ["scripts/ios/swift-build.sh", "scripts/ios/swift-test.sh"]) {
      expect(readFileSync(file, "utf8")).toContain('"audio-loopback"\n    "carplay-power"');
    }
  });
});
