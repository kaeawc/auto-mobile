import { expect, spyOn, test } from "bun:test";
import { DatabaseHealthLateness } from "../../src/daemon/databaseHealthLateness";
import { DatabaseHealthProbeInitTimeoutError } from "../../src/db/DatabaseHealthProbeInitTimeoutError";
import { DatabaseHealthProbeTimeoutError } from "../../src/db/DatabaseHealthProbeTimeoutError";
import { logger } from "../../src/utils/logger";
import { FakeTimer } from "../fakes/FakeTimer";

test.each([2000, 2001])("judges probe overrun boundary %ims", (overrunMs) => {
  const timer = new FakeTimer();
  const lateness = new DatabaseHealthLateness(timer, 30000);
  timer.setCurrentTime(30000);
  const judge = lateness.beginProbe(lateness.tick());
  timer.setCurrentTime(31000 + overrunMs);
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  try {
    expect(judge(new DatabaseHealthProbeTimeoutError(1000), 2)).toBe(overrunMs > 2000);
    expect(warn).toHaveBeenCalledTimes(overrunMs > 2000 ? 1 : 0);
  } finally {
    warn.mockRestore();
  }
});

test.each([
  { startupMs: 3000, inconclusive: false },
  { startupMs: undefined, inconclusive: true },
])("judges cold query timeout with startupMs=$startupMs", ({ startupMs, inconclusive }) => {
  const timer = new FakeTimer();
  const lateness = new DatabaseHealthLateness(timer, 30000);
  timer.setCurrentTime(30000);
  const judge = lateness.beginProbe(lateness.tick());
  timer.setCurrentTime(34000);
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  try {
    expect(judge(new DatabaseHealthProbeTimeoutError(1000, "query", startupMs), 2)).toBe(
      inconclusive,
    );
    expect(warn).toHaveBeenCalledTimes(inconclusive ? 1 : 0);
  } finally {
    warn.mockRestore();
  }
});

test("cold query timeout under a late parent tick remains inconclusive", () => {
  const timer = new FakeTimer();
  const lateness = new DatabaseHealthLateness(timer, 30000);
  timer.setCurrentTime(35000);
  const judge = lateness.beginProbe(lateness.tick());
  timer.setCurrentTime(39000);
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  try {
    expect(judge(new DatabaseHealthProbeTimeoutError(1000, "query", 3000), 2)).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
  } finally {
    warn.mockRestore();
  }
});

test("plain errors are counted despite timeout-like text and a late tick", () => {
  const timer = new FakeTimer();
  const lateness = new DatabaseHealthLateness(timer, 30000);
  timer.setCurrentTime(35000);
  const judge = lateness.beginProbe(lateness.tick());
  expect(judge(new Error("Database health probe timed out after 1000ms"), 2)).toBe(false);
});

test("init timeout under a late parent tick remains inconclusive", () => {
  const timer = new FakeTimer();
  const lateness = new DatabaseHealthLateness(timer, 30000);
  timer.setCurrentTime(35000);
  const judge = lateness.beginProbe(lateness.tick());
  timer.setCurrentTime(45000);
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  try {
    expect(judge(new DatabaseHealthProbeInitTimeoutError(10000), 2)).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
  } finally {
    warn.mockRestore();
  }
});

test("each tick measures from the previous firing, including listener-only ticks", () => {
  const timer = new FakeTimer();
  const lateness = new DatabaseHealthLateness(timer, 30000);
  timer.setCurrentTime(35000);
  expect(lateness.tick()).toEqual({ lateMs: 5000, sleptMs: 0 });
  timer.setCurrentTime(65000);
  expect(lateness.tick()).toEqual({ lateMs: 0, sleptMs: 0 });
});

test("a Timer without a monotonic clock uses its injected wall clock", () => {
  const timer = new FakeTimer();
  Object.defineProperty(timer, "monotonicNow", { value: undefined });
  const lateness = new DatabaseHealthLateness(timer, 30000);
  timer.setCurrentTime(35000);
  expect(lateness.tick()).toEqual({ lateMs: 5000, sleptMs: 0 });
});
