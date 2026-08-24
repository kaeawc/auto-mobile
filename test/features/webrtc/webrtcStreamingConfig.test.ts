import { describe, expect, test } from "bun:test";
import {
  WEBRTC_ANDROID_FPS_DEFAULT,
  WEBRTC_ANDROID_FPS_MAX,
  WEBRTC_ANDROID_FPS_MIN,
  WEBRTC_ENV,
  WEBRTC_IOS_SIMULATOR_FPS_DEFAULT,
  WEBRTC_IOS_SIMULATOR_FPS_MAX,
  WEBRTC_IOS_SIMULATOR_FPS_MIN,
  parseIceServers,
  parseSize,
  resolveWebRtcStreamingConfig,
  assertWhipOverrideAllowed,
  isLoopbackWhipHost,
} from "../../../src/features/webrtc/webrtcStreamingConfig";
import { SIMULATOR_FPS_DEFAULT } from "../../../src/features/screen-stream/IOSScreenCaptureHelper";

describe("parseIceServers", () => {
  test("parses a comma-separated URL list", () => {
    expect(parseIceServers("stun:a:1, turn:b:2")).toEqual([
      { urls: "stun:a:1" },
      { urls: "turn:b:2" },
    ]);
  });

  test("parses a JSON array of servers", () => {
    expect(parseIceServers('[{"urls":"turn:b:2","username":"u","credential":"c"}]')).toEqual([
      { urls: "turn:b:2", username: "u", credential: "c" },
    ]);
  });

  test("expands an array-valued urls into one server per URL, sharing creds", () => {
    expect(
      parseIceServers('[{"urls":["turn:t:3478","turns:t:5349"],"username":"u","credential":"p"}]'),
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
      env,
    );
    expect(config.whipEndpoint).toBe("https://override/whip");
    expect(config.bitrateKbps).toBe(8000);
  });

  test("rejects invalid per-request size, bitrate, and WHIP endpoint", () => {
    expect(() =>
      resolveWebRtcStreamingConfig({
        whipEndpoint: "https://coord/whip",
        size: { width: 1, height: 2 },
      }),
    ).toThrow(/positive even integers/);
    expect(() =>
      resolveWebRtcStreamingConfig({ whipEndpoint: "https://coord/whip", bitrateKbps: 0 }),
    ).toThrow(/positive number/);
    expect(() => resolveWebRtcStreamingConfig({ whipEndpoint: "not a URL" })).toThrow(
      /absolute http/,
    );
  });

  test("defaults the iOS Simulator capture rate to the streaming default, not the observation default", () => {
    const config = resolveWebRtcStreamingConfig(
      { whipEndpoint: "https://coord/whip" },
      {} as NodeJS.ProcessEnv,
    );
    expect(config.iosSimulatorFps).toBe(WEBRTC_IOS_SIMULATOR_FPS_DEFAULT);
    // Pin the literal too: three docs files quote 15, and asserting only the
    // symbol would let the constant drift away from them silently.
    expect(WEBRTC_IOS_SIMULATOR_FPS_DEFAULT).toBe(15);
    // The generic screen-capture default is tuned for MCP observation. An
    // interactive WebRTC feed gets its own, higher, seam.
    expect(WEBRTC_IOS_SIMULATOR_FPS_DEFAULT).toBeGreaterThan(SIMULATOR_FPS_DEFAULT);
    expect(WEBRTC_IOS_SIMULATOR_FPS_DEFAULT).toBeGreaterThanOrEqual(WEBRTC_IOS_SIMULATOR_FPS_MIN);
    expect(WEBRTC_IOS_SIMULATOR_FPS_DEFAULT).toBeLessThanOrEqual(WEBRTC_IOS_SIMULATOR_FPS_MAX);
  });

  test("reads the iOS Simulator capture rate from the environment", () => {
    const env = {
      [WEBRTC_ENV.WHIP_ENDPOINT]: "https://coord/whip",
      [WEBRTC_ENV.IOS_SIMULATOR_FPS]: "30",
    } as NodeJS.ProcessEnv;
    expect(resolveWebRtcStreamingConfig({}, env).iosSimulatorFps).toBe(30);
  });

  test("iOS Simulator fps override takes precedence over the environment", () => {
    const env = {
      [WEBRTC_ENV.WHIP_ENDPOINT]: "https://coord/whip",
      [WEBRTC_ENV.IOS_SIMULATOR_FPS]: "30",
    } as NodeJS.ProcessEnv;
    expect(resolveWebRtcStreamingConfig({ iosSimulatorFps: 10 }, env).iosSimulatorFps).toBe(10);
  });

  test("rejects an iOS Simulator fps outside the documented safe range", () => {
    const endpoint = { whipEndpoint: "https://coord/whip" };
    expect(() =>
      resolveWebRtcStreamingConfig({
        ...endpoint,
        iosSimulatorFps: WEBRTC_IOS_SIMULATOR_FPS_MIN - 1,
      }),
    ).toThrow(/integer in \[5, 60\]/);
    expect(() =>
      resolveWebRtcStreamingConfig({
        ...endpoint,
        iosSimulatorFps: WEBRTC_IOS_SIMULATOR_FPS_MAX + 1,
      }),
    ).toThrow(/integer in \[5, 60\]/);
    expect(() => resolveWebRtcStreamingConfig({ ...endpoint, iosSimulatorFps: 12.5 })).toThrow(
      /integer in \[5, 60\]/,
    );
    expect(() =>
      resolveWebRtcStreamingConfig({}, {
        [WEBRTC_ENV.WHIP_ENDPOINT]: "https://coord/whip",
        [WEBRTC_ENV.IOS_SIMULATOR_FPS]: "not-a-number",
      } as NodeJS.ProcessEnv),
    ).toThrow(/integer in \[5, 60\]/);
  });

  test("defaults the Android capture rate to 30fps, not the iOS-tuned rate", () => {
    const config = resolveWebRtcStreamingConfig(
      { whipEndpoint: "https://coord/whip" },
      {} as NodeJS.ProcessEnv,
    );
    expect(config.androidFps).toBe(WEBRTC_ANDROID_FPS_DEFAULT);
    // Pin the literal: the issue calls for lowering the Android default to 30fps.
    expect(WEBRTC_ANDROID_FPS_DEFAULT).toBe(30);
    expect(WEBRTC_ANDROID_FPS_DEFAULT).toBeGreaterThanOrEqual(WEBRTC_ANDROID_FPS_MIN);
    expect(WEBRTC_ANDROID_FPS_DEFAULT).toBeLessThanOrEqual(WEBRTC_ANDROID_FPS_MAX);
  });

  test("reads the Android capture rate from the environment", () => {
    const env = {
      [WEBRTC_ENV.WHIP_ENDPOINT]: "https://coord/whip",
      [WEBRTC_ENV.ANDROID_FPS]: "24",
    } as NodeJS.ProcessEnv;
    expect(resolveWebRtcStreamingConfig({}, env).androidFps).toBe(24);
  });

  test("Android fps override takes precedence over the environment", () => {
    const env = {
      [WEBRTC_ENV.WHIP_ENDPOINT]: "https://coord/whip",
      [WEBRTC_ENV.ANDROID_FPS]: "24",
    } as NodeJS.ProcessEnv;
    expect(resolveWebRtcStreamingConfig({ androidFps: 48 }, env).androidFps).toBe(48);
  });

  test("rejects an Android fps outside the documented safe range", () => {
    const endpoint = { whipEndpoint: "https://coord/whip" };
    expect(() =>
      resolveWebRtcStreamingConfig({ ...endpoint, androidFps: WEBRTC_ANDROID_FPS_MIN - 1 }),
    ).toThrow(/integer in \[1, 60\]/);
    expect(() =>
      resolveWebRtcStreamingConfig({ ...endpoint, androidFps: WEBRTC_ANDROID_FPS_MAX + 1 }),
    ).toThrow(/integer in \[1, 60\]/);
    expect(() => resolveWebRtcStreamingConfig({ ...endpoint, androidFps: 29.5 })).toThrow(
      /integer in \[1, 60\]/,
    );
    expect(() =>
      resolveWebRtcStreamingConfig({}, {
        [WEBRTC_ENV.WHIP_ENDPOINT]: "https://coord/whip",
        [WEBRTC_ENV.ANDROID_FPS]: "not-a-number",
      } as NodeJS.ProcessEnv),
    ).toThrow(/integer in \[1, 60\]/);
  });

  test("falls back to a default STUN server", () => {
    const config = resolveWebRtcStreamingConfig(
      { whipEndpoint: "https://coord/whip" },
      {} as NodeJS.ProcessEnv,
    );
    expect(config.iceServers.length).toBeGreaterThan(0);
    expect(config.iceServers[0].urls).toContain("stun:");
  });

  test("throws when no WHIP endpoint is configured", () => {
    expect(() => resolveWebRtcStreamingConfig({}, {} as NodeJS.ProcessEnv)).toThrow(
      /WHIP endpoint/,
    );
  });
});

describe("WHIP endpoint protocol policy (issue #4751)", () => {
  const env = { [WEBRTC_ENV.WHIP_ENDPOINT]: "https://coord/whip" } as NodeJS.ProcessEnv;

  test("permits https on any host", () => {
    const config = resolveWebRtcStreamingConfig(
      { whipEndpoint: "https://remote.example/whip" },
      env,
    );
    expect(config.whipEndpoint).toBe("https://remote.example/whip");
  });

  test("permits http only on loopback hosts", () => {
    for (const endpoint of [
      "http://127.0.0.1:8000/whip",
      "http://localhost:8000/whip",
      "http://[::1]:8000/whip",
    ]) {
      expect(resolveWebRtcStreamingConfig({ whipEndpoint: endpoint }, env).whipEndpoint).toBe(
        endpoint,
      );
    }
  });

  test("rejects plaintext http on a non-loopback host", () => {
    expect(() =>
      resolveWebRtcStreamingConfig({ whipEndpoint: "http://remote.example/whip" }, env),
    ).toThrow(/only permitted for loopback/);
  });

  test("the escape hatch re-permits plaintext http anywhere", () => {
    const hatchEnv = {
      ...env,
      [WEBRTC_ENV.ALLOW_INSECURE_WHIP]: "1",
    } as NodeJS.ProcessEnv;
    expect(
      resolveWebRtcStreamingConfig({ whipEndpoint: "http://remote.example/whip" }, hatchEnv)
        .whipEndpoint,
    ).toBe("http://remote.example/whip");
  });

  test("isLoopbackWhipHost recognizes the loopback block", () => {
    expect(isLoopbackWhipHost("127.0.0.1")).toBe(true);
    expect(isLoopbackWhipHost("127.5.5.5")).toBe(true);
    expect(isLoopbackWhipHost("localhost")).toBe(true);
    expect(isLoopbackWhipHost("::1")).toBe(true);
    expect(isLoopbackWhipHost("example.com")).toBe(false);
    expect(isLoopbackWhipHost("10.0.0.1")).toBe(false);
  });
});

describe("assertWhipOverrideAllowed (issue #4751)", () => {
  test("always permits loopback overrides", () => {
    expect(() =>
      assertWhipOverrideAllowed("http://127.0.0.1:8000/whip", {} as NodeJS.ProcessEnv),
    ).not.toThrow();
  });

  test("rejects an arbitrary origin with no allow-list configured", () => {
    expect(() =>
      assertWhipOverrideAllowed("https://attacker.example/whip", {} as NodeJS.ProcessEnv),
    ).toThrow(/not allow-listed/);
  });

  test("permits an origin matching the daemon's configured endpoint", () => {
    const env = { [WEBRTC_ENV.WHIP_ENDPOINT]: "https://coord.example/whip" } as NodeJS.ProcessEnv;
    expect(() =>
      assertWhipOverrideAllowed("https://coord.example/whip?streamId=1", env),
    ).not.toThrow();
  });

  test("permits an explicitly allow-listed origin, including a bare host entry", () => {
    const env = {
      [WEBRTC_ENV.WHIP_ALLOWED_ORIGINS]: "https://a.example, b.example:9000",
    } as NodeJS.ProcessEnv;
    expect(() => assertWhipOverrideAllowed("https://a.example/whip", env)).not.toThrow();
    expect(() => assertWhipOverrideAllowed("https://b.example:9000/whip", env)).not.toThrow();
    expect(() => assertWhipOverrideAllowed("https://c.example/whip", env)).toThrow(
      /not allow-listed/,
    );
  });

  test("the escape hatch accepts any origin", () => {
    const env = { [WEBRTC_ENV.ALLOW_INSECURE_WHIP]: "1" } as NodeJS.ProcessEnv;
    expect(() => assertWhipOverrideAllowed("https://attacker.example/whip", env)).not.toThrow();
  });
});
