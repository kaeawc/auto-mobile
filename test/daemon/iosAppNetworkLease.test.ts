import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  IosAppNetworkLeases,
  type IosAppNetworkRuleRestorer,
} from "../../src/daemon/iosAppNetworkLease";
import type {
  IosAppNetworkRenewResult,
  IosAppNetworkRule,
} from "../../src/features/network-filter/IosAppNetworkRuleClient";
import { logger } from "../../src/utils/logger";
import { FakeTimer } from "../fakes/FakeTimer";

const RULE: IosAppNetworkRule = {
  udid: "12345678-1234-1234-1234-123456789ABC",
  bundleId: "com.example.app",
  owner: "session-a",
  ownerGeneration: 100,
  revision: 2,
};

/** Answers each renew from a script; a pending answer holds the renew in flight. */
class ScriptedRestorer implements IosAppNetworkRuleRestorer {
  readonly renewals: Array<{ rule: IosAppNetworkRule; leaseMs: number }> = [];
  answers: Array<IosAppNetworkRenewResult | Promise<IosAppNetworkRenewResult> | Error> = [];

  async reset(): Promise<void> {}

  async renew(rule: IosAppNetworkRule, leaseMs: number): Promise<IosAppNetworkRenewResult> {
    this.renewals.push({ rule, leaseMs });
    const answer = this.answers.shift() ?? "renewed";
    if (answer instanceof Error) {
      throw answer;
    }
    return answer;
  }
}

const drain = () => new Promise<void>((resolve) => queueMicrotask(resolve));

describe("IosAppNetworkLeases (#10264)", () => {
  let timer: FakeTimer;
  let restorer: ScriptedRestorer;
  let leases: IosAppNetworkLeases;
  let current: boolean;
  let warn: ReturnType<typeof spyOn<typeof logger, "warn">>;

  const advance = (ms: number) => timer.advanceTimeAsync(ms, drain);

  beforeEach(() => {
    timer = new FakeTimer();
    restorer = new ScriptedRestorer();
    leases = new IosAppNetworkLeases(timer, () => restorer, {
      leaseMs: 15_000,
      renewIntervalMs: 5_000,
    });
    current = true;
    warn = spyOn(logger, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    leases.stopAll();
    warn.mockRestore();
  });

  test("renews the installed revision every interval while the owner is current", async () => {
    leases.start("session-a", RULE, () => current);

    await advance(15_000);

    expect(restorer.renewals).toEqual([
      { rule: RULE, leaseMs: 15_000 },
      { rule: RULE, leaseMs: 15_000 },
      { rule: RULE, leaseMs: 15_000 },
    ]);
    expect(leases.active("session-a")).toEqual(RULE);
    expect(timer.getSleepCallCount()).toBe(0);
  });

  test("stops when the owner is no longer current, without renewing", async () => {
    leases.start("session-a", RULE, () => current);
    current = false;

    await advance(5_000);

    expect(restorer.renewals).toEqual([]);
    expect(leases.active("session-a")).toBeUndefined();
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("a renew answer that arrives after release does not reschedule", async () => {
    const pending = Promise.withResolvers<IosAppNetworkRenewResult>();
    restorer.answers.push(pending.promise);
    leases.start("session-a", RULE, () => current);

    await advance(5_000);
    expect(restorer.renewals).toHaveLength(1);
    current = false;
    pending.resolve("renewed");
    await drain();
    await drain();

    expect(leases.active("session-a")).toBeUndefined();
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("a stale answer cannot stop or reschedule a restarted lease", async () => {
    const pending = Promise.withResolvers<IosAppNetworkRenewResult>();
    restorer.answers.push(pending.promise);
    leases.start("session-a", RULE, () => current);
    await advance(5_000);

    const next = { ...RULE, revision: 3 };
    leases.start("session-a", next, () => current);
    pending.resolve("lost");
    await drain();
    await drain();

    expect(leases.active("session-a")).toEqual(next);
    expect(timer.getPendingTimeoutCount()).toBe(1);
  });

  test("a renew the provider refuses ends renewal", async () => {
    restorer.answers.push("lost");
    leases.start("session-a", RULE, () => current);

    await advance(10_000);

    expect(restorer.renewals).toHaveLength(1);
    expect(leases.active("session-a")).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test("transient failures retry until a whole lease passes unconfirmed", async () => {
    restorer.answers.push("retry", new Error("exec failed"), "retry", "retry");
    leases.start("session-a", RULE, () => current);

    await advance(10_000);
    expect(leases.active("session-a")).toEqual(RULE);

    await advance(5_000);

    expect(restorer.renewals).toHaveLength(3);
    expect(leases.active("session-a")).toBeUndefined();
  });

  test("a confirmed renew restarts the unconfirmed-lease window", async () => {
    restorer.answers.push("retry", "renewed", "retry", "retry");
    leases.start("session-a", RULE, () => current);

    await advance(20_000);

    expect(restorer.renewals).toHaveLength(4);
    expect(leases.active("session-a")).toEqual(RULE);
  });

  test("stop cancels the pending renewal", async () => {
    leases.start("session-a", RULE, () => current);
    leases.stop("session-a");

    await advance(15_000);

    expect(restorer.renewals).toEqual([]);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });
});
