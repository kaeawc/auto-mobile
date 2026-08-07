import { describe, it, expect } from "bun:test";
import { SdkFrameMetricsStore } from "../../../src/features/performance/SdkFrameMetricsStore";

describe("SdkFrameMetricsStore", () => {
  const sample = (fps: number, receivedAt: number) => ({
    fps,
    frameTimeMs: 1000 / fps,
    jankFrames: 0,
    receivedAt,
  });

  it("returns the latest sample within the freshness TTL", () => {
    const store = new SdkFrameMetricsStore();
    store.ingest("d1", "com.example.app", sample(60, 1000));

    expect(store.getFresh("d1", "com.example.app", 2000, 2500)?.fps).toBe(60);
  });

  it("returns null once the sample is older than the TTL", () => {
    const store = new SdkFrameMetricsStore();
    store.ingest("d1", "com.example.app", sample(60, 1000));

    // now - receivedAt = 4000 > ttl 2500
    expect(store.getFresh("d1", "com.example.app", 5000, 2500)).toBeNull();
  });

  it("keys by device AND package", () => {
    const store = new SdkFrameMetricsStore();
    store.ingest("d1", "com.a", sample(60, 1000));
    store.ingest("d1", "com.b", sample(30, 1000));

    expect(store.getFresh("d1", "com.a", 1000, 2500)?.fps).toBe(60);
    expect(store.getFresh("d1", "com.b", 1000, 2500)?.fps).toBe(30);
    expect(store.getFresh("d2", "com.a", 1000, 2500)).toBeNull();
  });

  it("overwrites with the newest sample per key", () => {
    const store = new SdkFrameMetricsStore();
    store.ingest("d1", "com.a", sample(60, 1000));
    store.ingest("d1", "com.a", sample(45, 1500));

    expect(store.getFresh("d1", "com.a", 1600, 2500)?.fps).toBe(45);
  });

  it("clear() drops all packages for a device but leaves others", () => {
    const store = new SdkFrameMetricsStore();
    store.ingest("d1", "com.a", sample(60, 1000));
    store.ingest("d1", "com.b", sample(30, 1000));
    store.ingest("d2", "com.a", sample(90, 1000));

    store.clear("d1");

    expect(store.getFresh("d1", "com.a", 1000, 2500)).toBeNull();
    expect(store.getFresh("d1", "com.b", 1000, 2500)).toBeNull();
    expect(store.getFresh("d2", "com.a", 1000, 2500)?.fps).toBe(90);
  });
});
