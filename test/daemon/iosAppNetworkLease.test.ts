import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  IosAppNetworkLeases,
  type IosAppNetworkRuleRestorer,
} from "../../src/daemon/iosAppNetworkLease";
import {
  IosAppNetworkRuleClient,
  type IosAppNetworkRenewResult,
  type IosAppNetworkRule,
} from "../../src/features/networkFilter/IosAppNetworkRuleClient";
import { logger } from "../../src/utils/logger";
import { FakeNetworkFilterBridge } from "../fakes/FakeNetworkFilterBridge";
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

describe("shaped lease lifecycle through bridge and client", () => {
  let timer: FakeTimer;
  let bridge: FakeNetworkFilterBridge;
  let client: IosAppNetworkRuleClient;
  let leases: IosAppNetworkLeases;
  let current: boolean;
  let warn: ReturnType<typeof spyOn<typeof logger, "warn">>;

  beforeEach(async () => {
    timer = new FakeTimer();
    bridge = new FakeNetworkFilterBridge();
    bridge.setState("ready");
    client = new IosAppNetworkRuleClient(bridge);
    await client.applyShaped(
      RULE,
      { delayMs: 100, downloadKbps: 80, uploadKbps: 40 },
      15000,
      () => 3,
    );
    leases = new IosAppNetworkLeases(
      timer,
      () => ({
        reset: async (rule) => {
          await client.reset(rule);
        },
        renew: (rule, leaseMs) => client.renew(rule, leaseMs),
      }),
      { leaseMs: 15000, renewIntervalMs: 5000 },
    );
    current = true;
    warn = spyOn(logger, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    leases.stopAll();
    warn.mockRestore();
  });

  test("shaped rule renews every interval without changing its resolution", async () => {
    const resolution = bridge.activeRules()[0];
    leases.start("session-a", RULE, () => current);
    await timer.advanceTimeAsync(15000, drain);
    expect(bridge.ruleCalls.map((call) => [call.command, call.leaseMs])).toEqual([
      ["apply", 15000],
      ["renew", 15000],
      ["renew", 15000],
      ["renew", 15000],
    ]);
    expect(bridge.activeRules()[0]).toEqual(resolution);
    expect(leases.active("session-a")).toEqual(RULE);
  });

  test("release stops shaped renewal and reset removes the rule", async () => {
    leases.start("session-a", RULE, () => current);
    current = false;
    expect(await client.reset({ ...RULE, revision: 3 })).toEqual({
      kind: "reset",
      reconciled: false,
    });
    await timer.advanceTimeAsync(15000, drain);
    expect(bridge.ruleCalls.map((call) => call.command)).toEqual(["apply", "reset"]);
    expect(bridge.activeRules()).toEqual([]);
    expect(leases.active("session-a")).toBeUndefined();
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("refused renew ends shaped renewal", async () => {
    leases.start("session-a", RULE, () => current);
    bridge.expireAll();
    await timer.advanceTimeAsync(10000, drain);
    expect(bridge.ruleCalls.map((call) => call.command)).toEqual(["apply", "renew"]);
    expect(leases.active("session-a")).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test("shaped renewal stops after one unconfirmed lease window", async () => {
    bridge.ruleScripts.push("dropped", "dropped", "dropped");
    leases.start("session-a", RULE, () => current);
    await timer.advanceTimeAsync(10000, drain);
    expect(leases.active("session-a")).toEqual(RULE);
    await timer.advanceTimeAsync(5000, drain);
    expect(leases.active("session-a")).toBeUndefined();
    expect(bridge.ruleCalls.filter((call) => call.command === "renew")).toHaveLength(3);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });
});
