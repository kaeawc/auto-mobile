import { describe, expect, spyOn, test } from "bun:test";
import { createDeviceCaptureRegistry } from "../../../src/features/webrtc/deviceCaptureRegistry";
import type {
  H264CaptureSource,
  H264CaptureSourceOptions,
} from "../../../src/features/webrtc/H264CaptureSource";
import type { BootedDevice } from "../../../src/models";
import { logger } from "../../../src/utils/logger";

const device = { deviceId: "a", platform: "android", name: "Pixel" } as BootedDevice;
class FakeSource implements H264CaptureSource {
  starts = 0;
  stops = 0;
  staleStops: Array<boolean | undefined> = [];
  consumers: boolean[] = [];
  keyFrames: Array<"viewer" | "probe" | undefined> = [];
  startGate: Promise<void> = Promise.resolve();
  stopGate: Promise<void> = Promise.resolve();
  constructor(readonly options: H264CaptureSourceOptions) {}
  async start(): Promise<void> {
    this.starts++;
    await this.startGate;
  }
  async stop(): Promise<void> {
    this.stops++;
    await this.stopGate;
  }
  async stopStale(stale?: boolean): Promise<void> {
    this.staleStops.push(stale);
    await this.stop();
  }
  requestKeyFrame(purpose?: "viewer" | "probe"): boolean {
    this.keyFrames.push(purpose);
    return true;
  }
  setHasConsumers(value: boolean): void {
    this.consumers.push(value);
  }
}
function harness() {
  const registry = createDeviceCaptureRegistry();
  const sources: FakeSource[] = [];
  const create = (options: H264CaptureSourceOptions) => {
    const source = new FakeSource(options);
    sources.push(source);
    return source;
  };
  const acquire = (options: Partial<H264CaptureSourceOptions> = {}, hasConsumers?: boolean) =>
    registry.acquire({
      device: options.device ?? device,
      create,
      options: { device, onData: () => {}, ...options },
      hasConsumers,
    });
  return { registry, sources, create, acquire };
}
const annex = (type: number, marker: number) => Buffer.from([0, 0, 0, 1, type, marker]);
async function flush(): Promise<void> {
  for (let i = 0; i < 12; i++) {
    await Promise.resolve();
  }
}

describe("device capture registry", () => {
  for (const order of [
    [0, 1],
    [1, 0],
  ] as const) {
    test(`same-device single-flight and release permutation ${order}`, async () => {
      const h = harness();
      const handles = [h.acquire(), h.acquire()];
      expect(h.sources).toHaveLength(1);
      await Promise.all(handles.map((handle) => handle.start()));
      expect(h.sources[0].starts).toBe(1);
      await handles[order[0]].stop();
      expect(h.sources[0].stops).toBe(0);
      await Promise.all([
        handles[order[1]].stop(),
        handles[order[1]].stop(),
        handles[order[0]].stop(),
      ]);
      expect(h.sources[0].stops).toBe(1);
    });
  }
  test("different devices are independent", async () => {
    const h = harness();
    const a = h.acquire();
    const b = h.acquire({ device: { ...device, deviceId: "b" } });
    await Promise.all([a.start(), b.start()]);
    await a.stop();
    expect(h.sources.map((s) => s.stops)).toEqual([1, 0]);
    await b.stop();
  });
  test("single-consumer start/stop calls each exactly once", async () => {
    const h = harness();
    const a = h.acquire();
    await a.start();
    await a.start();
    await a.stop();
    await a.stop();
    expect([h.sources[0].starts, h.sources[0].stops]).toEqual([1, 1]);
  });
  for (const release of ["starter", "joiner", "both"] as const) {
    test(`release ${release} during pending start`, async () => {
      const h = harness();
      const gate = Promise.withResolvers<void>();
      const a = h.acquire();
      h.sources[0].startGate = gate.promise;
      const b = h.acquire();
      const starts = [a.start(), b.start()];
      await flush();
      const stops: Promise<void>[] = [];
      if (release !== "joiner") {
        stops.push(a.stop());
      }
      if (release !== "starter") {
        stops.push(b.stop());
      }
      expect(h.sources[0].stops).toBe(release === "both" ? 1 : 0);
      gate.resolve();
      await Promise.all([...starts, ...stops]);
      expect(h.sources[0].stops).toBe(release === "both" ? 1 : 0);
      await Promise.all([a.stop(), b.stop()]);
      expect(h.sources[0].stops).toBe(1);
    });
  }
  for (const mode of ["create", "start"] as const) {
    test(`${mode} rejection rejects all waiters with the original error, cleans once, and retries fresh`, async () => {
      const h = harness();
      const failure = new Error(mode);
      const gate = Promise.withResolvers<H264CaptureSource>();
      const startGate = Promise.withResolvers<void>();
      const create = (options: H264CaptureSourceOptions) => {
        const source = h.create(options);
        source.startGate = startGate.promise;
        return mode === "create" ? gate.promise : source;
      };
      const request = { device, create, options: { device, onData: () => {} } };
      const a = h.registry.acquire(request),
        b = h.registry.acquire(request);
      const results = Promise.allSettled([a.start(), b.start()]);
      if (mode === "create") {
        gate.reject(failure);
      } else {
        startGate.reject(failure);
      }
      expect(await results).toEqual([
        { status: "rejected", reason: failure },
        { status: "rejected", reason: failure },
      ]);
      await Promise.all([a.stop(), b.stop()]);
      expect(h.sources[0].stops).toBe(mode === "start" ? 1 : 0);
      const fresh = h.acquire();
      await fresh.start();
      await fresh.stop();
      expect(h.sources).toHaveLength(2);
      expect(h.sources[1].stops).toBe(1);
    });
  }
  test("synchronous factory throw escapes acquire and leaves no entry", async () => {
    const h = harness();
    const failure = new Error("audio unavailable");
    expect(() =>
      h.registry.acquire({
        device,
        options: { device, onData: () => {} },
        create: () => {
          throw failure;
        },
      }),
    ).toThrow(failure);
    const a = h.acquire();
    await a.start();
    await a.stop();
    expect(h.sources).toHaveLength(1);
  });
  test("stop then reacquire serializes source construction behind stop", async () => {
    const registry = createDeviceCaptureRegistry();
    const events: string[] = [];
    const gate = Promise.withResolvers<void>();
    let count = 0;
    const create = (options: H264CaptureSourceOptions) => {
      const id = ++count;
      events.push(`create${id}`);
      return {
        start: async () => {
          events.push(`start${id}`);
        },
        stop: async () => {
          events.push(`stop${id}`);
          if (id === 1) {
            await gate.promise;
          }
          events.push(`stopped${id}`);
        },
      };
    };
    const request = { device, create, options: { device, onData: () => {} } };
    const a = registry.acquire(request);
    await a.start();
    const stop = a.stop();
    const b = registry.acquire(request);
    const start = b.start();
    await flush();
    expect(events).toEqual(["create1", "start1", "stop1"]);
    gate.resolve();
    await Promise.all([stop, start]);
    expect(events).toEqual(["create1", "start1", "stop1", "stopped1", "create2", "start2"]);
    await b.stop();
  });
  test("never-started queued holder releases without creating a source", async () => {
    const h = harness();
    const gate = Promise.withResolvers<void>();
    const a = h.acquire();
    await a.start();
    h.sources[0].stopGate = gate.promise;
    const stop = a.stop();
    const b = h.acquire();
    const release = b.stop();
    gate.resolve();
    await Promise.all([stop, release]);
    expect(h.sources).toHaveLength(1);
  });
  test("never-started immediate holder stops its synchronously constructed source without starting", async () => {
    const h = harness();
    const a = h.acquire();
    await a.stop();
    expect([h.sources[0].starts, h.sources[0].stops]).toEqual([0, 1]);
  });
  test("stopStale only reaches the underlying source on the last holder", async () => {
    const h = harness();
    const a = h.acquire(),
      b = h.acquire();
    await Promise.all([a.start(), b.start()]);
    await a.stopStale(true);
    expect(h.sources[0].staleStops).toEqual([]);
    await b.stopStale(false);
    await b.stopStale(true);
    expect(h.sources[0].staleStops).toEqual([false]);
    expect(h.sources[0].stops).toBe(1);
  });
  test("stopStale falls back to stop when unavailable", async () => {
    const registry = createDeviceCaptureRegistry();
    let stops = 0;
    const a = registry.acquire({
      device,
      options: { device, onData: () => {} },
      create: () => ({
        start: async () => {},
        stop: async () => {
          stops++;
        },
      }),
    });
    await a.start();
    await a.stopStale(true);
    expect(stops).toBe(1);
  });
  test("fatal error fans out once, retires and serializes the next acquire", async () => {
    const h = harness();
    const errors: Error[] = [];
    const failure = new Error("fatal");
    const a = h.acquire({
      onError: (error) => {
        errors.push(error);
        void a.stop();
      },
    });
    const b = h.acquire({
      onError: (error) => {
        errors.push(error);
      },
    });
    await Promise.all([a.start(), b.start()]);
    const stopGate = Promise.withResolvers<void>();
    h.sources[0].stopGate = stopGate.promise;
    h.sources[0].options.onError?.(failure);
    h.sources[0].options.onError?.(failure);
    expect(errors).toEqual([failure, failure]);
    const c = h.acquire();
    const start = c.start();
    expect(h.sources).toHaveLength(1);
    stopGate.resolve();
    await start;
    await Promise.all([a.stop(), b.stop()]);
    expect(h.sources[0].stops).toBe(1);
    expect(h.sources).toHaveLength(2);
    await c.stop();
  });
  test("consumer flags are aggregated and applied before start, including async creation", async () => {
    const h = harness();
    const created = Promise.withResolvers<H264CaptureSource>();
    const a = h.registry.acquire({
      device,
      options: { device, onData: () => {} },
      create: (options) => {
        h.create(options);
        return created.promise;
      },
      hasConsumers: false,
    });
    a.setHasConsumers(false);
    const b = h.acquire();
    created.resolve(h.sources[0]);
    await Promise.all([a.start(), b.start()]);
    expect(h.sources[0].consumers[0]).toBe(true);
    await b.stop();
    expect(h.sources[0].consumers.at(-1)).toBe(false);
    a.setHasConsumers(true);
    expect(h.sources[0].consumers.at(-1)).toBe(true);
    await a.stop();
    a.setHasConsumers(false);
  });
  test("all callback sinks fan out without copying and released handles receive nothing", async () => {
    const h = harness();
    const seen: unknown[][] = [[], []];
    const options = (index: number): Partial<H264CaptureSourceOptions> => ({
      onData: (value) => seen[index].push(value),
      onAudioData: (value) => seen[index].push(value),
      onSourceFrame: () => seen[index].push("frame"),
      onSourceIdle: () => seen[index].push("idle"),
      onEncodedAccessUnit: () => seen[index].push("au"),
      onIdleAttestationSupport: (value) => seen[index].push(value),
      onRotation: (value) => seen[index].push(value),
      onDroppedFrames: (value) => seen[index].push(value),
      onFrameMetrics: (value) => seen[index].push(value),
    });
    const a = h.acquire(options(0)),
      b = h.acquire(options(1));
    await Promise.all([a.start(), b.start()]);
    const sinks = h.sources[0].options;
    const chunk = annex(5, 0x80);
    sinks.onData(chunk);
    sinks.onAudioData?.(chunk);
    sinks.onSourceFrame?.();
    sinks.onSourceIdle?.();
    sinks.onEncodedAccessUnit?.();
    sinks.onIdleAttestationSupport?.(true);
    sinks.onRotation?.(2);
    sinks.onDroppedFrames?.(4);
    const metrics: Parameters<NonNullable<H264CaptureSourceOptions["onFrameMetrics"]>>[0] = {
      native: null,
      helper: null,
      encoder: {
        captureTimestampMs: null,
        frameAgeMs: null,
        queueDepth: 0,
        droppedFrames: 0,
        bytesQueued: 0,
        highWaterMarkBytes: 0,
        maxFrameBytes: 100,
        outputWriteDurationMs: null,
        outputWriteHighWaterDurationMs: 0,
      },
    };
    sinks.onFrameMetrics?.(metrics);
    expect(seen[0]).toEqual(seen[1]);
    expect(seen[0][0]).toBe(chunk);
    expect(seen[0].at(-1)).toBe(metrics);
    await a.stop();
    sinks.onSourceFrame?.();
    expect(seen[0]).toHaveLength(9);
    expect(seen[1]).toHaveLength(10);
    await b.stop();
  });
  test("throwing sink logs a warning and does not starve another sink", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    const h = harness();
    const chunk = annex(1, 2);
    const received: Buffer[] = [];
    try {
      const a = h.acquire({
        onData: () => {
          throw new Error("sink");
        },
      });
      const b = h.acquire({ onData: (data) => received.push(data) });
      await a.start();
      await b.start();
      h.sources[0].options.onData(chunk);
      expect(received.at(-1)).toBe(chunk);
      expect(warn).toHaveBeenCalledTimes(1);
      await a.stop();
      await b.stop();
    } finally {
      warn.mockRestore();
    }
  });
  test("late joiner receives latest Annex-B SPS/PPS and viewer keyframe request; fresh entry has no cache", async () => {
    const h = harness();
    const a = h.acquire();
    await a.start();
    const sps = annex(7, 11),
      pps = annex(8, 12);
    h.sources[0].options.onData(Buffer.concat([annex(7, 1), sps, pps, annex(5, 0x80)]));
    const seen: Buffer[] = [];
    const b = h.acquire({ onData: (data) => seen.push(data) });
    await b.start();
    await b.start();
    expect(seen).toEqual([sps, pps]);
    expect(h.sources[0].keyFrames).toEqual(["viewer"]);
    await a.stop();
    await b.stop();
    const fresh = h.acquire();
    await fresh.start();
    const c = h.acquire({ onData: (data) => seen.push(data) });
    await c.start();
    expect(seen).toHaveLength(2);
    await fresh.stop();
    await c.stop();
  });
  test("access-unit boundary completes trailing parameter set cache", async () => {
    const h = harness();
    const a = h.acquire();
    await a.start();
    const pps = annex(8, 6);
    h.sources[0].options.onData(pps);
    h.sources[0].options.onEncodedAccessUnit?.();
    const seen: Buffer[] = [];
    const b = h.acquire({ onData: (data) => seen.push(data) });
    await b.start();
    expect(seen).toEqual([pps]);
    await a.stop();
    await b.stop();
  });
  test("audio-requiring joiner gets a private entry; no-audio joins an audio-capable entry", async () => {
    const h = harness();
    const a = h.acquire();
    await a.start();
    const audio = h.acquire({ audioEnabled: true });
    await audio.start();
    const b = h.acquire();
    await b.start();
    expect(h.sources).toHaveLength(2);
    await a.stop();
    await audio.stop();
    expect(h.sources.map((s) => s.stops)).toEqual([0, 1]);
    await b.stop();
    const audioFirst = h.acquire({ audioEnabled: true });
    await audioFirst.start();
    const silent = h.acquire();
    await silent.start();
    expect(h.sources).toHaveLength(3);
    await audioFirst.stop();
    expect(h.sources[2].stops).toBe(0);
    await silent.stop();
  });
  test("conflicting hints log once and never override first-acquirer configuration", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    const h = harness();
    try {
      const a = h.acquire({
        fps: 30,
        quality: "low",
        size: { width: 100, height: 200 },
        bitrateBps: 100,
      });
      const b = h.acquire({ fps: 5, quality: "high", bitrateBps: 200 });
      const c = h.acquire({ fps: 60 });
      await a.start();
      await b.start();
      await c.start();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain(
        "a: ignoring conflicting capture hints (bitrateBps, size, quality, fps)",
      );
      expect(h.sources[0].options.fps).toBe(30);
      expect(h.sources[0].options.quality).toBe("low");
      await a.stop();
      await b.stop();
      await c.stop();
    } finally {
      warn.mockRestore();
    }
  });
  test("stop failure logs warn and does not block fresh acquisition", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    const h = harness();
    try {
      const a = h.acquire();
      await a.start();
      h.sources[0].stopGate = Promise.reject(new Error("stop failed"));
      await expect(a.stop()).rejects.toThrow("stop failed");
      expect(warn).toHaveBeenCalledTimes(1);
      const b = h.acquire();
      await b.start();
      await b.stop();
      expect(h.sources).toHaveLength(2);
    } finally {
      warn.mockRestore();
    }
  });
  test("async construction released before start is reclaimed exactly once", async () => {
    const h = harness();
    const gate = Promise.withResolvers<H264CaptureSource>();
    const request = {
      device,
      options: { device, onData: () => {} },
      create: (options: H264CaptureSourceOptions) => {
        h.create(options);
        return gate.promise;
      },
    };
    const a = h.registry.acquire(request),
      b = h.registry.acquire(request);
    await a.stop();
    const stops = [b.stop(), b.stop()];
    expect(h.sources[0].stops).toBe(0);
    gate.resolve(h.sources[0]);
    await Promise.all(stops);
    expect([h.sources[0].starts, h.sources[0].stops]).toEqual([0, 1]);
  });
  test("failed startup cleanup preserves the original failure when stop also fails", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    const h = harness();
    const failure = new Error("start failed");
    try {
      const a = h.acquire(),
        b = h.acquire();
      h.sources[0].startGate = Promise.reject(failure);
      h.sources[0].stopGate = Promise.reject(new Error("stop failed"));
      expect(await Promise.allSettled([a.start(), b.start()])).toEqual([
        { status: "rejected", reason: failure },
        { status: "rejected", reason: failure },
      ]);
      await a.stop();
      await b.stop();
      expect(h.sources[0].stops).toBe(1);
      expect(warn).toHaveBeenCalledTimes(1);
      const c = h.acquire();
      await c.start();
      await c.stop();
    } finally {
      warn.mockRestore();
    }
  });
  test("fatal error notifies all sinks before stopping and preserves reentrant stop safety", async () => {
    const h = harness();
    const events: string[] = [];
    const a = h.acquire({
      onError: () => {
        events.push("error-a");
        void a.stop();
      },
    });
    const b = h.acquire({ onError: () => events.push("error-b") });
    await a.start();
    await b.start();
    h.sources[0].stop = async () => {
      h.sources[0].stops++;
      events.push("stop");
    };
    h.sources[0].options.onError?.(new Error("fatal"));
    await a.stop();
    await b.stop();
    expect(events).toEqual(["error-a", "error-b", "stop"]);
    expect(h.sources[0].stops).toBe(1);
  });
  test("optional parameter-cache failure does not change transport data delivery", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    const h = harness();
    const data: Buffer[] = [];
    try {
      const a = h.acquire({ onData: (chunk) => data.push(chunk) });
      await a.start();
      const oversized = Buffer.alloc(4 * 1024 * 1024 + 1);
      h.sources[0].options.onData(oversized);
      expect(data[0]).toBe(oversized);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(h.sources[0].stops).toBe(0);
      await a.stop();
    } finally {
      warn.mockRestore();
    }
  });
  test("last release ignores aborted startup even when explicit stop fails", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    const h = harness();
    const startGate = Promise.withResolvers<void>();
    const stopGate = Promise.withResolvers<void>();
    const failure = new Error("start failed during release");
    try {
      const a = h.acquire();
      h.sources[0].startGate = startGate.promise;
      h.sources[0].stopGate = stopGate.promise;
      const starts = Promise.allSettled([a.start()]);
      await flush();
      const stops = Promise.allSettled([a.stop()]);
      startGate.reject(failure);
      stopGate.reject(new Error("stop failed during release"));
      expect(await starts).toEqual([{ status: "fulfilled", value: undefined }]);
      expect((await stops)[0].status).toBe("rejected");
      expect(h.sources[0].stops).toBe(1);
    } finally {
      warn.mockRestore();
    }
  });
  for (const outcome of ["resolve", "reject"] as const) {
    test(`last release immediately aborts pending start and ignores its late ${outcome}`, async () => {
      const h = harness();
      const gate = Promise.withResolvers<void>();
      const a = h.acquire();
      h.sources[0].startGate = gate.promise;
      const starts = Promise.allSettled([a.start()]);
      try {
        const stopping = a.stop();
        expect(h.sources[0].stops).toBe(1);
        await stopping;
        // A source that ignores its abort cannot hold released callers hostage.
        expect(await starts).toEqual([{ status: "fulfilled", value: undefined }]);
        if (outcome === "resolve") {
          gate.resolve();
        } else {
          gate.reject(new Error("aborted start"));
        }
        await flush();
        await a.stop();
        expect(h.sources[0].stops).toBe(1);
        const fresh = h.acquire();
        await fresh.start();
        expect(h.sources).toHaveLength(2);
        await fresh.stop();
      } finally {
        gate.resolve();
        await a.stop();
      }
    });
  }
  test("a non-last release settles only its own pending start waiter", async () => {
    const h = harness();
    const gate = Promise.withResolvers<void>();
    const a = h.acquire(),
      b = h.acquire();
    h.sources[0].startGate = gate.promise;
    const starting = a.start();
    let bStarted = false;
    const sharedStart = b.start().then(() => {
      bStarted = true;
    });
    await a.stop();
    await starting;
    expect(bStarted).toBe(false);
    expect(h.sources[0].stops).toBe(0);
    gate.resolve();
    await sharedStart;
    await b.stop();
    expect(h.sources[0].stops).toBe(1);
  });
  test("stopStale immediately aborts a pending start on the last holder", async () => {
    const h = harness();
    const gate = Promise.withResolvers<void>();
    const a = h.acquire();
    h.sources[0].startGate = gate.promise;
    const start = a.start();
    try {
      const stop = a.stopStale(true);
      expect(h.sources[0].staleStops).toEqual([true]);
      await stop;
      await start;
    } finally {
      gate.resolve();
      await a.stop();
    }
    expect(h.sources[0].stops).toBe(1);
  });
  for (const finalFails of [false, true]) {
    test(`failed explicit stop allows one final retry (failure=${finalFails}) and later stops are no-ops`, async () => {
      const warn = spyOn(logger, "warn").mockImplementation(() => {});
      const h = harness();
      const first = new Error("first stop failed");
      const final = new Error("final stop failed");
      try {
        const a = h.acquire();
        await a.start();
        h.sources[0].stopGate = Promise.reject(first);
        await expect(a.stop()).rejects.toBe(first);
        h.sources[0].stopGate = finalFails ? Promise.reject(final) : Promise.resolve();
        if (finalFails) {
          await expect(a.stop()).rejects.toBe(final);
        } else {
          await a.stop();
        }
        await a.stop();
        await a.stop();
        expect(h.sources[0].stops).toBe(2);
        expect(warn).toHaveBeenCalledTimes(finalFails ? 2 : 1);
      } finally {
        warn.mockRestore();
      }
    });
  }
  test("new acquisition waits for an already requested final retry", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    const h = harness();
    const retryGate = Promise.withResolvers<void>();
    try {
      const a = h.acquire();
      await a.start();
      h.sources[0].stopGate = Promise.reject(new Error("first stop failed"));
      await expect(a.stop()).rejects.toThrow("first stop failed");
      h.sources[0].stopGate = retryGate.promise;
      const retry = a.stop();
      const concurrentRetry = a.stop();
      const b = h.acquire();
      const starting = b.start();
      await flush();
      expect(h.sources).toHaveLength(1);
      expect(h.sources[0].stops).toBe(2);
      retryGate.resolve();
      await Promise.all([retry, concurrentRetry, starting]);
      expect(h.sources).toHaveLength(2);
      await b.stop();
      await a.stop();
      expect(h.sources[0].stops).toBe(2);
    } finally {
      retryGate.resolve();
      warn.mockRestore();
    }
  });
  test("released start waiters settle before async creation and the late source is stopped without start", async () => {
    const h = harness();
    const created = Promise.withResolvers<H264CaptureSource>();
    const a = h.registry.acquire({
      device,
      options: { device, onData: () => {} },
      create: (options) => {
        h.create(options);
        return created.promise;
      },
    });
    const start = a.start();
    const stop = a.stop();
    await start;
    expect([h.sources[0].starts, h.sources[0].stops]).toEqual([0, 0]);
    created.resolve(h.sources[0]);
    await stop;
    await a.stop();
    expect([h.sources[0].starts, h.sources[0].stops]).toEqual([0, 1]);
  });
  test("source startup can await last-holder teardown from inside itself", async () => {
    const h = harness();
    const a = h.acquire();
    h.sources[0].start = async () => {
      h.sources[0].starts++;
      await a.stop();
    };
    await a.start();
    await a.stop();
    expect([h.sources[0].starts, h.sources[0].stops]).toEqual([1, 1]);
  });
  test("synchronous source start failure stops its partially initialized source once", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    const h = harness();
    const failure = new Error("synchronous start failure");
    try {
      const a = h.acquire();
      h.sources[0].start = () => {
        throw failure;
      };
      await expect(a.start()).rejects.toBe(failure);
      await expect(a.start()).rejects.toBe(failure);
      await a.stop();
      expect(h.sources[0].stops).toBe(1);
    } finally {
      warn.mockRestore();
    }
  });
  test("queued acquisition follows a final retry requested before its creation callback runs", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    const h = harness();
    const firstGate = Promise.withResolvers<void>();
    const retryGate = Promise.withResolvers<void>();
    try {
      const a = h.acquire();
      await a.start();
      h.sources[0].stopGate = firstGate.promise;
      const stopping = a.stop();
      // Register the owner reaction first, so retry is requested before the queued acquire resumes.
      const retried = stopping.catch(() => {
        h.sources[0].stopGate = retryGate.promise;
        return a.stop();
      });
      const b = h.acquire();
      const starting = b.start();
      firstGate.reject(new Error("first stop failed"));
      await flush();
      expect(h.sources[0].stops).toBe(2);
      expect(h.sources).toHaveLength(1);
      retryGate.resolve();
      await Promise.all([retried, starting]);
      expect(h.sources).toHaveLength(2);
      await b.stop();
      await a.stop();
      expect(h.sources[0].stops).toBe(2);
    } finally {
      firstGate.resolve();
      retryGate.resolve();
      warn.mockRestore();
    }
  });
});
