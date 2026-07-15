import { describe, expect, test } from "bun:test";
import {
  createAndroidH264CaptureSource,
  type AndroidH264CaptureSourceDeps,
} from "../../../src/features/webrtc/androidH264CaptureSourceFactory";
import type { H264CaptureSource } from "../../../src/features/webrtc/H264CaptureSource";
import type { AndroidH264SourceOptions } from "../../../src/features/webrtc/AndroidH264Source";
import type { BootedDevice } from "../../../src/models";

const DEVICE: BootedDevice = { deviceId: "emulator-5554", platform: "android", name: "t" } as BootedDevice;

class FakeSource implements H264CaptureSource {
  started = 0;
  stopped = 0;
  constructor(private readonly startImpl?: () => Promise<void>) {}
  async start(): Promise<void> {
    this.started++;
    if (this.startImpl) {
      await this.startImpl();
    }
  }
  async stop(): Promise<void> {
    this.stopped++;
  }
}

function baseOptions(): AndroidH264SourceOptions {
  return { device: DEVICE, onData: () => {} };
}

function makeDeps(overrides: Partial<AndroidH264CaptureSourceDeps>): {
  deps: AndroidH264CaptureSourceDeps;
  persistent: FakeSource;
  screenrecord: FakeSource;
} {
  const persistent = new FakeSource();
  const screenrecord = new FakeSource();
  const deps: AndroidH264CaptureSourceDeps = {
    createPersistent: () => persistent,
    createScreenrecord: () => screenrecord,
    ...overrides,
  };
  return { deps, persistent, screenrecord };
}

describe("createAndroidH264CaptureSource", () => {
  test("uses screenrecord directly when the resolved jar path is null", async () => {
    const { deps, persistent, screenrecord } = makeDeps({});
    const source = createAndroidH264CaptureSource(baseOptions(), null, deps);
    await source.start();
    expect(screenrecord.started).toBe(1);
    expect(persistent.started).toBe(0);
  });

  test("prefers the persistent encoder when a jar path is provided", async () => {
    const { deps, persistent, screenrecord } = makeDeps({});
    const source = createAndroidH264CaptureSource(baseOptions(), "/tmp/automobile-video.jar", deps);
    await source.start();
    expect(persistent.started).toBe(1);
    expect(screenrecord.started).toBe(0);

    await source.stop();
    expect(persistent.stopped).toBe(1);
    expect(screenrecord.stopped).toBe(0);
  });

  test("falls back to screenrecord when the persistent encoder fails to start", async () => {
    const persistent = new FakeSource(() => Promise.reject(new Error("app_process killed")));
    const screenrecord = new FakeSource();
    const deps: AndroidH264CaptureSourceDeps = {
      createPersistent: () => persistent,
      createScreenrecord: () => screenrecord,
    };
    const source = createAndroidH264CaptureSource(baseOptions(), "/tmp/automobile-video.jar", deps);
    await source.start();

    expect(persistent.started).toBe(1);
    expect(screenrecord.started).toBe(1);

    // stop() must terminate the active (fallback) source, not the failed one.
    await source.stop();
    expect(screenrecord.stopped).toBe(1);
    expect(persistent.stopped).toBe(0);
  });

  test("passes the provided jar path to the persistent source", () => {
    let capturedJar: string | undefined;
    const deps: AndroidH264CaptureSourceDeps = {
      createPersistent: options => {
        capturedJar = options.jarPath;
        return new FakeSource();
      },
      createScreenrecord: () => new FakeSource(),
    };
    createAndroidH264CaptureSource(baseOptions(), "/custom/video.jar", deps);
    expect(capturedJar).toBe("/custom/video.jar");
  });

  test("audio requires the persistent encoder jar", () => {
    const { deps } = makeDeps({ resolveJarPath: () => null });
    expect(() =>
      createAndroidH264CaptureSource({ ...baseOptions(), audioEnabled: true }, deps)
    ).toThrow(/persistent Android video-server jar/);
  });

  test("audio does not silently fall back to screenrecord when persistent startup fails", async () => {
    const persistent = new FakeSource(() => Promise.reject(new Error("remote submix unavailable")));
    const screenrecord = new FakeSource();
    const deps: AndroidH264CaptureSourceDeps = {
      resolveJarPath: () => "/tmp/automobile-video.jar",
      createPersistent: () => persistent,
      createScreenrecord: () => screenrecord,
    };
    const source = createAndroidH264CaptureSource({ ...baseOptions(), audioEnabled: true }, deps);

    await expect(source.start()).rejects.toThrow(/remote submix/);
    expect(persistent.started).toBe(1);
    expect(screenrecord.started).toBe(0);
  });
});
