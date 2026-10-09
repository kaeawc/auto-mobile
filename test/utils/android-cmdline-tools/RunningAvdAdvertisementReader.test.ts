import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  TmpdirRunningAvdAdvertisementReader,
  runningAvdAdvertisementDirs,
} from "../../../src/utils/android-cmdline-tools/RunningAvdAdvertisementReader";

const AVD = "am-api36-ga-arm64";

const tempDirs: string[] = [];

function createRunningDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "avd-advertisements-"));
  tempDirs.push(dir);
  return dir;
}

function writeAdvertisement(dir: string, pid: number, avdName: string): void {
  writeFileSync(join(dir, `pid_${pid}.ini`), `port.serial=5554\navd.id=${avdName}\n`, "utf-8");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("TmpdirRunningAvdAdvertisementReader", () => {
  test("reports a live advertisement for the AVD", async () => {
    const dir = createRunningDir();
    writeAdvertisement(dir, 4242, AVD);
    const reader = new TmpdirRunningAvdAdvertisementReader(dir, (pid) => pid === 4242);

    expect(await reader.isAvdAdvertisedRunning(AVD)).toBe(true);
  });

  test("ignores an advertisement whose process is gone", async () => {
    const dir = createRunningDir();
    writeAdvertisement(dir, 4242, AVD);
    const reader = new TmpdirRunningAvdAdvertisementReader(dir, () => false);

    expect(await reader.isAvdAdvertisedRunning(AVD)).toBe(false);
  });

  test("keeps scanning past an unreadable entry so a later live advertisement still counts", async () => {
    const dir = createRunningDir();
    // An entry that `readdirSync` lists but `readFileSync` cannot read - the
    // same shape as a pid file deleted between the two calls.
    mkdirSync(join(dir, "pid_1.ini"));
    writeAdvertisement(dir, 4242, AVD);
    const reader = new TmpdirRunningAvdAdvertisementReader(dir, (pid) => pid === 4242);

    expect(await reader.isAvdAdvertisedRunning(AVD)).toBe(true);
  });

  test("returns false when the advertisement directory does not exist", async () => {
    const reader = new TmpdirRunningAvdAdvertisementReader(
      join(createRunningDir(), "missing"),
      () => true,
    );

    expect(await reader.isAvdAdvertisedRunning(AVD)).toBe(false);
  });
});

describe("runningAvdAdvertisementDirs (#11103)", () => {
  const host = {
    homeDir: "/Users/dev",
    tmpDir: "/var/folders/xy/T",
    env: {} as Record<string, string | undefined>,
  };

  test("probes the emulator's macOS discovery directory before tmpdir", () => {
    expect(runningAvdAdvertisementDirs({ ...host, platform: "darwin" })).toEqual([
      join("/Users/dev", "Library", "Caches", "TemporaryItems", "avd", "running"),
      join("/var/folders/xy/T", "avd", "running"),
    ]);
  });

  test("probes XDG_RUNTIME_DIR on Linux", () => {
    expect(
      runningAvdAdvertisementDirs({
        ...host,
        platform: "linux",
        tmpDir: "/tmp",
        env: { XDG_RUNTIME_DIR: "/run/user/1000", USER: "dev" },
      }),
    ).toEqual([join("/run/user/1000", "avd", "running"), join("/tmp", "avd", "running")]);
  });

  test("falls back to the emulator temp dir on Linux without XDG_RUNTIME_DIR", () => {
    expect(
      runningAvdAdvertisementDirs({
        ...host,
        platform: "linux",
        tmpDir: "/tmp",
        env: { USER: "dev" },
      }),
    ).toEqual([join("/tmp", "android-dev", "avd", "running"), join("/tmp", "avd", "running")]);
  });

  test("the reader finds an advertisement in a later candidate directory", async () => {
    const first = createRunningDir();
    const second = createRunningDir();
    writeAdvertisement(second, 4242, AVD);
    const reader = new TmpdirRunningAvdAdvertisementReader(
      [join(first, "missing"), first, second],
      (pid) => pid === 4242,
    );

    expect(await reader.isAvdAdvertisedRunning(AVD)).toBe(true);
  });
});

describe("default advertised-PID liveness (#11103)", () => {
  // PID 1 always exists; a non-root probe gets EPERM, which proves existence.
  test.skipIf(process.platform === "win32")(
    "treats a PID owned by another user (EPERM) as alive",
    async () => {
      const dir = createRunningDir();
      writeAdvertisement(dir, 1, AVD);
      const reader = new TmpdirRunningAvdAdvertisementReader(dir);

      expect(await reader.isAvdAdvertisedRunning(AVD)).toBe(true);
    },
  );
});
