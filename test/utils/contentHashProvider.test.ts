import { describe, expect, test } from "bun:test";
import type { BootedDevice, ExecResult } from "../../src/models";
import type { AdbExecutor } from "../../src/utils/android-cmdline-tools/interfaces/AdbExecutor";
import {
  AndroidApkContentHasher,
  CachingContentHashProvider,
  combineApkDigests,
  parsePmPathOutput,
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

  test("invalidate drops every cached versionCode for (device, package) so it recomputes", async () => {
    const hasher = new FakeHasher(
      new Map([
        ["emu-1::com.example.app::5", "V5"],
        ["emu-1::com.example.app::6", "V6"],
        ["emu-1::com.other.app::5", "OTHER"],
      ])
    );
    const provider = new CachingContentHashProvider(hasher);
    await provider.resolveContentHash(fakeDevice("emu-1"), "com.example.app", 5);
    await provider.resolveContentHash(fakeDevice("emu-1"), "com.example.app", 6);
    await provider.resolveContentHash(fakeDevice("emu-1"), "com.other.app", 5);
    expect(hasher.calls).toHaveLength(3);

    provider.invalidate("emu-1", "com.example.app");

    // Both versionCodes of the invalidated package recompute; the other package stays cached.
    await provider.resolveContentHash(fakeDevice("emu-1"), "com.example.app", 5);
    await provider.resolveContentHash(fakeDevice("emu-1"), "com.example.app", 6);
    await provider.resolveContentHash(fakeDevice("emu-1"), "com.other.app", 5);
    expect(hasher.calls).toHaveLength(5);
  });
});

describe("parsePmPathOutput", () => {
  test("extracts base + split APK paths, stripping the package: prefix", () => {
    const out = "package:/data/app/~~x==/com.example.app-1/base.apk\npackage:/data/app/~~x==/com.example.app-1/split_config.en.apk\n";
    expect(parsePmPathOutput(out)).toEqual([
      "/data/app/~~x==/com.example.app-1/base.apk",
      "/data/app/~~x==/com.example.app-1/split_config.en.apk",
    ]);
  });

  test("returns empty for no package: lines", () => {
    expect(parsePmPathOutput("")).toEqual([]);
    expect(parsePmPathOutput("Unable to find package\n")).toEqual([]);
  });
});

/** Minimal AdbExecutor fake routing by command substring. */
function fakeAdb(routes: (command: string) => ExecResult): AdbExecutor {
  return {
    executeCommand: async (command: string) => routes(command),
  } as unknown as AdbExecutor;
}

function ok(stdout: string): ExecResult {
  return { stdout, stderr: "", exitCode: 0, success: true } as unknown as ExecResult;
}

describe("AndroidApkContentHasher (pm path resolution)", () => {
  test("resolves APK paths via pm path and returns a non-null hash (installPath-independent)", async () => {
    // This is the WS-package-info-success case: GetAppMetadata would return installPath=""
    // but pm path still yields the APKs, so hashing succeeds on the normal path.
    const adb = fakeAdb(command => {
      if (command.includes("pm path")) {
        return ok("package:/data/app/com.example.app-1/base.apk\n");
      }
      if (command.includes("sha256sum")) {
        return ok(`${DIGEST_A}  /data/app/com.example.app-1/base.apk\n`);
      }
      return ok("");
    });
    const hasher = new AndroidApkContentHasher(adb);
    const hash = await hasher.computeHash(fakeDevice("emu-1"), "com.example.app", 0);
    expect(hash).toBe(combineApkDigests(`${DIGEST_A}  x\n`));
    expect(hash).not.toBe("");
  });

  test("throws when pm path returns no APKs", async () => {
    const adb = fakeAdb(() => ok("Unable to find package\n"));
    const hasher = new AndroidApkContentHasher(adb);
    await expect(hasher.computeHash(fakeDevice("emu-1"), "com.missing.app", 0)).rejects.toThrow();
  });
});
