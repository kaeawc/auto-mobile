import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TmpdirRunningAvdAdvertisementReader } from "../../../src/utils/android-cmdline-tools/RunningAvdAdvertisementReader";

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
