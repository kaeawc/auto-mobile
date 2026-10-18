import { describe, expect, test } from "bun:test";
import {
  AMBIENT_ENV,
  ENV,
  readEnvBool,
  readEnvEnum,
  readEnvList,
  readEnvRaw,
  readEnvNumber,
  type EnvVarSpec,
} from "../../src/config/env";
import { readEnvInt } from "../../src/utils/envNumbers";

const FLAG: EnvVarSpec = {
  name: "T_FLAG",
  legacyName: "OLD_FLAG",
  kind: "bool",
  default: "off",
  doc: "x",
};
const MODE: EnvVarSpec = {
  name: "T_MODE",
  kind: "enum",
  default: "a",
  doc: "x",
  values: ["a", "b"],
};
const LIST: EnvVarSpec = { name: "T_LIST", kind: "list", default: "", doc: "x" };
const silent = { warn: () => {} };

describe("typed env readers", () => {
  test.each([
    ["1", true],
    [" TRUE ", true],
    ["yes", true],
    ["0", false],
    ["", false],
    [undefined, false],
  ])("bool %p -> %p", (value, expected) => {
    expect(readEnvBool(FLAG, { T_FLAG: value })).toBe(expected);
  });

  test("bool falls back to the legacy name", () => {
    expect(readEnvBool(FLAG, { OLD_FLAG: "1" })).toBe(true);
  });

  test("number honours zero, exclusive minimums, fractions and reports invalid text", () => {
    const invalid: string[] = [];
    const record = (raw: string) => invalid.push(raw);
    const nonNegative = ENV.PRIVATE_DAEMON_ORPHAN_IDLE_MS;
    const name = nonNegative.name;
    expect(readEnvNumber(nonNegative, { [name]: "0" }, record)).toBe(0);
    expect(readEnvNumber(nonNegative, { [name]: "-1" }, record)).toBeUndefined();
    expect(readEnvNumber(nonNegative, { [name]: "abc" }, record)).toBeUndefined();
    expect(readEnvNumber(nonNegative, { [name]: "  " }, record)).toBeUndefined();
    expect(readEnvNumber(nonNegative, {}, record)).toBeUndefined();
    expect(invalid).toEqual(["-1", "abc"]);
    const positive = ENV.OBSERVE_PERF_WINDOW_MS;
    expect(readEnvNumber(positive, { [positive.name]: "0" })).toBeUndefined();
    expect(readEnvNumber(positive, { [positive.name]: "2500.5" })).toBe(2500.5);
  });

  test("int is strict, uses spec.fallback or the caller's, and warns through the injected log", () => {
    const warnings: string[] = [];
    const log = { warn: (message: string) => warnings.push(message) };
    const spec = ENV.DOCTOR_TIMEOUT_MS;
    expect(readEnvInt(spec, { [spec.name]: "2m" }, { log })).toBe(5000);
    expect(warnings).toHaveLength(1);
    expect(readEnvInt(spec, { [spec.name]: "7000" }, { log: silent })).toBe(7000);
    expect(readEnvInt(spec, {}, { fallback: 9, log: silent })).toBe(9);
    const port = ENV.PORT_RANGE_START;
    expect(
      readEnvInt(port, { AUTO_MOBILE_PORT_RANGE_START: "9000" }, { fallback: 1, log: silent }),
    ).toBe(9000);
  });

  test("enum accepts only declared values, case-insensitively", () => {
    expect(readEnvEnum(MODE, { T_MODE: " B " })).toBe("b");
    expect(readEnvEnum(MODE, { T_MODE: "c" })).toBeUndefined();
    expect(readEnvEnum(MODE, {})).toBeUndefined();
  });

  test("list trims entries and drops blanks", () => {
    expect(readEnvList(LIST, { T_LIST: " a, ,b ,," })).toEqual(["a", "b"]);
    expect(readEnvList(LIST, {})).toEqual([]);
  });
});

describe("webrtc and video-server registry names", () => {
  test("canonical and legacy spellings are pinned", () => {
    expect(
      [
        ENV.VIDEO_SERVER_JAR,
        ENV.REQUIRE_VIDEO_SERVER,
        ENV.SKIP_VIDEO_SERVER_DOWNLOAD,
        ENV.IOS_SIMULATOR_WINDOW_TIMEOUT_MS,
        ENV.WEBRTC_WHIP_ENDPOINT,
        ENV.WEBRTC_WHIP_ALLOWED_ORIGINS,
      ].map((spec) => spec.name),
    ).toEqual([
      "AUTOMOBILE_VIDEO_SERVER_JAR",
      "AUTOMOBILE_REQUIRE_VIDEO_SERVER",
      "AUTOMOBILE_SKIP_VIDEO_SERVER_DOWNLOAD",
      "AUTOMOBILE_IOS_SIMULATOR_WINDOW_TIMEOUT_MS",
      "AUTOMOBILE_WEBRTC_WHIP_ENDPOINT",
      "AUTOMOBILE_WEBRTC_WHIP_ALLOWED_ORIGINS",
    ]);
    expect(ENV.IOS_WEBRTC_FFMPEG.legacyName).toBe("AUTO_MOBILE_IOS_WEBRTC_FFMPEG");
    expect(ENV.IOS_WEBRTC_FORCE_RAW.legacyName).toBe("AUTO_MOBILE_IOS_WEBRTC_FORCE_RAW");
  });

  test("window timeout falls back to 2000 for unusable values", () => {
    expect(readEnvInt(ENV.IOS_SIMULATOR_WINDOW_TIMEOUT_MS, {}, { log: { warn: () => {} } })).toBe(
      2000,
    );
    expect(
      readEnvInt(ENV.IOS_SIMULATOR_WINDOW_TIMEOUT_MS, {
        AUTOMOBILE_IOS_SIMULATOR_WINDOW_TIMEOUT_MS: "5000",
      }),
    ).toBe(5000);
  });
});

describe("iOS CtrlProxy and Xcode signing registry names", () => {
  test("canonical and legacy spellings are pinned", () => {
    expect(
      [
        ENV.CTRL_PROXY_HEALTH_MAX_ATTEMPTS,
        ENV.CTRL_PROXY_IOS_RUNNER_SHA256,
        ENV.CTRL_PROXY_IOS_USE_LOCAL_BUILD,
        ENV.IOS_HELPER_REQUIRE_CODESIGN,
        ENV.IOS_TEAM_IDS,
        ENV.IOS_CODE_SIGN_ENTITLEMENTS_PATH,
      ].map((spec) => spec.name),
    ).toEqual([
      "AUTOMOBILE_CTRL_PROXY_HEALTH_MAX_ATTEMPTS",
      "AUTOMOBILE_CTRL_PROXY_IOS_RUNNER_SHA256",
      "AUTOMOBILE_CTRL_PROXY_IOS_USE_LOCAL_BUILD",
      "AUTOMOBILE_IOS_HELPER_REQUIRE_CODESIGN",
      "AUTOMOBILE_IOS_TEAM_IDS",
      "AUTOMOBILE_IOS_CODE_SIGN_ENTITLEMENTS_PATH",
    ]);
    expect(ENV.CTRL_PROXY_HEALTH_MAX_ATTEMPTS.legacyName).toBe(
      "AUTO_MOBILE_CTRL_PROXY_HEALTH_MAX_ATTEMPTS",
    );
    expect(AMBIENT_ENV.CTRL_PROXY_IOS_BUNDLE_ID.name).toBe("CTRL_PROXY_IOS_BUNDLE_ID");
    expect(AMBIENT_ENV.CTRL_PROXY_IOS_TIMEOUT.name).toBe("CTRL_PROXY_IOS_TIMEOUT");
  });

  test("the singular team id is only read through its own spec", () => {
    const env = { AUTOMOBILE_IOS_TEAM_ID: "ABC, DEF" };
    expect(readEnvRaw(ENV.IOS_TEAM_IDS, env)).toBeUndefined();
    expect(readEnvList(ENV.IOS_TEAM_ID, env)).toEqual(["ABC", "DEF"]);
  });
});
