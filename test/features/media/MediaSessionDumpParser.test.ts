import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  AospMediaSessionDumpParser,
  decodePlaybackActions,
  playbackStateForCode,
} from "../../../src/features/media/MediaSessionDumpParser";

// The fixtures are hand-reconstructed from the AOSP dump code, not device captures;
// see test/fixtures/android-media-session/README.md.
function fixture(name: string): string {
  return readFileSync(
    new URL(`../../fixtures/android-media-session/${name}.txt`, import.meta.url),
    "utf8",
  );
}

const parser = new AospMediaSessionDumpParser();
const PLAYER = { package: "dev.example.player", tag: "PlaybackService", userId: 0 };
const PLAYER_ACTIONS = [
  "stop",
  "pause",
  "play",
  "skip_to_previous",
  "skip_to_next",
  "seek_to",
  "play_pause",
];

describe("AospMediaSessionDumpParser", () => {
  test("API 34: named state codes, two sessions and the media button session", () => {
    const dump = parser.parse(fixture("dumpsys-media-session-api34-playing"));

    expect(dump.mediaButtonSession).toEqual(PLAYER);
    expect(dump.sessions).toEqual([
      {
        ...PLAYER,
        active: true,
        state: "playing",
        stateCode: 3,
        positionMs: 42150,
        positionUpdatedAtMs: 1834567,
        speed: 1,
        actions: PLAYER_ACTIONS,
        metadata: {
          title: "Night Drive",
          artist: "Example Artist",
          album: "Example Album",
          description: "Night Drive, Example Artist, Example Album",
          size: 7,
        },
        isMediaButtonSession: true,
      },
      {
        package: "com.example.podcasts",
        tag: "MediaSession",
        userId: 0,
        active: false,
        state: "paused",
        stateCode: 2,
        positionMs: 1205000,
        positionUpdatedAtMs: 1790012,
        speed: 0,
        actions: [
          "pause",
          "play",
          "rewind",
          "fast_forward",
          "seek_to",
          "play_pause",
          "set_playback_speed",
        ],
        metadata: {
          title: "Episode 12: Testing",
          artist: "The Test Podcast",
          description: "Episode 12: Testing, The Test Podcast, null",
          size: 4,
        },
        isMediaButtonSession: false,
      },
    ]);
  });

  test("API 34: the dump after a pause dispatch reads paused at speed 0", () => {
    const dump = parser.parse(fixture("dumpsys-media-session-api34-paused"));

    expect(dump.sessions[0]).toMatchObject({
      ...PLAYER,
      state: "paused",
      stateCode: 2,
      positionMs: 44980,
      speed: 0,
    });
  });

  test("API 30: bare numeric state codes and numeric volume types", () => {
    const dump = parser.parse(fixture("dumpsys-media-session-api30-playing"));

    expect(dump.mediaButtonSession).toEqual(PLAYER);
    expect(dump.sessions).toHaveLength(1);
    expect(dump.sessions[0]).toMatchObject({
      ...PLAYER,
      active: true,
      state: "playing",
      stateCode: 3,
      positionMs: 7310,
      speed: 1,
      actions: PLAYER_ACTIONS,
      metadata: { title: "Night Drive", artist: "Example Artist", album: "Example Album", size: 7 },
      isMediaButtonSession: true,
    });
  });

  test("API 28: metadata without a space after the colon and a null album", () => {
    const dump = parser.parse(fixture("dumpsys-media-session-api28-playing"));

    expect(dump.sessions[0]).toMatchObject({
      ...PLAYER,
      state: "playing",
      positionMs: 125000,
      speed: 1.25,
      metadata: { title: "Night Drive", artist: "Example Artist", size: 5 },
    });
    expect(dump.sessions[0].metadata?.album).toBeUndefined();
  });

  test("no sessions and a null media button session", () => {
    expect(parser.parse(fixture("dumpsys-media-session-api34-idle"))).toEqual({
      sessions: [],
      mediaButtonSession: null,
    });
  });

  test("a session that never set a playback state or metadata", () => {
    const dump = parser.parse(
      [
        "  Media button session is null",
        "  Sessions Stack - have 1 sessions:",
        "    Tag With Spaces dev.example.app/Tag With Spaces (userId=10)",
        "      ownerPid=1, ownerUid=1010001, userId=10",
        "      package=dev.example.app",
        "      active=false",
        "      state=null",
        "      metadata: null",
      ].join("\n"),
    );

    expect(dump.sessions).toEqual([
      {
        package: "dev.example.app",
        tag: "Tag With Spaces",
        userId: 10,
        active: false,
        state: "none",
        actions: [],
        isMediaButtonSession: false,
      },
    ]);
  });

  test("a comma inside the title keeps only the raw description", () => {
    const dump = parser.parse(
      [
        "    S dev.example.app/S (userId=0)",
        "      ownerPid=1, ownerUid=10001, userId=0",
        "      metadata: size=3, description=Hurry Up, We Are Dreaming, Artist, Album",
      ].join("\n"),
    );

    expect(dump.sessions[0].metadata).toEqual({
      description: "Hurry Up, We Are Dreaming, Artist, Album",
      size: 3,
    });
  });

  test("unrecognised output yields no sessions", () => {
    expect(parser.parse("Can't find service: media_session")).toEqual({
      sessions: [],
      mediaButtonSession: null,
    });
  });
});

describe("playback codes", () => {
  test("decodes action bits, including bits above 2^31", () => {
    expect(decodePlaybackActions(0)).toEqual([]);
    expect(decodePlaybackActions(2 ** 22 + 1)).toEqual(["stop", "set_playback_speed"]);
    expect(decodePlaybackActions(2 ** 40 + 4)).toEqual(["play"]);
  });

  test("maps state codes and reports unknown codes as unknown", () => {
    expect(playbackStateForCode(0)).toBe("none");
    expect(playbackStateForCode(6)).toBe("buffering");
    expect(playbackStateForCode(11)).toBe("skipping_to_queue_item");
    expect(playbackStateForCode(42)).toBe("unknown");
  });
});
