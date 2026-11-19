import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ActionableError } from "../../../src/models/ActionableError";
import {
  DefaultCarPlayScreenPowerer,
  parseCarPlayPowerState,
} from "../../../src/utils/ios/carPlayScreenPower";
import { FakeCarPlayScreenPowerer } from "../../fakes/FakeCarPlayScreenPowerer";

const fixtureDir = join(import.meta.dir, "../../fixtures/ios-carplay");
const statusJson = readFileSync(join(fixtureDir, "power-status-ios26.5-fresh.json"), "utf8");
const powerOnJson = readFileSync(join(fixtureDir, "power-on-ios26.5.json"), "utf8");

describe("CarPlay screen power", () => {
  test("parses captured status and power-on JSON for TVOut", () => {
    const status = parseCarPlayPowerState(statusJson);
    const powered = parseCarPlayPowerState(powerOnJson);
    expect(status.carPlay).toEqual({ found: true, powerState: 0 });
    expect(powered.carPlay).toEqual({ found: true, powerState: 1 });
    expect(powered.screens).toContainEqual({
      id: 2,
      name: "TVOut",
      screenType: 1,
      powerState: 1,
      width: 800,
      height: 480,
    });
  });

  test("rejects malformed contracts and the obsolete enabled key", () => {
    const state = parseCarPlayPowerState(powerOnJson);
    for (const value of [
      "not json",
      "{}",
      powerOnJson + powerOnJson,
      JSON.stringify({ ...state, extra: true }),
      JSON.stringify({ ...state, carPlay: { ...state.carPlay, enabled: null } }),
      powerOnJson.replace('"width":800', '"width":"800"'),
    ]) {
      expect(() => parseCarPlayPowerState(value)).toThrow(ActionableError);
    }
  });
  test("runs status and power-on argv with the existing timeout", async () => {
    const calls: string[][] = [];
    const powerer = new DefaultCarPlayScreenPowerer(
      async (file, args, options) => {
        calls.push([file, ...args]);
        expect(options?.timeout).toBe(135000);
        return { stdout: args[1] === "status" ? statusJson : powerOnJson, stderr: "" };
      },
      { AUTOMOBILE_CARPLAY_POWER_HELPER_PATH: "/helper with spaces" },
    );
    expect(await powerer.status("udid")).toEqual(parseCarPlayPowerState(statusJson));
    expect(await powerer.powerOn("udid")).toEqual(parseCarPlayPowerState(powerOnJson));
    expect(calls).toEqual([
      ["/helper with spaces", "udid", "status"],
      ["/helper with spaces", "udid", "power-on"],
    ]);
  });
  test("maps every stable helper error from stderr", async () => {
    for (const code of [
      "device-not-found",
      "device-not-booted",
      "private-api-unavailable",
      "no-carplay-screen",
      "power-on-failed",
      "usage",
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
  test("maps the captured iOS 27.0 refusal from stderr", async () => {
    const stderr = readFileSync(join(fixtureDir, "power-on-ios27.0-refusal.json"));
    const powerer = new DefaultCarPlayScreenPowerer(
      async () => {
        throw Object.assign(new Error("exit 1"), { stderr });
      },
      { AUTOMOBILE_CARPLAY_POWER_HELPER_PATH: "/helper" },
    );
    await expect(powerer.powerOn("id")).rejects.toThrow(
      "[unsupported-runtime] CarPlay power-on supports iOS 26.x simulators only.",
    );
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
    const state = parseCarPlayPowerState(powerOnJson);
    const fake = new FakeCarPlayScreenPowerer(state);
    expect(await fake.status("one")).toEqual(state);
    expect(await fake.powerOn("two")).toEqual(state);
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
