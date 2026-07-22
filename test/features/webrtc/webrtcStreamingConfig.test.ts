import { describe, expect, test } from "bun:test";
import {
  WEBRTC_ENV,
  parseIceServers,
  parseSize,
  resolveWebRtcStreamingConfig,
} from "../../../src/features/webrtc/webrtcStreamingConfig";

describe("parseIceServers", () => {
  test("parses a comma-separated URL list", () => {
    expect(parseIceServers("stun:a:1, turn:b:2")).toEqual([
      { urls: "stun:a:1" },
      { urls: "turn:b:2" },
    ]);
  });

  test("parses a JSON array of servers", () => {
    expect(
      parseIceServers('[{"urls":"turn:b:2","username":"u","credential":"c"}]')
    ).toEqual([{ urls: "turn:b:2", username: "u", credential: "c" }]);
  });

  test("expands an array-valued urls into one server per URL, sharing creds", () => {
    expect(
      parseIceServers(
        '[{"urls":["turn:t:3478","turns:t:5349"],"username":"u","credential":"p"}]'
      )
    ).toEqual([
      { urls: "turn:t:3478", username: "u", credential: "p" },
      { urls: "turns:t:5349", username: "u", credential: "p" },
    ]);
  });

  test("returns undefined for empty input", () => {
    expect(parseIceServers(undefined)).toBeUndefined();
    expect(parseIceServers("  ")).toBeUndefined();
  });

  test("throws on malformed JSON", () => {
    expect(() => parseIceServers("[not json")).toThrow();
  });
});

describe("parseSize", () => {
  test("parses WIDTHxHEIGHT", () => {
    expect(parseSize("1280x720")).toEqual({ width: 1280, height: 720 });
  });
  test("throws on bad format", () => {
    expect(() => parseSize("720p")).toThrow(/WIDTHxHEIGHT/);
  });

  test("rejects zero and odd dimensions before device startup", () => {
    expect(() => parseSize("0x720")).toThrow(/positive even integers/);
    expect(() => parseSize("721x1280")).toThrow(/positive even integers/);
  });

  test("rejects a frame that exceeds the advertised H.264 Level 4.2 capability", () => {
    expect(() => parseSize("2048x1080")).toThrow(/Level 4.2/);
  });
});

describe("resolveWebRtcStreamingConfig", () => {
  test("reads defaults from the environment", () => {
    const env = {
      [WEBRTC_ENV.WHIP_ENDPOINT]: "https://coord/whip",
      [WEBRTC_ENV.WHIP_TOKEN]: "tok",
      [WEBRTC_ENV.ICE_SERVERS]: "stun:s:1",
      [WEBRTC_ENV.BITRATE_KBPS]: "4000",
      [WEBRTC_ENV.MAX_SIZE]: "1280x720",
    } as NodeJS.ProcessEnv;

    const config = resolveWebRtcStreamingConfig({}, env);
    expect(config.whipEndpoint).toBe("https://coord/whip");
    expect(config.bearerToken).toBe("tok");
    expect(config.iceServers).toEqual([{ urls: "stun:s:1" }]);
    expect(config.bitrateKbps).toBe(4000);
    expect(config.size).toEqual({ width: 1280, height: 720 });
    expect(config.trickleIce).toBe(false);
    expect(config.audioEnabled).toBe(false);
  });

  test("enables trickle ICE from the environment flag", () => {
    const env = {
      [WEBRTC_ENV.WHIP_ENDPOINT]: "https://coord/whip",
      [WEBRTC_ENV.TRICKLE_ICE]: "true",
    } as NodeJS.ProcessEnv;
    expect(resolveWebRtcStreamingConfig({}, env).trickleIce).toBe(true);
  });

  test("trickle ICE override takes precedence over the environment", () => {
    const env = {
      [WEBRTC_ENV.WHIP_ENDPOINT]: "https://coord/whip",
      [WEBRTC_ENV.TRICKLE_ICE]: "1",
    } as NodeJS.ProcessEnv;
    expect(resolveWebRtcStreamingConfig({ trickleIce: false }, env).trickleIce).toBe(false);
  });

  test("enables audio from the environment flag", () => {
    const env = {
      [WEBRTC_ENV.WHIP_ENDPOINT]: "https://coord/whip",
      [WEBRTC_ENV.AUDIO]: "on",
    } as NodeJS.ProcessEnv;
    expect(resolveWebRtcStreamingConfig({}, env).audioEnabled).toBe(true);
  });

  test("audio override takes precedence over the environment", () => {
    const env = {
      [WEBRTC_ENV.WHIP_ENDPOINT]: "https://coord/whip",
      [WEBRTC_ENV.AUDIO]: "1",
    } as NodeJS.ProcessEnv;
    expect(resolveWebRtcStreamingConfig({ audioEnabled: false }, env).audioEnabled).toBe(false);
  });

  test("overrides take precedence over environment", () => {
    const env = { [WEBRTC_ENV.WHIP_ENDPOINT]: "https://env/whip" } as NodeJS.ProcessEnv;
    const config = resolveWebRtcStreamingConfig(
      { whipEndpoint: "https://override/whip", bitrateKbps: 8000 },
      env
    );
    expect(config.whipEndpoint).toBe("https://override/whip");
    expect(config.bitrateKbps).toBe(8000);
  });

  test("rejects invalid per-request size, bitrate, and WHIP endpoint", () => {
    expect(() =>
      resolveWebRtcStreamingConfig({ whipEndpoint: "https://coord/whip", size: { width: 1, height: 2 } })
    ).toThrow(/positive even integers/);
    expect(() =>
      resolveWebRtcStreamingConfig({ whipEndpoint: "https://coord/whip", bitrateKbps: 0 })
    ).toThrow(/positive number/);
    expect(() => resolveWebRtcStreamingConfig({ whipEndpoint: "not a URL" })).toThrow(/absolute http/);
  });

  test("falls back to a default STUN server", () => {
    const config = resolveWebRtcStreamingConfig(
      { whipEndpoint: "https://coord/whip" },
      {} as NodeJS.ProcessEnv
    );
    expect(config.iceServers.length).toBeGreaterThan(0);
    expect(config.iceServers[0].urls).toContain("stun:");
  });

  test("throws when no WHIP endpoint is configured", () => {
    expect(() => resolveWebRtcStreamingConfig({}, {} as NodeJS.ProcessEnv)).toThrow(
      /WHIP endpoint/
    );
  });
});
