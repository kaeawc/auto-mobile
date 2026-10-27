import { describe, expect, test } from "bun:test";
import { ActionClockSkewCache } from "../../../src/features/action/ActionClockSkewCache";
import { FakeTimer } from "../../fakes/FakeTimer";

describe("action clock cache incarnation and freshness", () => {
  test("an incarnation change re-measures the skew while the same token keeps the sample", async () => {
    const timer = new FakeTimer();
    let token = "1";
    const cache = new ActionClockSkewCache(timer, undefined, (deviceId) => {
      expect(deviceId).toBe("device");
      return token;
    });
    let reads = 0;
    const measure = async () => timer.now() + ++reads * 100;

    expect(await cache.getSkewMs("device", measure)).toBe(100);
    expect(await cache.getSkewMs("device", measure)).toBe(100);
    expect(reads).toBe(1);
    token = "2";
    expect(await cache.getSkewMs("device", measure)).toBe(200);
    expect(await cache.getSkewMs("device", measure)).toBe(200);
    expect(reads).toBe(2);
  });

  test("undefined incarnation tokens keep the cached sample", async () => {
    const cache = new ActionClockSkewCache(new FakeTimer(), undefined, () => undefined);
    let reads = 0;
    const measure = async () => ++reads * 100;

    expect(await cache.getSkewMs("device", measure)).toBe(100);
    expect(await cache.getSkewMs("device", measure)).toBe(100);
    expect(reads).toBe(1);
  });

  test("an incarnation change retires the in-flight read without populating the new cache", async () => {
    const timer = new FakeTimer();
    let token = "1";
    const cache = new ActionClockSkewCache(timer, undefined, () => token);
    const oldRead = Promise.withResolvers<number>();
    let reads = 0;
    const stale = cache.getSkewMs("device", () => {
      reads++;
      return oldRead.promise;
    });
    token = "2";
    const fresh = cache.getSkewMs("device", async () => {
      reads++;
      return 200;
    });
    oldRead.resolve(100);

    expect(reads).toBe(2);
    expect(await stale).toBeNull();
    expect(await fresh).toBe(200);
    expect(await cache.getSkewMs("device", async () => 300)).toBe(200);
  });

  test("a backward host clock step expires the cached sample", async () => {
    const timer = new FakeTimer();
    timer.setCurrentTime(10_000);
    const cache = new ActionClockSkewCache(timer);
    let reads = 0;
    const measure = async () => timer.now() + ++reads * 100;

    expect(await cache.getSkewMs("device", measure)).toBe(100);
    timer.setCurrentTime(9_000);
    expect(await cache.getSkewMs("device", measure)).toBe(200);
    expect(reads).toBe(2);
  });
});
