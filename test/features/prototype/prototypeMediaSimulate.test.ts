import { describe, expect, test } from "bun:test";
import {
  simulatePrototypeMedia,
  validatePrototypeMediaSimPayload,
} from "../../../src/features/prototype/prototypeMediaSimulate";
import { FakePrototypeMediaSimRoute } from "../../fakes/FakePrototypeMediaSimRoute";

describe("simulatePrototypeMedia", () => {
  test("drives a fake engine to error and back to ready", async () => {
    const route = new FakePrototypeMediaSimRoute("fake");
    route.media.load("main", 10000);
    route.media.play("main");
    expect(
      await simulatePrototypeMedia(route, {
        id: "feed",
        event: "media.statusChanged",
        data: { player: "main", status: "error", code: "network", advanceMs: 5000 },
        timeoutMs: 500,
      }),
    ).toEqual({ success: true, mediaEngine: "fake" });
    expect(route.media.snapshot().players.main).toMatchObject({
      status: "error",
      error: "network",
      positionMs: 5000,
    });
    expect(
      await simulatePrototypeMedia(route, {
        id: "feed",
        event: "media.statusChanged",
        data: { player: "main", status: "ready" },
      }),
    ).toEqual({ success: true, mediaEngine: "fake" });
    expect(route.media.snapshot().players.main?.status).toBe("ready");
    expect(route.delivered.map((entry) => entry.id)).toEqual(["feed", "feed"]);
    expect(route.delivered[0]?.timeoutMs).toBe(500);
  });

  test("refuses advanceMs on a native engine and sends nothing", async () => {
    const route = new FakePrototypeMediaSimRoute("native");
    const result = await simulatePrototypeMedia(route, {
      id: "feed",
      event: "media.ended",
      data: { player: "main", advanceMs: 1000 },
    });
    expect(result).toMatchObject({ success: false, code: "unsupported", mediaEngine: "native" });
    expect(result.success ? "" : result.error).toContain("advanceMs");
    expect(route.delivered).toEqual([]);
  });

  test("a native engine still receives an event without advanceMs", async () => {
    const route = new FakePrototypeMediaSimRoute("native");
    route.media.load("main", 1000);
    expect(await simulatePrototypePayload(route, { player: "main", code: "decode" })).toEqual({
      success: true,
      mediaEngine: "native",
    });
  });

  test("is unavailable without a media route or engine", async () => {
    for (const route of [undefined, new FakePrototypeMediaSimRoute(undefined)]) {
      expect(
        await simulatePrototypeMedia(route, {
          id: "feed",
          event: "media.ended",
          data: { player: "main" },
        }),
      ).toMatchObject({ success: false, code: "unavailable" });
    }
  });

  test("an engine refusal is invalid_args and a thrown delivery is platform_error", async () => {
    const route = new FakePrototypeMediaSimRoute("fake");
    expect(await simulatePrototypePayload(route, { player: "ghost", code: "network" })).toEqual({
      success: false,
      code: "invalid_args",
      mediaEngine: "fake",
      error: "simulate media failed: unknown_player",
    });
    route.failWith(new Error("socket closed"));
    expect(
      await simulatePrototypePayload(route, { player: "main", code: "network" }),
    ).toMatchObject({ success: false, code: "platform_error" });
  });

  test("validates every media event payload before asking the device", async () => {
    const invalid: Array<[Parameters<typeof validatePrototypeMediaSimPayload>[0], unknown]> = [
      ["media.statusChanged", { player: "main" }],
      ["media.statusChanged", { player: "main", status: "paused" }],
      ["media.statusChanged", { player: "main", status: "error" }],
      ["media.statusChanged", { player: "main", status: "ready", code: "network" }],
      ["media.statusChanged", { player: "", status: "ready" }],
      ["media.statusChanged", { player: "main", status: "ready", advanceMs: 0 }],
      ["media.statusChanged", { player: "main", status: "ready", advanceMs: 1.5 }],
      ["media.statusChanged", { player: "main", status: "ready", advanceMs: 3600001 }],
      ["media.ended", { player: "main", extra: true }],
      ["media.ended", {}],
      ["media.error", { player: "main" }],
      ["media.error", { player: "main", code: "teapot" }],
    ];
    const route = new FakePrototypeMediaSimRoute("fake");
    for (const [event, data] of invalid) {
      expect({
        event,
        data,
        result: await simulatePrototypeMedia(route, { id: "p", event, data }),
      }).toMatchObject({ event, data, result: { success: false, code: "invalid_args" } });
    }
    expect(route.delivered).toEqual([]);
    expect(validatePrototypeMediaSimPayload("media.error", { player: "main" })).toEqual({
      success: false,
      error: "code: Required",
    });
    expect(validatePrototypeMediaSimPayload("media.ended", {})).toEqual({
      success: false,
      error: "player: Required",
    });
    // A present but wrong value keeps Zod's own message; only an omitted field reads Required.
    const wrongCode = validatePrototypeMediaSimPayload("media.error", {
      player: "main",
      code: "teapot",
    });
    expect(wrongCode.success).toBe(false);
    expect(wrongCode).not.toMatchObject({ error: "code: Required" });
    expect(wrongCode).toMatchObject({ error: expect.stringContaining("code: Invalid option") });
    expect(
      validatePrototypeMediaSimPayload("media.statusChanged", {
        player: "main",
        status: "buffering",
        advanceMs: 250,
      }),
    ).toEqual({
      success: true,
      request: {
        event: "media.statusChanged",
        player: "main",
        status: "buffering",
        advanceMs: 250,
      },
    });
  });
});

function simulatePrototypePayload(route: FakePrototypeMediaSimRoute, data: unknown) {
  return simulatePrototypeMedia(route, { id: "feed", event: "media.error", data });
}
