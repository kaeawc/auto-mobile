import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  AospMediaSessionDumpParser,
  decodePlaybackActions,
  playbackStateForCode,
} from "../../../src/features/media/MediaSessionDumpParser";

// Captured with `adb shell dumpsys media_session` on emulators; the player is the repository's
// tv-fixture app. See test/fixtures/android-media-session/README.md.
function fixture(name: string): string {
  return readFileSync(
    new URL(`../../fixtures/android-media-session/${name}.txt`, import.meta.url),
    "utf8",
  );
}

const parser = new AospMediaSessionDumpParser();
const PLAYER = {
  package: "dev.jasonpearson.automobile.tvfixture",
  tag: "AutoMobileTvFixture",
  userId: 0,
};
const PLAYER_ACTIONS = [
  "stop",
  "pause",
  "play",
  "rewind",
  "skip_to_previous",
  "skip_to_next",
  "fast_forward",
  "play_pause",
];
const METADATA = {
  title: "Opening Titles",
  description: "Opening Titles, null, null",
  size: 3,
};

describe("AospMediaSessionDumpParser", () => {
  test("API 34: named state codes, the player among the system's own sessions", () => {
    const dump = parser.parse(fixture("dumpsys-media-session-playing-phone-api34"));

    expect(dump.mediaButtonSession).toBeNull();
    expect(dump.sessions.map((session) => session.package)).toEqual([
      "com.android.server.telecom",
      PLAYER.package,
      "com.google.android.bluetooth",
      "com.google.android.bluetooth",
      "com.google.android.bluetooth",
      "com.google.android.bluetooth",
    ]);
    expect(dump.sessions[1]).toEqual({
      ...PLAYER,
      active: true,
      state: "playing",
      stateCode: 3,
      positionMs: 0,
      positionUpdatedAtMs: 2_058_612,
      speed: 0,
      actions: PLAYER_ACTIONS,
      metadata: METADATA,
      isMediaButtonSession: false,
    });
  });

  test("API 34: a Bluetooth session in ERROR carries the error state and no actions", () => {
    const dump = parser.parse(fixture("dumpsys-media-session-idle-phone-api34"));

    expect(dump.sessions[1]).toMatchObject({
      package: "com.google.android.bluetooth",
      tag: "BluetoothMediaBrowserService",
      active: false,
      state: "error",
      stateCode: 7,
      positionUpdatedAtMs: 58_253,
      actions: [],
    });
  });

  test("API 34: the dump after a pause key reads paused at speed 0", () => {
    const dump = parser.parse(fixture("dumpsys-media-session-paused-phone-api34"));

    expect(dump.sessions.find((session) => session.package === PLAYER.package)).toMatchObject({
      ...PLAYER,
      state: "paused",
      stateCode: 2,
      positionUpdatedAtMs: 2_060_728,
      speed: 0,
      metadata: METADATA,
    });
  });

  test("with no app playing, only system sessions remain and none is the media button session", () => {
    const dump = parser.parse(fixture("dumpsys-media-session-idle-phone-api34"));

    expect(dump.mediaButtonSession).toBeNull();
    expect(dump.sessions.some((session) => session.package === PLAYER.package)).toBe(false);
    expect(dump.sessions.every((session) => !session.active)).toBe(true);
  });

  test("API 30: bare numeric state codes and numeric volume types", () => {
    const dump = parser.parse(fixture("dumpsys-media-session-playing-phone-api30"));

    expect(dump.mediaButtonSession).toBeNull();
    expect(dump.sessions.find((session) => session.package === PLAYER.package)).toEqual({
      ...PLAYER,
      active: true,
      state: "playing",
      stateCode: 3,
      positionMs: 0,
      positionUpdatedAtMs: 144_051,
      speed: 0,
      actions: PLAYER_ACTIONS,
      metadata: METADATA,
      isMediaButtonSession: false,
    });
  });

  test("API 30: the system's YouTube sessions report numeric state 0 as none", () => {
    const dump = parser.parse(fixture("dumpsys-media-session-idle-phone-api30"));

    expect(
      dump.sessions
        .filter(
          (session) =>
            session.package.startsWith("com.google.android.youtube") ||
            session.package.startsWith("com.google.android.apps.youtube"),
        )
        .map((session) => [session.state, session.stateCode, session.speed]),
    ).toEqual([
      ["none", 0, 1],
      ["none", 0, 1],
    ]);
  });

  test("API 33: a paused player with numeric state 2", () => {
    const dump = parser.parse(fixture("dumpsys-media-session-paused-phone-api33"));

    expect(dump.sessions.at(-1)).toMatchObject({
      ...PLAYER,
      state: "paused",
      stateCode: 2,
      positionUpdatedAtMs: 277_755,
    });
  });

  test("a TV image lists only the player; Automotive adds its own local player", () => {
    const tv = parser.parse(fixture("dumpsys-media-session-playing-tv-api36"));
    expect(tv.sessions.map((session) => [session.package, session.state])).toEqual([
      [PLAYER.package, "playing"],
    ]);

    const car = parser.parse(fixture("dumpsys-media-session-playing-automotive-api34"));
    expect(car.sessions.map((session) => session.package)).toContain(
      "com.android.car.media.localmediaplayer",
    );
    expect(car.sessions.find((session) => session.package === PLAYER.package)?.state).toBe(
      "playing",
    );
  });

  test("the media button session line names the session it marks", () => {
    const dump = parser.parse(
      fixture("dumpsys-media-session-playing-phone-api34").replace(
        "Media button session is null",
        `Media button session is ${PLAYER.package}/${PLAYER.tag} (userId=0)`,
      ),
    );

    expect(dump.mediaButtonSession).toEqual(PLAYER);
    expect(dump.sessions.filter((session) => session.isMediaButtonSession)).toHaveLength(1);
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
