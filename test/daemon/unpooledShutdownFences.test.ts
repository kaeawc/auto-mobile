import { expect, test } from "bun:test";
import {
  UnpooledShutdownFences,
  UNPOOLED_SHUTDOWN_FENCE_LIFETIME_MS,
  UNPOOLED_SHUTDOWN_FENCE_HELD_MAX_MS,
} from "../../src/daemon/unpooledShutdownFences";
import { FakeTimer } from "../fakes/FakeTimer";

function harness() {
  const timer = new FakeTimer();
  const fences = new UnpooledShutdownFences(() => timer.now());
  return { timer, fences };
}

test("record holds a fence past 31 seconds until the 600 second backstop", () => {
  const { timer, fences } = harness();
  expect(fences.isActive("device")).toBe(false);
  fences.record("device");
  expect(fences.isActive("device")).toBe(true);
  timer.advanceTime(31_000);
  expect(fences.isActive("device")).toBe(true);
  timer.advanceTime(UNPOOLED_SHUTDOWN_FENCE_HELD_MAX_MS - 31_000);
  expect(fences.isActive("device")).toBe(false);
  expect(fences.isActive("device")).toBe(false);
});

test("re-record refreshes expiry and replaces the ownership token", () => {
  const { timer, fences } = harness();
  const first = fences.record("device");
  timer.advanceTime(UNPOOLED_SHUTDOWN_FENCE_HELD_MAX_MS - 1);
  const second = fences.record("device");
  expect(second).not.toBe(first);
  timer.advanceTime(1);
  expect(fences.isActive("device")).toBe(true);
  timer.advanceTime(UNPOOLED_SHUTDOWN_FENCE_HELD_MAX_MS - 1);
  expect(fences.isActive("device")).toBe(false);
});

test("token-scoped clear preserves a newer owner and clears its own entry", () => {
  const { fences } = harness();
  const first = fences.record("device");
  const second = fences.record("device");
  fences.clear("device", first);
  expect(fences.isActive("device")).toBe(true);
  fences.clear("device", second);
  expect(fences.isActive("device")).toBe(false);
});

test("unconditional clear removes the fence for only that device", () => {
  const { fences } = harness();
  fences.record("device");
  fences.record("other");
  fences.clear("device");
  fences.clear("missing");
  expect(fences.isActive("device")).toBe(false);
  expect(fences.isActive("other")).toBe(true);
});

test("settle replaces the hold with exactly 30 seconds of discovery grace", () => {
  const { timer, fences } = harness();
  fences.record("device");
  timer.advanceTime(31_000);
  fences.settle("device");
  expect(UNPOOLED_SHUTDOWN_FENCE_LIFETIME_MS).toBe(30_000);
  timer.advanceTime(29_999);
  expect(fences.isActive("device")).toBe(true);
  timer.advanceTime(1);
  expect(fences.isActive("device")).toBe(false);
});

test("settle never revives missing cleared or expired entries", () => {
  const { timer, fences } = harness();
  fences.settle("missing");
  expect(fences.isActive("missing")).toBe(false);
  fences.record("cleared");
  fences.clear("cleared");
  fences.settle("cleared");
  expect(fences.isActive("cleared")).toBe(false);
  fences.record("expired");
  timer.advanceTime(UNPOOLED_SHUTDOWN_FENCE_HELD_MAX_MS);
  fences.settle("expired");
  expect(fences.isActive("expired")).toBe(false);
});

test("token-scoped settle preserves a newer hold and settles its own entry", () => {
  const { timer, fences } = harness();
  const first = fences.record("device");
  const second = fences.record("device");
  fences.settle("device", first);
  timer.advanceTime(UNPOOLED_SHUTDOWN_FENCE_LIFETIME_MS);
  expect(fences.isActive("device")).toBe(true);
  fences.settle("device", second);
  timer.advanceTime(UNPOOLED_SHUTDOWN_FENCE_LIFETIME_MS);
  expect(fences.isActive("device")).toBe(false);
});
