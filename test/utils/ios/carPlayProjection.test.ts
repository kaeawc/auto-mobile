import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ActionableError } from "../../../src/models/ActionableError";
import {
  assertCarPlayProjecting,
  carPlayProjectionStateSchema,
  DefaultCarPlayProjectionProbe,
  parseCarPlayProjectionState,
  requireCarPlayProjection,
} from "../../../src/utils/ios/carPlayProjection";
import { FakeCarPlayProjectionProbe } from "../../fakes/FakeCarPlayProjectionProbe";

// Real projection probe captures with boolean serialization corrected:
// wireless0 tag=0 dt=2 did=3 (powered off)
// wireless0 tag=4 dt=2 did=3 (powered on, AirPlay identity)
const untaggedJson =
  '{"displayId":3,"displayType":2,"found":true,"identity":"Untagged[3]","isCarDisplay":false,"isCarInstrumentsDisplay":false,"tag":0}';
const airPlayJson =
  '{"displayId":3,"displayType":2,"found":true,"identity":"AirPlay[3]","isCarDisplay":false,"isCarInstrumentsDisplay":false,"tag":4}';
// Synthetic positive control: no real Car capture exists yet.
const carJson =
  '{"found":true,"tag":32,"displayId":3,"displayType":2,"identity":"Car[3]","isCarDisplay":true,"isCarInstrumentsDisplay":false}';
// Synthetic instruments control, also not a real capture.
const instrumentsJson =
  '{"found":true,"tag":64,"displayId":3,"displayType":2,"identity":"CarInstruments[3]","isCarDisplay":false,"isCarInstrumentsDisplay":true}';
const absent = {
  found: false as const,
  tag: null,
  displayId: null,
  displayType: null,
  identity: null,
  isCarDisplay: false as const,
  isCarInstrumentsDisplay: false as const,
};
const env = { AUTOMOBILE_CARPLAY_PROJECTION_PROBE_PATH: "/probe with spaces" };

describe("CarPlay projection", () => {
  test("parses measured off/AirPlay states and synthetic Car state", () => {
    for (const [json, tag, identity] of [
      [untaggedJson, 0, "Untagged[3]"],
      [airPlayJson, 4, "AirPlay[3]"],
      [carJson, 32, "Car[3]"],
    ] as const) {
      expect(parseCarPlayProjectionState(json + "\n")).toEqual({
        found: true,
        tag,
        displayId: 3,
        displayType: 2,
        identity,
        isCarDisplay: tag === 32,
        isCarInstrumentsDisplay: false,
      });
    }
    expect(parseCarPlayProjectionState(JSON.stringify(absent))).toEqual(absent);
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
      JSON.stringify({ ...car, identity: null }),
      JSON.stringify({ ...car, isCarDisplay: undefined }),
      JSON.stringify({ ...absent, tag: 0 }),
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
      "attached but not projecting (AirPlay[3])",
      "Capture was skipped because the frame would be black",
      "Open the CarPlay window in Simulator.app, then retry.",
    ]) {
      expect(() => assertCarPlayProjecting(state)).toThrow(message);
    }
    expect(() => assertCarPlayProjecting(state)).toThrow(/^(?![\s\S]*(#\d|\]\(|https?:))/);
  });

  test("requires enablement and screen power for untagged or missing wireless0", () => {
    for (const state of [parseCarPlayProjectionState(untaggedJson), absent]) {
      expect(() => assertCarPlayProjecting(state)).toThrow(ActionableError);
      expect(() => assertCarPlayProjecting(state)).toThrow(
        "Enable CarPlay and power the screen on first",
      );
      expect(() => assertCarPlayProjecting(state)).toThrow("frame would be black");
    }
    expect(() => assertCarPlayProjecting(absent)).toThrow("not found (wireless0)");
    expect(() => assertCarPlayProjecting(parseCarPlayProjectionState(untaggedJson))).toThrow(
      "Untagged[3]",
    );
  });

  test("allows synthetic Car and CarInstruments states", () => {
    const car = parseCarPlayProjectionState(carJson);
    expect(assertCarPlayProjecting(car)).toBeUndefined();
    expect(assertCarPlayProjecting(parseCarPlayProjectionState(instrumentsJson))).toBeUndefined();
  });

  test("require probes the selected device and propagates refusal or probe failure", async () => {
    const fake = new FakeCarPlayProjectionProbe(parseCarPlayProjectionState(carJson));
    expect(await requireCarPlayProjection("one", fake)).toBeUndefined();
    fake.state = parseCarPlayProjectionState(airPlayJson);
    await expect(requireCarPlayProjection("two", fake)).rejects.toThrow(
      "not projecting (AirPlay[3])",
    );
    fake.error = new ActionableError("probe failed");
    await expect(requireCarPlayProjection("three", fake)).rejects.toBe(fake.error);
    expect(fake.calls).toEqual(["one", "two", "three"]);
  });

  test("probe.m emits exactly the schema's keys in both branches, with a self-deadline", () => {
    const source = readFileSync(
      resolve(import.meta.dir, "../../../ios/carplay-projection-probe/probe.m"),
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
