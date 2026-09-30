import { describe, expect, test } from "bun:test";
import {
  PassiveWorkPolicy,
  isAppearanceSyncEnabled,
  parsePassiveWorkSettings,
} from "../../src/daemon/PassiveWorkPolicy";

const secretEnv = "AUTOMOBILE_DAEMON_LIVE_ACCEPTANCE_STARTUP_SECRET";

function policy(env: NodeJS.ProcessEnv = {}, owned: string[] = []): PassiveWorkPolicy {
  return new PassiveWorkPolicy(parsePassiveWorkSettings(env, secretEnv), (id) =>
    owned.includes(id),
  );
}

describe("PassiveWorkPolicy", () => {
  test("appearance kill switch trims and ignores case for disabled values", () => {
    for (const value of ["0", " FALSE ", "Off", " NO "]) {
      expect(isAppearanceSyncEnabled(value)).toBe(false);
      expect(
        parsePassiveWorkSettings({ AUTOMOBILE_APPEARANCE_SYNC: value }, secretEnv)
          .appearanceSyncEnabled,
      ).toBe(false);
    }
    for (const value of [undefined, "", "true", "yes", "1"]) {
      expect(isAppearanceSyncEnabled(value)).toBe(true);
    }
  });

  test("unset and empty allowlists add no unowned devices", () => {
    for (const env of [{}, { AUTOMOBILE_IOS_WARMUP_DEVICES: "" }]) {
      const scoped = policy(env);
      expect(scoped.allows("ios", "startup-warmup", "sim-a")).toBe(false);
      expect(scoped.allows("ios", "observation-stream", "sim-a")).toBe(false);
      expect(scoped.allows("android", "appearance-sync", "android-a")).toBe(false);
      expect(scoped.allows("android", "observation-stream", "android-a")).toBe(false);
    }
  });

  test("trims CSV lists and ignores empty entries", () => {
    const scoped = policy({
      AUTOMOBILE_IOS_WARMUP_DEVICES: " sim-a, ,sim-b ",
      AUTOMOBILE_ANDROID_APPEARANCE_SYNC_DEVICES: " android-a, ,android-b ",
      AUTOMOBILE_ANDROID_OBSERVATION_STREAM_DEVICES: " android-c, ",
    });
    expect(scoped.allows("ios", "startup-warmup", "sim-a")).toBe(true);
    expect(scoped.allows("ios", "observation-stream", "sim-b")).toBe(true);
    expect(scoped.allows("android", "appearance-sync", "android-b")).toBe(true);
    expect(scoped.allows("android", "observation-stream", "android-c")).toBe(true);
    expect(scoped.allows("android", "observation-stream", "android-b")).toBe(false);
    expect(scoped.allows("ios", "startup-warmup", "android-a")).toBe(false);
  });

  test("owned devices work with empty lists, except when their platform kill switch applies", () => {
    const owned = policy({ AUTOMOBILE_IOS_WARMUP_DEVICES: "" }, ["sim-a", "android-a"]);
    expect(owned.allows("ios", "startup-warmup", "sim-a")).toBe(true);
    expect(owned.allows("ios", "observation-stream", "sim-a")).toBe(true);
    expect(owned.allows("android", "appearance-sync", "android-a")).toBe(true);
    expect(owned.allows("android", "observation-stream", "android-a")).toBe(true);

    const disabled = policy(
      {
        AUTOMOBILE_APPEARANCE_SYNC: "0",
        AUTOMOBILE_IOS_WARMUP_DEVICES: "sim-b",
        [secretEnv]: "secret",
      },
      ["sim-a", "android-a"],
    );
    expect(disabled.allows("android", "appearance-sync", "android-a")).toBe(false);
    expect(disabled.allows("android", "observation-stream", "android-a")).toBe(true);
    expect(disabled.allows("ios", "startup-warmup", "sim-a")).toBe(false);
    expect(disabled.allows("ios", "observation-stream", "sim-a")).toBe(false);
    expect(disabled.allows("ios", "startup-warmup", "sim-b")).toBe(false);
    expect(disabled.allows("ios", "observation-stream", "sim-b")).toBe(false);
  });

  test("iOS settings never alter Android appearance selection", () => {
    for (const iosSettings of [
      { AUTOMOBILE_IOS_WARMUP_DEVICES: "" },
      { AUTOMOBILE_IOS_WARMUP_DEVICES: "unrelated-udid" },
      { [secretEnv]: "secret" },
    ]) {
      const scoped = policy(
        { ...iosSettings, AUTOMOBILE_ANDROID_APPEARANCE_SYNC_DEVICES: "android-b" },
        ["android-a"],
      );
      expect(scoped.allows("android", "appearance-sync", "android-a")).toBe(true);
      expect(scoped.allows("android", "appearance-sync", "android-b")).toBe(true);
      expect(scoped.allows("android", "appearance-sync", "android-c")).toBe(false);
    }
  });
});
