import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  IosAppNetworkRuleClient,
  type IosAppNetworkRule,
} from "../../../src/features/network-filter/IosAppNetworkRuleClient";
import { logger } from "../../../src/utils/logger";
import { FakeNetworkFilterBridge } from "../../fakes/FakeNetworkFilterBridge";

const UDID = "12345678-1234-1234-1234-123456789ABC";

function rule(overrides: Partial<IosAppNetworkRule> = {}): IosAppNetworkRule {
  return {
    udid: UDID,
    bundleId: "com.example.app",
    owner: "session-a",
    ownerGeneration: 100,
    revision: 1,
    ...overrides,
  };
}

describe("IosAppNetworkRuleClient (#10264)", () => {
  let bridge: FakeNetworkFilterBridge;
  let client: IosAppNetworkRuleClient;
  let warn: ReturnType<typeof spyOn<typeof logger, "warn">>;
  let nextRevision: number;
  const allocate = () => ++nextRevision;

  beforeEach(() => {
    bridge = new FakeNetworkFilterBridge();
    bridge.setState("ready");
    client = new IosAppNetworkRuleClient(bridge);
    warn = spyOn(logger, "warn").mockImplementation(() => {});
    nextRevision = 1;
  });

  afterEach(() => {
    warn.mockRestore();
  });

  test("apply reports the acknowledged revision and lease", async () => {
    const result = await client.applyOffline(rule(), 15_000, allocate);

    expect(result).toEqual({
      kind: "applied",
      installedRevision: 1,
      leaseRemainingMs: 15_000,
      reconciled: false,
    });
    expect(bridge.ruleCalls.map((call) => [call.command, call.leaseMs])).toEqual([
      ["apply", 15_000],
    ]);
  });

  test("an apply whose answer was lost but which landed is reconciled from status", async () => {
    bridge.ruleScripts.push("lost");

    const result = await client.applyOffline(rule(), 15_000, allocate);

    expect(result).toMatchObject({ kind: "applied", installedRevision: 1, reconciled: true });
    expect(bridge.statusCalls).toBe(1);
    expect(bridge.ruleCalls.map((call) => call.command)).toEqual(["apply"]);
  });

  test("an apply that never landed is rolled back with a newer revision", async () => {
    bridge.ruleScripts.push("dropped");

    const result = await client.applyOffline(rule(), 15_000, allocate);

    expect(result).toEqual({
      kind: "failed",
      state: "unavailable",
      detail: "fake: the controller's answer was lost",
      rolledBack: true,
    });
    expect(bridge.ruleCalls.map((call) => [call.command, call.ownership.revision])).toEqual([
      ["apply", 1],
      ["reset", 2],
    ]);
    expect(bridge.activeRules()).toEqual([]);
  });

  test("a rollback that is also lost is reported unconfirmed", async () => {
    bridge.ruleScripts.push("dropped", "dropped");

    const result = await client.applyOffline(rule(), 15_000, allocate);

    expect(result).toMatchObject({ kind: "failed", rolledBack: false });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test("a revision installed under a different generation is not mistaken for ours", async () => {
    await client.applyOffline(rule({ ownerGeneration: 99 }), 15_000, allocate);
    bridge.ruleScripts.push("dropped");

    const result = await client.applyOffline(rule({ ownerGeneration: 100 }), 15_000, allocate);

    expect(result.kind).toBe("failed");
  });

  test("another session's rule refuses the apply", async () => {
    await client.applyOffline(rule({ owner: "session-b" }), 15_000, allocate);

    const result = await client.applyOffline(rule(), 15_000, allocate);

    expect(result).toMatchObject({ kind: "refused", outcome: "owned_by_another_session" });
  });

  for (const state of ["not_installed", "installation_required", "approval_required"] as const) {
    test(`${state} reaches no provider and is not reconciled`, async () => {
      bridge.setState(state);

      const result = await client.applyOffline(rule(), 15_000, allocate);

      expect(result).toMatchObject({ kind: "not_ready", state });
      expect(bridge.statusCalls).toBe(0);
    });
  }

  test("reset removes our rule and cannot clear another session's", async () => {
    await client.applyOffline(rule({ owner: "session-b" }), 15_000, allocate);

    const refused = await client.reset(rule({ revision: 2 }));

    expect(refused).toMatchObject({ kind: "refused", outcome: "owned_by_another_session" });
    expect(bridge.activeRules().map((active) => active.owner)).toEqual(["session-b"]);
    expect(await client.reset(rule({ owner: "session-b", revision: 3 }))).toEqual({
      kind: "reset",
      reconciled: false,
    });
  });

  test("a reset whose answer was lost is reconciled from status", async () => {
    await client.applyOffline(rule(), 15_000, allocate);
    bridge.ruleScripts.push("lost");

    expect(await client.reset(rule({ revision: 2 }))).toEqual({ kind: "reset", reconciled: true });
  });

  test("a reset that never landed while our rule is installed fails", async () => {
    await client.applyOffline(rule(), 15_000, allocate);
    bridge.ruleScripts.push("dropped");

    const result = await client.reset(rule({ revision: 2 }));

    expect(result).toMatchObject({ kind: "failed", state: "unavailable" });
    expect(bridge.activeRules()).toHaveLength(1);
  });

  test("with no controller installed there is no rule to reset", async () => {
    bridge.setState("not_installed");

    expect(await client.reset(rule())).toEqual({ kind: "reset", reconciled: true });
  });

  test("renew maps the provider's answer", async () => {
    await client.applyOffline(rule(), 15_000, allocate);

    expect(await client.renew(rule(), 15_000)).toBe("renewed");
    bridge.ruleScripts.push("dropped");
    expect(await client.renew(rule(), 15_000)).toBe("retry");
    expect(await client.renew(rule({ revision: 7 }), 15_000)).toBe("lost");
    bridge.expireAll();
    expect(await client.renew(rule(), 15_000)).toBe("lost");
  });
});
