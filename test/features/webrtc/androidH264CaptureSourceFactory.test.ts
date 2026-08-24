import { describe, expect, test } from "bun:test";
import {
  createAndroidH264CaptureSource,
  type AndroidH264CaptureSourceDeps,
} from "../../../src/features/webrtc/androidH264CaptureSourceFactory";
import type { H264CaptureSource } from "../../../src/features/webrtc/H264CaptureSource";
import type { AndroidH264SourceOptions } from "../../../src/features/webrtc/AndroidH264Source";
import type { PersistentEncoderH264SourceOptions } from "../../../src/features/webrtc/PersistentEncoderH264Source";
import type { BootedDevice } from "../../../src/models";

const DEVICE: BootedDevice = {
  deviceId: "emulator-5554",
  platform: "android",
  name: "t",
} as BootedDevice;

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

class PersistentFakeSource extends FakeSource {
  keyFrameRequests = 0;

  requestKeyFrame(): boolean {
    this.keyFrameRequests++;
    return true;
  }

  getTelemetry() {
    return {
      lastEncodedFrameTimestampUs: 123,
      lastIdrTimestampUs: 123,
      idrRequestCount: 1,
      idrCompletionCount: 1,
      encodedAccessUnitCount: 2,
    };
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

  test("forwards persistent keyframe control and telemetry through the fallback wrapper", async () => {
    const persistent = new PersistentFakeSource();
    const deps: AndroidH264CaptureSourceDeps = {
      createPersistent: () => persistent,
      createScreenrecord: () => new FakeSource(),
    };
    const source = createAndroidH264CaptureSource(baseOptions(), "/tmp/automobile-video.jar", deps);

    await source.start();
    expect(source.requestKeyFrame?.()).toBe(true);

    expect(persistent.keyFrameRequests).toBe(1);
    expect(source.getTelemetry?.()).toEqual({
      lastEncodedFrameTimestampUs: 123,
      lastIdrTimestampUs: 123,
      idrRequestCount: 1,
      idrCompletionCount: 1,
      encodedAccessUnitCount: 2,
    });
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

  test("hands off to screenrecord when the persistent source signals relaunch exhaustion", async () => {
    let onScreenrecordFallback: ((error: Error) => Promise<void>) | undefined;
    const persistent = new FakeSource();
    const screenrecord = new FakeSource();
    const deps: AndroidH264CaptureSourceDeps = {
      createPersistent: (options) => {
        onScreenrecordFallback = options.onScreenrecordFallback;
        return persistent;
      },
      createScreenrecord: () => screenrecord,
    };
    const source = createAndroidH264CaptureSource(baseOptions(), "/tmp/automobile-video.jar", deps);
    await source.start();

    expect(persistent.started).toBe(1);
    expect(screenrecord.started).toBe(0);
    expect(onScreenrecordFallback).toBeDefined();

    // Simulate the persistent source exhausting its relaunch budget mid-stream.
    await onScreenrecordFallback?.(new Error("encoder crashed; relaunch budget spent"));
    expect(screenrecord.started).toBe(1);

    // stop() now terminates the active (screenrecord) source, not the superseded one.
    await source.stop();
    expect(screenrecord.stopped).toBe(1);
    expect(persistent.stopped).toBe(0);
  });

  test("does not wire a screenrecord fallback on the audio-enabled persistent path", () => {
    let captured: PersistentEncoderH264SourceOptions | undefined;
    const deps: AndroidH264CaptureSourceDeps = {
      createPersistent: (options) => {
        captured = options;
        return new FakeSource();
      },
      createScreenrecord: () => new FakeSource(),
    };
    createAndroidH264CaptureSource(
      { ...baseOptions(), audioEnabled: true },
      "/tmp/automobile-video.jar",
      deps,
    );
    expect(captured?.onScreenrecordFallback).toBeUndefined();
  });

  test("stops the selected source when stop races its startup", async () => {
    let releaseStart: (() => void) | undefined;
    const persistent = new FakeSource(
      () =>
        new Promise<void>((resolve) => {
          releaseStart = resolve;
        }),
    );
    const deps: AndroidH264CaptureSourceDeps = {
      createPersistent: () => persistent,
      createScreenrecord: () => new FakeSource(),
    };
    const source = createAndroidH264CaptureSource(baseOptions(), "/tmp/automobile-video.jar", deps);

    const starting = source.start();
    await Promise.resolve();
    await source.stop();
    releaseStart?.();
    await starting;

    expect(persistent.stopped).toBe(1);
  });

  test("forwards the caller's quality and fps to the persistent source", () => {
    let captured: PersistentEncoderH264SourceOptions | undefined;
    const deps: AndroidH264CaptureSourceDeps = {
      createPersistent: (options) => {
        captured = options;
        return new FakeSource();
      },
      createScreenrecord: () => new FakeSource(),
    };
    createAndroidH264CaptureSource(
      { ...baseOptions(), quality: "high", fps: 24 },
      "/tmp/automobile-video.jar",
      deps,
    );
    expect(captured?.quality).toBe("high");
    expect(captured?.fps).toBe(24);
  });

  test("forwards the caller's quality and fps on the audio-enabled persistent path", () => {
    let captured: PersistentEncoderH264SourceOptions | undefined;
    const deps: AndroidH264CaptureSourceDeps = {
      createPersistent: (options) => {
        captured = options;
        return new FakeSource();
      },
      createScreenrecord: () => new FakeSource(),
    };
    createAndroidH264CaptureSource(
      { ...baseOptions(), audioEnabled: true, quality: "low", fps: 30 },
      "/tmp/automobile-video.jar",
      deps,
    );
    expect(captured?.quality).toBe("low");
    expect(captured?.fps).toBe(30);
    expect(captured?.audioEnabled).toBe(true);
  });

  test("passes the provided jar path to the persistent source", () => {
    let capturedJar: string | undefined;
    const deps: AndroidH264CaptureSourceDeps = {
      createPersistent: (options) => {
        capturedJar = options.jarPath;
        return new FakeSource();
      },
      createScreenrecord: () => new FakeSource(),
    };
    createAndroidH264CaptureSource(baseOptions(), "/custom/video.jar", deps);
    expect(capturedJar).toBe("/custom/video.jar");
  });

  test("audio requires the persistent encoder jar", () => {
    const { deps } = makeDeps({});
    expect(() =>
      createAndroidH264CaptureSource({ ...baseOptions(), audioEnabled: true }, null, deps),
    ).toThrow(/persistent Android video-server jar/);
  });

  test("audio does not silently fall back to screenrecord when persistent startup fails", async () => {
    const persistent = new FakeSource(() => Promise.reject(new Error("remote submix unavailable")));
    const screenrecord = new FakeSource();
    const deps: AndroidH264CaptureSourceDeps = {
      createPersistent: () => persistent,
      createScreenrecord: () => screenrecord,
    };
    const source = createAndroidH264CaptureSource(
      { ...baseOptions(), audioEnabled: true },
      "/tmp/automobile-video.jar",
      deps,
    );

    await expect(source.start()).rejects.toThrow(/remote submix/);
    expect(persistent.started).toBe(1);
    expect(screenrecord.started).toBe(0);
  });
});
