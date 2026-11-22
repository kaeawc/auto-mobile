import { describe, expect, test } from "bun:test";
import { parseIosSceneReady } from "../../../src/features/performance/iosSceneReadyParsing";

const APP = "com.apple.Preferences";
const fixtures = new URL("../../fixtures/ios-startup/", import.meta.url);
const [cold, warm, empty] = await Promise.all(
  ["cold", "warm", "empty"].map((mode) =>
    Bun.file(new URL(`log-show-${mode}-ios26.5.ndjson`, fixtures)).text(),
  ),
);

function event(timestamp: string, eventMessage: string): string {
  return JSON.stringify({ timestamp, eventMessage, subsystem: "com.apple.FrontBoard" });
}

const request = `Received request to open "${APP}" from CoreSimulatorBr:5537.`;
const ready = `[(FBSceneManager):sceneID:${APP}-default] scene content state changed: ready`;

describe("parseIosSceneReady", () => {
  test("parses the captured cold and warm timings, keeping the fractional request timestamp", () => {
    expect(parseIosSceneReady(cold, APP)).toEqual({
      requestTimestampMs: Date.parse("2026-11-19T13:06:36Z") + 303.186,
      ttidMs: 1557,
    });
    expect(parseIosSceneReady(warm, APP).ttidMs).toBe(71);
  });

  test("ignores the summary and stray non-JSON lines", () => {
    expect(parseIosSceneReady(empty, APP)).toEqual({ requestTimestampMs: null, ttidMs: null });
    expect(parseIosSceneReady(`getpwuid_r: no record\n{malformed\n${warm}`, APP).ttidMs).toBe(71);
  });

  test("does not reuse a ready event from before the latest request", () => {
    const nextRequest = event("2026-11-19 08:06:45.000003-0500", request);
    expect(
      parseIosSceneReady(
        [
          cold,
          nextRequest,
          event("2026-11-19 08:06:46.000003-0500", ready.replace("-default", "-secondary")),
        ].join("\n"),
        APP,
      ),
    ).toEqual({
      requestTimestampMs: Date.parse("2026-11-19T13:06:45Z") + 0.003,
      ttidMs: null,
    });
  });

  test("uses the first matching ready event after the latest request and applies numeric offsets", () => {
    const mixed = [
      warm,
      event("2026-11-19 18:36:50.999800+0530", request),
      event("2026-11-19 08:06:51.000310-0500", ready),
      event("2026-11-19 08:06:51.009000-0500", ready),
    ].join("\n");
    expect(parseIosSceneReady(mixed, APP).ttidMs).toBe(1);
  });

  test("accepts a session-backed UUID scene ID but not another app's scene", () => {
    const safari = "com.apple.mobilesafari";
    const scene = (id: string) =>
      `[(FBSceneManager):sceneID:${id}] scene content state changed: ready`;
    const log = (id: string) =>
      [
        event("2026-11-19 08:06:50.000000-0500", `Received request to open "${safari}" from x.`),
        event("2026-11-19 08:06:50.071000-0500", scene(id)),
      ].join("\n");
    expect(
      parseIosSceneReady(log(`${safari}-99296365-ED2B-4CB1-8BE1-D10FED611372`), safari).ttidMs,
    ).toBe(71);
    expect(parseIosSceneReady(log("comXapple.mobilesafari-default"), safari).ttidMs).toBeNull();
    expect(parseIosSceneReady(log(`${safari}-secondary`), safari).ttidMs).toBeNull();
  });
});
