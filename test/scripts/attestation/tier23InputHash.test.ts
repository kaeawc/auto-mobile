import { describe, expect, test } from "bun:test";
import {
  TIER2_CONSUMED_ENV,
  TIER2_EXCLUDED_ENV,
  TIER3_CONSUMED_ENV,
  tier2InputHash,
  tier3InputHash,
  type LaneHashInputs,
} from "../../../scripts/ci/attestation/tier23InputHash";
import { tier1InputHash } from "../../../scripts/ci/attestation/tier1InputHash";
import { describeHashBoundary } from "./hashHarness";

const base = (): LaneHashInputs => ({
  entries: [
    { path: "android/build.gradle.kts", id: "bbb", mode: "100644" },
    { path: "android/gradle/libs.versions.toml", id: "ccc", mode: "100644" },
    { path: "android/gradle/wrapper/gradle-wrapper.properties", id: "ddd", mode: "100644" },
    { path: "android/app/src/Main.kt", id: "eee", mode: "100644" },
  ],
  host: { os: "linux", arch: "x64" },
  env: { AUTOMOBILE_TARGET_SDK: "36", HOME: "/home/a", PATH: "/usr/bin" },
});

const edit =
  (path: string, id: string) =>
  (i: LaneHashInputs): LaneHashInputs => ({
    ...i,
    entries: i.entries.map((e) => (e.path === path ? { ...e, id } : e)),
  });

describeHashBoundary<LaneHashInputs>("tier 2 (Gradle)", {
  base,
  hash: tier2InputHash,
  mutations: {
    "a Kotlin source": edit("android/app/src/Main.kt", "changed"),
    "the build script": edit("android/build.gradle.kts", "changed"),
    "the version catalog": edit("android/gradle/libs.versions.toml", "bumped"),
    "the Gradle wrapper": edit("android/gradle/wrapper/gradle-wrapper.properties", "bumped"),
    "a file added": (i) => ({
      ...i,
      entries: [...i.entries, { path: "android/app/src/New.kt", id: "n", mode: "100644" }],
    }),
    "the OS": (i) => ({ ...i, host: { ...i.host, os: "darwin" } }),
    "the CPU architecture": (i) => ({ ...i, host: { ...i.host, arch: "arm64" } }),
    "a consumed variable flipped": (i) => ({
      ...i,
      env: { ...i.env, AUTOMOBILE_TARGET_SDK: "37" },
    }),
    "a consumed variable set": (i) => ({ ...i, env: { ...i.env, APP_VERSION: "1.2.3" } }),
    "a consumed variable unset": (i) => ({
      ...i,
      env: { ...i.env, AUTOMOBILE_TARGET_SDK: undefined },
    }),
  },
  perturbations: {
    "entries in another order": (i) => ({ ...i, entries: [...i.entries].reverse() }),
    "another checkout path": (i) => ({
      ...i,
      entries: i.entries.map((e) => ({ ...e, path: `./${e.path}` })),
    }),
    "host paths and CI stamps": (i) => ({
      ...i,
      env: {
        ...i.env,
        HOME: "/Users/b",
        PATH: "/opt/bin",
        ANDROID_HOME: "/sdk",
        CI: "true",
        GITHUB_SHA: "abc",
        GIT_COMMIT: "def",
      },
    }),
    "a secret in the environment": (i) => ({
      ...i,
      env: { ...i.env, RELEASE_KEYSTORE_PASSWORD: "hunter2", ANTHROPIC_API_KEY: "sk-x" },
    }),
  },
});

const iosBase = (): LaneHashInputs => ({
  entries: [
    { path: "ios/Playground/project.yml", id: "yyy", mode: "100644" },
    { path: "ios/control-proxy/project.yml", id: "zzz", mode: "100644" },
    { path: "ios/control-proxy/Sources/A.swift", id: "sss", mode: "100644" },
  ],
  host: { os: "darwin", arch: "arm64" },
  env: { DEVELOPER_DIR: "/Applications/Xcode.app", PATH: "/usr/bin" },
});

describeHashBoundary<LaneHashInputs>("tier 3 (XcodeGen)", {
  base: iosBase,
  hash: tier3InputHash,
  mutations: {
    "the XcodeGen spec": edit("ios/Playground/project.yml", "changed"),
    "the control-proxy spec": edit("ios/control-proxy/project.yml", "changed"),
    "a Swift source": edit("ios/control-proxy/Sources/A.swift", "changed"),
    "the OS": (i) => ({ ...i, host: { ...i.host, os: "linux" } }),
    "the CPU architecture": (i) => ({ ...i, host: { ...i.host, arch: "x64" } }),
    "the selected Xcode": (i) => ({
      ...i,
      env: { ...i.env, DEVELOPER_DIR: "/Applications/Xcode-27.app" },
    }),
    "a pinned XcodeGen version": (i) => ({ ...i, env: { ...i.env, XCODEGEN_VERSION: "2.45.0" } }),
  },
  perturbations: {
    "entries in another order": (i) => ({ ...i, entries: [...i.entries].reverse() }),
    "variables no task reads": (i) => ({
      ...i,
      env: { ...i.env, PATH: "/elsewhere", TERM: "dumb" },
    }),
  },
});

test("the two tiers hash the same inputs differently", () => {
  const inputs = base();
  expect(tier2InputHash(inputs)).not.toBe(tier3InputHash(inputs));
});

describe("the variable lists", () => {
  test("hashed and excluded variables do not overlap, and the lists are sorted and unique", () => {
    expect(TIER2_CONSUMED_ENV.filter((name) => TIER2_EXCLUDED_ENV.includes(name))).toEqual([]);
    for (const list of [TIER2_CONSUMED_ENV, TIER2_EXCLUDED_ENV, TIER3_CONSUMED_ENV]) {
      expect([...list]).toEqual([...new Set(list)].sort());
    }
  });

  test("no secret or signing variable is ever a hash input", () => {
    for (const name of [...TIER2_CONSUMED_ENV, ...TIER3_CONSUMED_ENV]) {
      expect(name).not.toMatch(/KEY|SECRET|PASSWORD|TOKEN|SIGN/);
    }
  });
});

describe("known answers", () => {
  // Pinned so a refactor that quietly changes what is hashed (and so what a producer's attestation
  // means to the gate) fails here, rather than only ever agreeing with itself.
  const entries = [
    { path: "b/two.txt", id: "2".repeat(40), mode: "100644" },
    { path: "a/one.txt", id: "1".repeat(40), mode: "100755" },
  ];

  test("tier 1", () => {
    expect(
      tier1InputHash({
        entries,
        host: { os: "linux", arch: "x64", bunVersion: "1.4.4" },
        env: { AUTOMOBILE_TEST_MODE: "unit" },
      }),
    ).toBe("f6939cc4d57cb08cc3e6dd59479a22e087ada68faa16c093b4b7a59a0b85b50e");
  });

  test("tier 2", () => {
    expect(
      tier2InputHash({
        entries,
        host: { os: "linux", arch: "x64" },
        env: { AUTOMOBILE_TARGET_SDK: "36" },
      }),
    ).toBe("8a63f8749892ac5123fa2ed607da2c31ffa98aac6eb7b970ed83b82d79978626");
  });

  test("tier 3", () => {
    expect(
      tier3InputHash({
        entries,
        host: { os: "darwin", arch: "arm64" },
        env: { DEVELOPER_DIR: "/Applications/Xcode.app" },
      }),
    ).toBe("cadf72b6f313a17d392fa410c71c616213d0ce9c52c5d958985aa33937253087");
  });
});
