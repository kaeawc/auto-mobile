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

// Real projection probe captures from fresh iPhone 17 Pro simulators (#18728):
// iOS 26.5 after boot: TVOut attached, untagged.
const untaggedJson =
  '{"deviceName":"PurpleTVOut","displayId":2,"displayType":1,"found":true,"identity":"Untagged[2]","isCarDisplay":false,"isCarInstrumentsDisplay":false,"name":"TVOut","tag":0}';
// iOS 26.5 after carplay-power-helper power-on: TVOut is the car display.
const carJson =
  '{"deviceName":"PurpleTVOut","displayId":2,"displayType":1,"found":true,"identity":"Car[2]","isCarDisplay":true,"isCarInstrumentsDisplay":false,"name":"TVOut","tag":32}';
// iOS 27.0 after boot: TVOut's deviceName is external-0.
const ios27Json =
  '{"deviceName":"external-0","displayId":2,"displayType":1,"found":true,"identity":"Untagged[2]","isCarDisplay":false,"isCarInstrumentsDisplay":false,"name":"TVOut","tag":0}';
// The earlier iOS 27.0 wireless0 AirPlay capture (tag=4 dt=2 did=3), with the name fields the
// probe now reports added.
const airPlayJson =
  '{"deviceName":"wireless0","displayId":3,"displayType":2,"found":true,"identity":"AirPlay[3]","isCarDisplay":false,"isCarInstrumentsDisplay":false,"name":"Wireless","tag":4}';
// Synthetic instruments control, not a real capture.
const instrumentsJson =
  '{"found":true,"tag":64,"displayId":2,"displayType":1,"identity":"CarInstruments[2]","name":"TVOut","deviceName":"PurpleTVOut","isCarDisplay":false,"isCarInstrumentsDisplay":true}';
const absent = {
  found: false as const,
  tag: null,
  displayId: null,
  displayType: null,
  identity: null,
  name: null,
  deviceName: null,
  isCarDisplay: false as const,
  isCarInstrumentsDisplay: false as const,
};
const env = { AUTOMOBILE_CARPLAY_PROJECTION_PROBE_PATH: "/probe with spaces" };

describe("CarPlay projection", () => {
  test("parses captured 26.5 untagged, 26.5 car, 27.0 untagged and AirPlay states", () => {
    for (const [json, tag, displayId, identity, deviceName] of [
      [untaggedJson, 0, 2, "Untagged[2]", "PurpleTVOut"],
      [carJson, 32, 2, "Car[2]", "PurpleTVOut"],
      [ios27Json, 0, 2, "Untagged[2]", "external-0"],
      [airPlayJson, 4, 3, "AirPlay[3]", "wireless0"],
    ] as const) {
      expect(parseCarPlayProjectionState(json + "\n")).toEqual({
        found: true,
        tag,
        displayId,
        displayType: displayId === 2 ? 1 : 2,
        identity,
        name: displayId === 2 ? "TVOut" : "Wireless",
        deviceName,
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
      JSON.stringify({ ...car, name: null }),
      JSON.stringify({ ...absent, deviceName: "PurpleTVOut" }),
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

  test("caps the exec timeout at the caller's budget and forwards its signal", async () => {
    const seen: unknown[] = [];
    const probe = new DefaultCarPlayProjectionProbe(async (_file, _args, options) => {
      seen.push(options);
      return { stdout: Buffer.from(carJson), stderr: "" };
    }, env);
    const signal = new AbortController().signal;
    await probe.probe("udid", { signal, timeoutMs: 4000 });
    await probe.probe("udid", { timeoutMs: 60_000 });
    expect(seen).toEqual([
      { timeout: 4000, maxBuffer: 1024 * 1024, signal },
      { timeout: 15000, maxBuffer: 1024 * 1024 },
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

  test("refuses AirPlay projection with screen, identity, black-frame explanation and remedy", () => {
    const state = parseCarPlayProjectionState(airPlayJson);
    for (const message of [
      "CarPlay screen Wireless is attached but not projecting (AirPlay[3])",
      "Capture was skipped because the frame would be black",
      "Run carplay-power-helper power-on",
      "after every boot of an iOS 26.x simulator",
      "the iOS 27 Simulator does not support CarPlay",
    ]) {
      expect(() => assertCarPlayProjecting(state)).toThrow(message);
    }
    expect(() => assertCarPlayProjecting(state)).toThrow(/^(?![\s\S]*(#\d|\]\(|https?:))/);
  });

  test("refuses an untagged TVOut or a missing car screen with the power-on remedy", () => {
    for (const state of [
      parseCarPlayProjectionState(untaggedJson),
      parseCarPlayProjectionState(ios27Json),
      absent,
    ]) {
      expect(() => assertCarPlayProjecting(state)).toThrow(ActionableError);
      expect(() => assertCarPlayProjecting(state)).toThrow("carplay-power-helper power-on");
      expect(() => assertCarPlayProjecting(state)).toThrow("frame would be black");
    }
    expect(() => assertCarPlayProjecting(absent)).toThrow("No CarPlay screen (TVOut or AirPlay");
    expect(() => assertCarPlayProjecting(parseCarPlayProjectionState(untaggedJson))).toThrow(
      "TVOut is attached but not projecting (Untagged[2])",
    );
  });

  test("allows the captured Car state and a synthetic CarInstruments state", () => {
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
