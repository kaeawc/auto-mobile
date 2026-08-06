import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  isObservePerfSnapshotEnabled,
  getObservePerfWindowMs,
  DEFAULT_PERF_WINDOW_MS,
  MIN_PERF_WINDOW_MS,
  MAX_PERF_WINDOW_MS,
} from "../../../src/features/performance/observePerfSnapshotConfig";

const ENABLE_ENV = "AUTOMOBILE_OBSERVE_PERF_SNAPSHOT";
const WINDOW_ENV = "AUTOMOBILE_OBSERVE_PERF_WINDOW_MS";

describe("observePerfSnapshotConfig", () => {
  let savedEnable: string | undefined;
  let savedWindow: string | undefined;

  beforeEach(() => {
    savedEnable = process.env[ENABLE_ENV];
    savedWindow = process.env[WINDOW_ENV];
    delete process.env[ENABLE_ENV];
    delete process.env[WINDOW_ENV];
  });

  afterEach(() => {
    restore(ENABLE_ENV, savedEnable);
    restore(WINDOW_ENV, savedWindow);
  });

  function restore(key: string, value: string | undefined): void {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  describe("isObservePerfSnapshotEnabled", () => {
    it("defaults to false when unset", () => {
      expect(isObservePerfSnapshotEnabled()).toBe(false);
    });

    it.each(["1", "true", "TRUE", "yes", " Yes "])("enables on %p", value => {
      process.env[ENABLE_ENV] = value;
      expect(isObservePerfSnapshotEnabled()).toBe(true);
    });

    it.each(["0", "false", "no", "", "off"])("stays disabled on %p", value => {
      process.env[ENABLE_ENV] = value;
      expect(isObservePerfSnapshotEnabled()).toBe(false);
    });
  });

  describe("getObservePerfWindowMs", () => {
    it("defaults when unset", () => {
      expect(getObservePerfWindowMs()).toBe(DEFAULT_PERF_WINDOW_MS);
    });

    it("defaults on a non-numeric value", () => {
      process.env[WINDOW_ENV] = "abc";
      expect(getObservePerfWindowMs()).toBe(DEFAULT_PERF_WINDOW_MS);
    });

    it("defaults on a non-positive value", () => {
      process.env[WINDOW_ENV] = "-100";
      expect(getObservePerfWindowMs()).toBe(DEFAULT_PERF_WINDOW_MS);
    });

    it("accepts a valid value in range", () => {
      process.env[WINDOW_ENV] = "2000";
      expect(getObservePerfWindowMs()).toBe(2000);
    });

    it("clamps below the minimum", () => {
      process.env[WINDOW_ENV] = "10";
      expect(getObservePerfWindowMs()).toBe(MIN_PERF_WINDOW_MS);
    });

    it("clamps above the maximum", () => {
      process.env[WINDOW_ENV] = "999999";
      expect(getObservePerfWindowMs()).toBe(MAX_PERF_WINDOW_MS);
    });

    it("rounds a fractional value", () => {
      process.env[WINDOW_ENV] = "2500.7";
      expect(getObservePerfWindowMs()).toBe(2501);
    });
  });
});
