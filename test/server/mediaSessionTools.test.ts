import { describe, expect, test } from "bun:test";
import { createMediaSessionHandler, mediaSessionSchema } from "../../src/server/mediaSessionTools";
import { mediaSessionResultSchema } from "../../src/server/mediaSessionToolOutputSchemas";
import { ActionableError, type BootedDevice } from "../../src/models";
import type { MediaSessionInfo } from "../../src/features/media/MediaSessionTypes";
import { waitForTimeoutError } from "../../src/utils/plan/waitForTimeout";
import { FakeMediaSessionController } from "../fakes/FakeMediaSessionController";
import { toolJson } from "../helpers/toolResponse";

const android: BootedDevice = { name: "Pixel", deviceId: "emulator-5554", platform: "android" };
const ios: BootedDevice = { name: "iPhone", deviceId: "sim-1", platform: "ios" };
const PLAYER = { package: "dev.example.player", tag: "PlaybackService", userId: 0 };
const playing: MediaSessionInfo = {
  ...PLAYER,
  active: true,
  state: "playing",
  stateCode: 3,
  positionMs: 42150,
  speed: 1,
  actions: ["play", "pause"],
  metadata: { title: "Night Drive", artist: "Example Artist", album: "Example Album", size: 7 },
  isMediaButtonSession: true,
};
const pausedDump = {
  sessions: [{ ...playing, state: "paused" as const, stateCode: 2, speed: 0 }],
  mediaButtonSession: PLAYER,
};

function setup() {
  const controller = new FakeMediaSessionController();
  const handler = createMediaSessionHandler(() => controller);
  return { controller, handler };
}

/** Text JSON of a response, checked against the advertised output schema. */
function payload(response: unknown): Record<string, unknown> {
  const json = toolJson(response);
  expect(mediaSessionResultSchema.safeParse(json).success).toBe(true);
  return json;
}

describe("mediaSession input schema", () => {
  test.each([
    { action: "get" },
    { action: "get", appId: "dev.example.player", waitFor: { mediaState: "playing" } },
    { action: { dispatch: "play-pause" } },
    { action: { volume: { stream: "alarm", level: 3 } } },
  ])("accepts %j", (args) => {
    expect(mediaSessionSchema.safeParse(args).success).toBe(true);
  });

  test.each([
    {},
    { action: "set" },
    { action: { dispatch: "eject" } },
    { action: { dispatch: "play", extra: true } },
    { action: { volume: { stream: "voice_call", level: 1 } } },
    { action: { volume: { stream: "music", level: -1 } } },
    { action: "get", waitFor: { mediaState: "unknown" } },
    { action: "get", unknownField: 1 },
  ])("rejects %j", (args) => {
    expect(mediaSessionSchema.safeParse(args).success).toBe(false);
  });
});

describe("mediaSession handler", () => {
  test("get returns typed sessions and names the media button session", async () => {
    const { controller, handler } = setup();
    controller.dump = { sessions: [playing], mediaButtonSession: PLAYER };

    const result = payload(await handler(android, { action: "get", appId: "dev.example.player" }));

    expect(result).toMatchObject({
      success: true,
      action: "get",
      sessions: [playing],
      mediaButtonSession: PLAYER,
    });
    expect(result.message).toContain('dev.example.player/PlaybackService: playing "Night Drive"');
    expect(controller.calls[0]).toMatchObject({
      method: "getSessions",
      request: { appId: "dev.example.player" },
    });
  });

  test("get with waitFor reports the match", async () => {
    const { controller, handler } = setup();
    controller.waitResult = {
      matched: true,
      waitMs: 750,
      polls: 4,
      dump: { sessions: [playing], mediaButtonSession: PLAYER },
    };

    const result = payload(
      await handler(android, {
        action: "get",
        waitFor: { mediaState: "playing", timeoutMs: 3000 },
      }),
    );

    expect(result.wait).toEqual({ mediaState: "playing", matched: true, waitMs: 750, polls: 4 });
    expect(result.awaitTimeout).toBeUndefined();
    expect(controller.calls[0].request).toMatchObject({ mediaState: "playing", timeoutMs: 3000 });
  });

  test("a waitFor timeout is reported the way the plan executor fails a step", async () => {
    const { controller, handler } = setup();
    controller.waitResult = { matched: false, waitMs: 5000, polls: 21, dump: pausedDump };

    const result = payload(
      await handler(android, { action: "get", waitFor: { mediaState: "playing" } }),
    );

    expect(result).toMatchObject({ awaitTimeout: true, awaitDuration: 5000 });
    expect(controller.calls[0].request).toMatchObject({ timeoutMs: 5000 });
    expect(waitForTimeoutError(result, "mediaSession")).toBe(
      "mediaSession waitFor timed out after 5000ms",
    );
  });

  test("dispatch reports the handling session, the transition and the restore receipt", async () => {
    const { controller, handler } = setup();
    controller.dispatchResult = {
      handledBy: PLAYER,
      previousState: "playing",
      state: "paused",
      stateChanged: true,
      restore: { dispatch: "play" },
      dump: pausedDump,
    };

    const result = payload(await handler(android, { action: { dispatch: "pause" } }));

    expect(result).toMatchObject({
      success: true,
      action: "dispatch",
      message: "Dispatched pause to dev.example.player/PlaybackService: playing -> paused",
      dispatch: {
        key: "pause",
        handledBy: PLAYER,
        previousState: "playing",
        state: "paused",
        stateChanged: true,
      },
      restore: { dispatch: "play" },
      sessions: pausedDump.sessions,
    });
  });

  test("volume returns what changed and a restore receipt", async () => {
    const { controller, handler } = setup();
    controller.volumeResult = {
      stream: "music",
      previousLevel: 7,
      level: 12,
      requestedLevel: 12,
      min: 0,
      max: 25,
      changed: true,
      verified: true,
      restore: { volume: { stream: "music", level: 7 } },
    };

    const result = payload(
      await handler(android, { action: { volume: { stream: "music", level: 12 } } }),
    );

    expect(result).toMatchObject({
      success: true,
      action: "volume",
      volume: { stream: "music", previousLevel: 7, level: 12, changed: true, verified: true },
      restore: { volume: { stream: "music", level: 7 } },
    });
  });

  test("an unverified volume write is a failed result that still carries the receipt", async () => {
    const { controller, handler } = setup();
    controller.volumeResult = {
      stream: "ring",
      previousLevel: 3,
      level: 5,
      requestedLevel: 6,
      min: 0,
      max: 7,
      changed: true,
      verified: false,
      restore: { volume: { stream: "ring", level: 3 } },
    };

    const result = payload(
      await handler(android, { action: { volume: { stream: "ring", level: 6 } } }),
    );

    expect(result.success).toBe(false);
    expect(result.restore).toEqual({ volume: { stream: "ring", level: 3 } });
  });

  test("refuses iOS and waitFor on a mutation before touching the device", async () => {
    const { controller, handler } = setup();

    await expect(handler(ios, { action: "get" })).rejects.toBeInstanceOf(ActionableError);
    await expect(
      handler(android, { action: { dispatch: "play" }, waitFor: { mediaState: "playing" } }),
    ).rejects.toThrow('waitFor is only valid with action "get"');
    expect(controller.calls).toEqual([]);
  });
});
