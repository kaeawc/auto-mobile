import { describe, expect, test } from "bun:test";
import type { BootedDevice } from "../../src/models";
import {
  CachingContentHashProvider,
  combineApkDigests,
  type AppContentHasher,
} from "../../src/utils/ContentHashProvider";

/**
 * AC2 coverage for #4984: contentHash is derived from installed app *bytes*,
 * cached by (deviceId, packageId, versionCode), and never depends on install-time
 * signals (lastUpdateTime). A failure resolves to null so the caller falls back
 * to the default build key instead of hard-failing.
 *
 * The real Android on-device `sha256sum` / `adb pull` and iOS bundle-FS walk are
 * integration-only; here the platform hasher is a fake so the caching + fallback
 * contract is unit-tested deterministically (<100ms).
 */
function fakeDevice(deviceId: string, platform: "android" | "ios" = "android"): BootedDevice {
  return { deviceId, platform, name: deviceId } as unknown as BootedDevice;
}

class FakeHasher implements AppContentHasher {
  public calls: Array<{ deviceId: string; packageId: string; versionCode: number }> = [];
  constructor(private readonly bytesByInstall: Map<string, string>) {}
  async computeHash(device: BootedDevice, packageId: string, versionCode: number): Promise<string> {
    this.calls.push({ deviceId: device.deviceId, packageId, versionCode });
    const key = `${device.deviceId}::${packageId}::${versionCode}`;
    const bytes = this.bytesByInstall.get(key);
    if (bytes === undefined) {
      throw new Error(`no bytes for ${key}`);
    }
    // Deterministic hash of the "bytes" — depends only on content, not metadata.
    return `sha256:${bytes}`;
  }
}

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const DIGEST_Z = "f".repeat(64);

describe("combineApkDigests", () => {
  test("is order-independent and content-derived (split APKs)", () => {
    const a = combineApkDigests(`${DIGEST_A}  /data/app/base.apk\n${DIGEST_B}  /data/app/split_config.apk\n`);
    const reordered = combineApkDigests(`${DIGEST_B}  /data/app/split_config.apk\n${DIGEST_A}  /data/app/base.apk\n`);
    expect(a).toBe(reordered);
  });

  test("changes when any APK's content digest changes", () => {
    const a = combineApkDigests(`${DIGEST_A}  /data/app/base.apk\n`);
    const b = combineApkDigests(`${DIGEST_Z}  /data/app/base.apk\n`);
    expect(a).not.toBe(b);
  });

  test("returns empty string when no valid sha256 digest is present", () => {
    // A legacy adb shell can merge stderr into stdout; such lines must not be hashed.
    expect(combineApkDigests("sha256sum: not found\n")).toBe("");
    expect(combineApkDigests("")).toBe("");
    expect(combineApkDigests("/system/bin/sh: sha256sum: inaccessible or not found\n")).toBe("");
  });

  test("ignores non-digest lines mixed with a valid digest", () => {
    const mixed = combineApkDigests(`sha256sum: not found\n${DIGEST_A}  /data/app/base.apk\n`);
    const clean = combineApkDigests(`${DIGEST_A}  /data/app/base.apk\n`);
    expect(mixed).toBe(clean);
  });
});

describe("CachingContentHashProvider", () => {
  test("identical installed bytes resolve to the same hash", async () => {
    const bytes = new Map([["emu-1::com.example.app::5", "IDENTICAL"]]);
    const provider = new CachingContentHashProvider(new FakeHasher(bytes));
    const first = await provider.resolveContentHash(fakeDevice("emu-1"), "com.example.app", 5);
    // Fresh provider = fresh cache, same bytes -> same hash (models a reinstall of identical content).
    const provider2 = new CachingContentHashProvider(new FakeHasher(bytes));
    const second = await provider2.resolveContentHash(fakeDevice("emu-1"), "com.example.app", 5);
    expect(first).toBe(second);
    expect(first).toBe("sha256:IDENTICAL");
  });

  test("caches by (deviceId, packageId, versionCode): computes once", async () => {
    const hasher = new FakeHasher(new Map([["emu-1::com.example.app::5", "X"]]));
    const provider = new CachingContentHashProvider(hasher);
    await provider.resolveContentHash(fakeDevice("emu-1"), "com.example.app", 5);
    await provider.resolveContentHash(fakeDevice("emu-1"), "com.example.app", 5);
    expect(hasher.calls).toHaveLength(1);
  });

  test("a different versionCode is a distinct cache entry", async () => {
    const hasher = new FakeHasher(
      new Map([
        ["emu-1::com.example.app::5", "V5"],
        ["emu-1::com.example.app::6", "V6"],
      ])
    );
    const provider = new CachingContentHashProvider(hasher);
    const v5 = await provider.resolveContentHash(fakeDevice("emu-1"), "com.example.app", 5);
    const v6 = await provider.resolveContentHash(fakeDevice("emu-1"), "com.example.app", 6);
    expect(v5).toBe("sha256:V5");
    expect(v6).toBe("sha256:V6");
    expect(hasher.calls).toHaveLength(2);
  });

  test("returns null when the hasher fails (caller falls back to default build key)", async () => {
    const provider = new CachingContentHashProvider(new FakeHasher(new Map()));
    const result = await provider.resolveContentHash(fakeDevice("emu-1"), "com.example.app", 5);
    expect(result).toBeNull();
  });
});
