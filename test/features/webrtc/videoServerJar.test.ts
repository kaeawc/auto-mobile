import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  VIDEO_SERVER_JAR_ENV,
  resolveVideoServerJarPath,
} from "../../../src/features/webrtc/videoServerJar";

const tempDirs: string[] = [];
function makeTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "video-server-jar-"));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("resolveVideoServerJarPath", () => {
  test("returns null when neither the env override nor the built jar exists", () => {
    const cwd = makeTempDir();
    expect(resolveVideoServerJarPath({}, cwd)).toBeNull();
  });

  test("prefers an existing env override", () => {
    const dir = makeTempDir();
    const jar = path.join(dir, "custom.jar");
    writeFileSync(jar, "x");
    expect(resolveVideoServerJarPath({ [VIDEO_SERVER_JAR_ENV]: jar }, dir)).toBe(jar);
  });

  test("ignores an env override that does not exist", () => {
    const cwd = makeTempDir();
    expect(
      resolveVideoServerJarPath({ [VIDEO_SERVER_JAR_ENV]: "/no/such/file.jar" }, cwd),
    ).toBeNull();
  });

  test("falls back to the Gradle build output under cwd", () => {
    const cwd = makeTempDir();
    const libs = path.join(cwd, "android", "video-server", "build", "libs");
    mkdirSync(libs, { recursive: true });
    const jar = path.join(libs, "automobile-video.jar");
    writeFileSync(jar, "x");
    expect(resolveVideoServerJarPath({}, cwd)).toBe(jar);
  });
});
