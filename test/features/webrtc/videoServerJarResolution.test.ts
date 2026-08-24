import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ActionableError } from "../../../src/models/ActionableError";
import {
  REQUIRE_VIDEO_SERVER_ENV,
  SKIP_VIDEO_SERVER_DOWNLOAD_ENV,
  VIDEO_SERVER_JAR_ENV,
  prefetchVideoServerJar,
  resolveVideoServerJar,
  type VideoJarEnsurer,
} from "../../../src/features/webrtc/videoServerJar";
import { WEBRTC_ENV } from "../../../src/features/webrtc/webrtcStreamingConfig";

/** Fake provider recording whether ensure() was consulted. */
class FakeEnsurer implements VideoJarEnsurer {
  public calls = 0;
  constructor(
    private readonly result: string | null,
    private readonly error?: Error,
  ) {}
  async ensure(): Promise<string | null> {
    this.calls++;
    if (this.error) {
      throw this.error;
    }
    return this.result;
  }
}

describe("resolveVideoServerJar precedence + fail-modes (#3834)", function () {
  let root: string;
  let overridePath: string;
  let buildCwd: string;
  let buildPath: string;

  beforeEach(async function () {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "video-jar-resolve-"));
    overridePath = path.join(root, "override.jar");
    await fs.writeFile(overridePath, "override");
    buildCwd = path.join(root, "repo");
    buildPath = path.join(
      buildCwd,
      "android",
      "video-server",
      "build",
      "libs",
      "automobile-video.jar",
    );
  });

  afterEach(async function () {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function makeBuild(): Promise<void> {
    await fs.mkdir(path.dirname(buildPath), { recursive: true });
    await fs.writeFile(buildPath, "built");
  }

  test("1. env override wins and the provider is never consulted", async function () {
    const provider = new FakeEnsurer("/downloaded.jar");
    const result = await resolveVideoServerJar({
      env: { [VIDEO_SERVER_JAR_ENV]: overridePath },
      cwd: buildCwd,
      provider,
    });
    expect(result).toBe(overridePath);
    expect(provider.calls).toBe(0);
  });

  test("2/3. no override → provider's cached/downloaded jar is used", async function () {
    const provider = new FakeEnsurer("/cache/automobile-video.jar");
    const result = await resolveVideoServerJar({ env: {}, cwd: buildCwd, provider });
    expect(result).toBe("/cache/automobile-video.jar");
    expect(provider.calls).toBe(1);
  });

  test("4. provider returns null (unknown checksum) → falls back to local build", async function () {
    await makeBuild();
    const provider = new FakeEnsurer(null);
    const result = await resolveVideoServerJar({ env: {}, cwd: buildCwd, provider });
    expect(result).toBe(buildPath);
  });

  test("5. provider returns null and no local build → degrade to null", async function () {
    const provider = new FakeEnsurer(null);
    const result = await resolveVideoServerJar({ env: {}, cwd: buildCwd, provider });
    expect(result).toBeNull();
  });

  test("checksum mismatch is fatal (propagates) even with REQUIRE off", async function () {
    const provider = new FakeEnsurer(null, new ActionableError("checksum verification failed"));
    await expect(resolveVideoServerJar({ env: {}, cwd: buildCwd, provider })).rejects.toThrow(
      /checksum verification failed/,
    );
  });

  test("REQUIRE flips a degrade (null, no build) into a fatal ActionableError", async function () {
    const provider = new FakeEnsurer(null);
    const promise = resolveVideoServerJar({
      env: { [REQUIRE_VIDEO_SERVER_ENV]: "1" },
      cwd: buildCwd,
      provider,
    });
    await expect(promise).rejects.toThrow(ActionableError);
    await expect(promise).rejects.toThrow(new RegExp(REQUIRE_VIDEO_SERVER_ENV));
  });

  test("REQUIRE is satisfied by a local build (no throw)", async function () {
    await makeBuild();
    const provider = new FakeEnsurer(null);
    const result = await resolveVideoServerJar({
      env: { [REQUIRE_VIDEO_SERVER_ENV]: "1" },
      cwd: buildCwd,
      provider,
    });
    expect(result).toBe(buildPath);
  });

  test("SKIP resolves local-only: build is used and the provider is never consulted", async function () {
    await makeBuild();
    const provider = new FakeEnsurer("/downloaded.jar");
    const result = await resolveVideoServerJar({
      env: { [SKIP_VIDEO_SERVER_DOWNLOAD_ENV]: "1" },
      cwd: buildCwd,
      provider,
    });
    expect(result).toBe(buildPath);
    expect(provider.calls).toBe(0);
  });

  test("SKIP with no local source degrades to null without touching the provider", async function () {
    const provider = new FakeEnsurer("/downloaded.jar");
    const result = await resolveVideoServerJar({
      env: { [SKIP_VIDEO_SERVER_DOWNLOAD_ENV]: "true" },
      cwd: buildCwd,
      provider,
    });
    expect(result).toBeNull();
    expect(provider.calls).toBe(0);
  });

  test("SKIP + REQUIRE with no local source is fatal (never downloads)", async function () {
    const provider = new FakeEnsurer("/downloaded.jar");
    const promise = resolveVideoServerJar({
      env: { [SKIP_VIDEO_SERVER_DOWNLOAD_ENV]: "1", [REQUIRE_VIDEO_SERVER_ENV]: "1" },
      cwd: buildCwd,
      provider,
    });
    await expect(promise).rejects.toThrow(ActionableError);
    expect(provider.calls).toBe(0);
  });

  test("override wins even under SKIP + REQUIRE", async function () {
    const provider = new FakeEnsurer(null);
    const result = await resolveVideoServerJar({
      env: {
        [VIDEO_SERVER_JAR_ENV]: overridePath,
        [SKIP_VIDEO_SERVER_DOWNLOAD_ENV]: "1",
        [REQUIRE_VIDEO_SERVER_ENV]: "1",
      },
      cwd: buildCwd,
      provider,
    });
    expect(result).toBe(overridePath);
    expect(provider.calls).toBe(0);
  });
});

describe("prefetchVideoServerJar gating (#3835)", function () {
  const WHIP = { [WEBRTC_ENV.WHIP_ENDPOINT]: "https://whip.example/publish" };

  test("with a WHIP endpoint configured, the jar is fetched in the background", async function () {
    const provider = new FakeEnsurer("/cache/automobile-video.jar");
    await prefetchVideoServerJar({ env: { ...WHIP }, provider });
    expect(provider.calls).toBe(1);
  });

  test("without a WHIP endpoint, no prefetch occurs", async function () {
    const provider = new FakeEnsurer("/cache/automobile-video.jar");
    await prefetchVideoServerJar({ env: {}, provider });
    expect(provider.calls).toBe(0);
  });

  test("SKIP disables the prefetch even with a WHIP endpoint", async function () {
    const provider = new FakeEnsurer("/cache/automobile-video.jar");
    await prefetchVideoServerJar({
      env: { ...WHIP, [SKIP_VIDEO_SERVER_DOWNLOAD_ENV]: "1" },
      provider,
    });
    expect(provider.calls).toBe(0);
  });

  test("an explicit override skips the prefetch (download unused)", async function () {
    const provider = new FakeEnsurer("/cache/automobile-video.jar");
    const overrideEnv: NodeJS.ProcessEnv = { ...WHIP, [VIDEO_SERVER_JAR_ENV]: __filename };
    await prefetchVideoServerJar({ env: overrideEnv, provider });
    expect(provider.calls).toBe(0);
  });

  test("a prefetch failure is swallowed (best-effort, does not throw)", async function () {
    const provider = new FakeEnsurer(null, new Error("checksum verification failed"));
    // Must resolve, not reject — startup must not crash on a prefetch failure.
    await prefetchVideoServerJar({ env: { ...WHIP }, provider });
    expect(provider.calls).toBe(1);
  });
});
