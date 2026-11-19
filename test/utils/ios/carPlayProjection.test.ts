import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ActionableError } from "../../../src/models/ActionableError";
import {
  assertCarPlayProjecting,
  carPlayProjectionStateSchema,
  DefaultCarPlayProjectionProbe,
  parseCarPlayProjectionState,
  requireCarPlayProjection,
} from "../../../src/utils/ios/carPlayProjection";
import { FakeCarPlayProjectionProbe } from "../../fakes/FakeCarPlayProjectionProbe";

const fixtureDir = join(import.meta.dir, "../../fixtures/ios-carplay");
const carJson = readFileSync(join(fixtureDir, "projection-probe-ios26.5-car.json"), "utf8");
const airPlayJson = readFileSync(join(fixtureDir, "projection-probe-ios26.5-airplay.json"), "utf8");
const absentJson = readFileSync(
  join(fixtureDir, "projection-probe-ios26.5-not-found.json"),
  "utf8",
);
const untaggedJson = readFileSync(
  join(fixtureDir, "projection-probe-ios27.0-wireless0-untagged.json"),
  "utf8",
);
const absent = {
  found: false as const,
  tag: null,
  displayId: null,
  deviceName: null,
  displayType: null,
  identity: null,
  isCarDisplay: false as const,
  isCarInstrumentsDisplay: false as const,
};
const env = { AUTOMOBILE_CARPLAY_PROJECTION_PROBE_PATH: "/probe with spaces" };

describe("CarPlay projection", () => {
  test("parses captured iOS 26.5 and 27.0 probe states", () => {
    for (const [json, tag, displayId, deviceName, displayType, identity] of [
      [carJson, 32, 2, "PurpleTVOut", 1, "Car[2]"],
      [airPlayJson, 6, 2, "PurpleTVOut", 1, "AirPlay[2]"],
      [untaggedJson, 0, 3, "wireless0", 2, "Untagged[3]"],
    ] as const) {
      expect(parseCarPlayProjectionState(json)).toEqual({
        found: true,
        tag,
        displayId,
        deviceName,
        displayType,
        identity,
        isCarDisplay: tag === 32,
        isCarInstrumentsDisplay: false,
      });
    }
    expect(parseCarPlayProjectionState(absentJson)).toEqual(absent);
  });

  test("rejects malformed, extra, missing, wrongly typed and inconsistent absent fields", () => {
    const car = parseCarPlayProjectionState(carJson);
    for (const value of [
      "not json",
      "{}",
      carJson + carJson,
      JSON.stringify({ ...car, extra: true }),
      JSON.stringify({ ...car, tag: "32" }),
      JSON.stringify({ ...car, displayId: 3.5 }),
      JSON.stringify({ ...car, deviceName: "" }),
      JSON.stringify({ ...car, deviceName: null }),
      JSON.stringify({ ...car, deviceName: undefined }),
      JSON.stringify({ ...car, identity: null }),
      JSON.stringify({ ...car, isCarDisplay: undefined }),
      JSON.stringify({ ...absent, tag: 0 }),
      JSON.stringify({ ...absent, deviceName: "PurpleTVOut" }),
      JSON.stringify({ ...absent, isCarDisplay: true }),
    ]) {
      expect(() => parseCarPlayProjectionState(value)).toThrow(ActionableError);
    }
  });

  test("passes spawn argv, a bounded deadline and buffer through the exec seam", async () => {
    const calls: unknown[] = [];
    const probe = new DefaultCarPlayProjectionProbe(async (file, args, options) => {
      calls.push({ file, args, options });
      return { stdout: Buffer.from(airPlayJson), stderr: "" };
    }, env);
    expect(await probe.probe("udid with spaces")).toEqual(parseCarPlayProjectionState(airPlayJson));
    expect(calls).toEqual([
      {
        file: "xcrun",
        args: ["simctl", "spawn", "udid with spaces", "/probe with spaces"],
        options: { timeout: 15000, maxBuffer: 1024 * 1024 },
      },
    ]);
  });

  test("rejects unset/blank paths without executing", async () => {
    for (const path of [undefined, "", "  "]) {
      const probe = new DefaultCarPlayProjectionProbe(
        async () => {
          throw new Error("must not execute");
        },
        { AUTOMOBILE_CARPLAY_PROJECTION_PROBE_PATH: path },
      );
      await expect(probe.probe("id")).rejects.toThrow(
        "set AUTOMOBILE_CARPLAY_PROJECTION_PROBE_PATH",
      );
    }
  });

  test("reports exec failures and deadline expiry actionably without sleeping", async () => {
    // Exec owns the timer; simulate its rejection instead of waiting 15 seconds.
    for (const error of [
      new Error("ENOENT"),
      Object.assign(new Error("deadline expired"), { code: "ETIMEDOUT", killed: true }),
      Object.assign(new Error("exit 1"), { stderr: "private API unavailable" }),
    ]) {
      const probe = new DefaultCarPlayProjectionProbe(async () => {
        throw error;
      }, env);
      await expect(probe.probe("id")).rejects.toThrow(ActionableError);
      await expect(probe.probe("id")).rejects.toThrow(
        "check AUTOMOBILE_CARPLAY_PROJECTION_PROBE_PATH",
      );
      await expect(probe.probe("id")).rejects.toThrow(error.message);
    }
  });

  test("invalid exec output retains the parser's remedy", async () => {
    const probe = new DefaultCarPlayProjectionProbe(
      async () => ({ stdout: "{}", stderr: "" }),
      env,
    );
    await expect(probe.probe("id")).rejects.toThrow("Invalid CarPlay projection probe JSON");
  });

  test("refuses AirPlay projection with identity, black-frame explanation and remedy", () => {
    const state = parseCarPlayProjectionState(airPlayJson);
    for (const message of [
      "attached but not projecting (AirPlay[2])",
      "Capture was skipped because the frame would be black",
      "Open the CarPlay window in Simulator.app, then retry.",
    ]) {
      expect(() => assertCarPlayProjecting(state)).toThrow(message);
    }
    expect(() => assertCarPlayProjecting(state)).toThrow(/^(?![\s\S]*(#\d|\]\(|https?:))/);
  });

  test("provides the iOS 26.x power-on hint for untagged or missing displays", () => {
    for (const json of [untaggedJson, absentJson]) {
      const state = parseCarPlayProjectionState(json);
      expect(() => assertCarPlayProjecting(state)).toThrow(ActionableError);
      expect(() => assertCarPlayProjecting(state)).toThrow(
        "On iOS 26.x, power on the CarPlay screen via ios/carplay-power.",
      );
      expect(() => assertCarPlayProjecting(state)).toThrow("frame would be black");
    }
    expect(() => assertCarPlayProjecting(absent)).toThrow("No CarPlay display was found");
    expect(() => assertCarPlayProjecting(parseCarPlayProjectionState(untaggedJson))).toThrow(
      "Untagged[3]",
    );
  });

  test("allows the captured Car state and a synthetic CarInstruments state", () => {
    const car = parseCarPlayProjectionState(carJson);
    const instruments = parseCarPlayProjectionState(
      JSON.stringify({
        ...car,
        tag: 64,
        identity: "CarInstruments[2]",
        isCarDisplay: false,
        isCarInstrumentsDisplay: true,
      }),
    );
    expect(assertCarPlayProjecting(car)).toBeUndefined();
    expect(assertCarPlayProjecting(instruments)).toBeUndefined();
  });

  test("require probes the selected device and propagates refusal or probe failure", async () => {
    const car = parseCarPlayProjectionState(carJson);
    assertCarPlayProjecting(car);
    const fake = new FakeCarPlayProjectionProbe(car);
    expect(await requireCarPlayProjection("one", fake)).toBe(car);
    fake.state = parseCarPlayProjectionState(airPlayJson);
    await expect(requireCarPlayProjection("two", fake)).rejects.toThrow(
      "not projecting (AirPlay[2])",
    );
    fake.error = new ActionableError("probe failed");
    await expect(requireCarPlayProjection("three", fake)).rejects.toBe(fake.error);
    expect(fake.calls).toEqual(["one", "two", "three"]);
  });

  test("probe.m emits exactly the schema's keys in both branches, with a self-deadline", () => {
    const source = readFileSync(
      join(import.meta.dir, "../../../ios/carplay-projection-probe/probe.m"),
      "utf8",
    );
    // Each `state = @{ ... }` literal is one JSON branch the probe can print.
    const literals = [...source.matchAll(/state = @\{([^}]*)\}/g)].map((match) =>
      [...match[1].matchAll(/@"(\w+)":/g)].map((key) => key[1]).sort(),
    );
    const schemaKeys = carPlayProjectionStateSchema.options.map((option) =>
      Object.keys(option.shape).sort(),
    );
    expect(literals).toHaveLength(2);
    expect(literals).toEqual(schemaKeys.toReversed());
    expect(source).toContain("NSJSONWritingSortedKeys");
    const deadline = Number(/kProbeDeadlineSeconds = (\d+);/.exec(source)?.[1]);
    expect(source).toContain("alarm(kProbeDeadlineSeconds)");
    expect(deadline * 1000).toBeLessThan(15000);
  });
});
