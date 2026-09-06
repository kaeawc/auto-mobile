import { describe, expect, test } from "bun:test";
import {
  registerLiveDeadline,
  unregisterLiveDeadline,
  getLiveDeadlineMs,
} from "../../src/daemon/liveDeadlineRegistry";
import { ProgressExtendableDeadline } from "../../src/daemon/mcpRequestTimeout";

/**
 * Issue #6222 P1 reopen (fuQ88 review): the in-process side channel that lets
 * a tool handler on the OTHER side of the daemon's loopback HTTP call read
 * back the LIVE value of a `ProgressExtendableDeadline` the daemon keeps
 * extending as that SAME call emits progress -- instead of only a frozen
 * snapshot forwarded once at call start.
 */
describe("liveDeadlineRegistry", () => {
  test("returns undefined for a key that was never registered", () => {
    expect(getLiveDeadlineMs("never-registered")).toBeUndefined();
  });

  test("returns the CURRENT value of a registered deadline, reflecting a later extension", () => {
    const receivedAtMs = 1_000;
    const deadline = new ProgressExtendableDeadline(receivedAtMs, 10_000);
    const key = "req-1";
    registerLiveDeadline(key, deadline);

    expect(getLiveDeadlineMs(key)).toBe(receivedAtMs + 10_000);

    // A progress tick extends the SAME object -- the registry must reflect
    // that live, not the value captured at registration time.
    deadline.extendOnProgress(receivedAtMs + 5_000, 50_000);
    expect(getLiveDeadlineMs(key)).toBe(deadline.value);
    expect(getLiveDeadlineMs(key)).toBeGreaterThan(receivedAtMs + 10_000);

    unregisterLiveDeadline(key);
  });

  test("unregistering removes the entry so later reads see undefined again", () => {
    const key = "req-2";
    registerLiveDeadline(key, new ProgressExtendableDeadline(0, 1_000));
    expect(getLiveDeadlineMs(key)).toBeDefined();

    unregisterLiveDeadline(key);
    expect(getLiveDeadlineMs(key)).toBeUndefined();
  });

  test("unregistering an unknown key is a safe no-op", () => {
    expect(() => unregisterLiveDeadline("unknown-key")).not.toThrow();
  });

  test("registering under an existing key overwrites the previous entry", () => {
    const key = "req-3";
    const first = new ProgressExtendableDeadline(0, 1_000);
    const second = new ProgressExtendableDeadline(0, 99_000);
    registerLiveDeadline(key, first);
    registerLiveDeadline(key, second);

    expect(getLiveDeadlineMs(key)).toBe(second.value);

    unregisterLiveDeadline(key);
  });
});
