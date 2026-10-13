import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  IosAppNetworkRuleClient,
  type IosAppNetworkRule,
} from "../../../src/features/network-filter/IosAppNetworkRuleClient";
import { logger } from "../../../src/utils/logger";
import { FakeNetworkFilterBridge } from "../../fakes/FakeNetworkFilterBridge";

const rule: IosAppNetworkRule = {
  udid: "DFBF2D27-6674-42EA-AFC4-AB702275D1D4",
  bundleId: "com.example.app",
  owner: "session-a",
  ownerGeneration: 100,
  revision: 1,
};
const shaping = { delayMs: 100, downloadKbps: 80, uploadKbps: 40, packetLossPercent: 2.5 };
const resolution = {
  profile: {
    outboundDelayMilliseconds: 50,
    inboundDelayMilliseconds: 50,
    inboundBytesPerSecond: 10000,
    outboundBytesPerSecond: 5000,
  },
  applied: ["latency", "downloadBandwidth", "uploadBandwidth"],
  unapplied: ["packetLoss"],
};

describe("shaped rule client and provider fake", () => {
  let bridge: FakeNetworkFilterBridge;
  let client: IosAppNetworkRuleClient;
  let warn: ReturnType<typeof spyOn<typeof logger, "warn">>;
  beforeEach(() => {
    bridge = new FakeNetworkFilterBridge();
    bridge.setState("ready");
    client = new IosAppNetworkRuleClient(bridge);
    warn = spyOn(logger, "warn").mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());
  const rollback = () => 2;

  for (const delivery of ["deliver", "lost"] as const) {
    test(`shaped ${delivery} apply returns provider resolution`, async () => {
      bridge.ruleScripts.push(delivery);
      expect(await client.applyShaped(rule, shaping, 15000, rollback)).toEqual({
        kind: "applied",
        installedRevision: 1,
        leaseRemainingMs: 15000,
        reconciled: delivery === "lost",
        shaping: resolution,
      });
      expect(bridge.statusCalls).toBe(delivery === "lost" ? 1 : 0);
      expect(bridge.ruleCalls).toHaveLength(1);
      expect(bridge.ruleCalls[0]?.shaping).toEqual(shaping);
      expect(bridge.activeRules()[0]).toMatchObject({ condition: "shaped", shaping: resolution });
    });
  }

  for (const rollbackAnswer of ["deliver", "dropped"] as const) {
    test(`never landed shaped apply, rollback ${rollbackAnswer}`, async () => {
      bridge.ruleScripts.push("dropped", rollbackAnswer);
      expect(await client.applyShaped(rule, shaping, 15000, rollback)).toMatchObject({
        kind: "failed",
        rolledBack: rollbackAnswer === "deliver",
      });
      expect(bridge.ruleCalls.map((call) => [call.command, call.ownership.revision])).toEqual([
        ["apply", 1],
        ["reset", 2],
      ]);
      expect(bridge.statusCalls).toBe(1);
      expect(bridge.activeRules()).toEqual([]);
    });
  }

  test("a different generation at the same revision is not ours", async () => {
    await client.applyShaped({ ...rule, ownerGeneration: 99 }, shaping, 15000, rollback);
    bridge.ruleScripts.push("dropped");
    expect(await client.applyShaped(rule, shaping, 15000, rollback)).toMatchObject({
      kind: "failed",
    });
    expect(bridge.ruleCalls.at(-1)?.command).toBe("reset");
  });

  for (const installed of ["offline", "shaped"] as const) {
    test(`${installed} cannot reconcile the other condition at the same revision`, async () => {
      if (installed === "offline") {
        await client.applyOffline(rule, 15000, rollback);
      } else {
        await client.applyShaped(rule, shaping, 15000, rollback);
      }
      bridge.ruleScripts.push("dropped");
      const result =
        installed === "offline"
          ? await client.applyShaped(rule, shaping, 15000, rollback)
          : await client.applyOffline(rule, 15000, rollback);
      expect(result).toMatchObject({ kind: "failed", rolledBack: true });
      expect(bridge.ruleCalls.at(-1)?.ownership.revision).toBe(2);
    });
  }

  test("unsupported shaping refuses definitively", async () => {
    bridge.supportsShaping = false;
    expect(await client.applyShaped(rule, shaping, 15000, rollback)).toMatchObject({
      kind: "refused",
      outcome: "unsupported_condition",
    });
    expect(bridge.statusCalls).toBe(0);
    expect(bridge.ruleCalls).toHaveLength(1);
    expect(bridge.activeRules()).toEqual([]);
  });

  for (const [request, rejection] of [
    [
      { ...shaping, delayMs: 4001 },
      { reason: "out_of_range", component: "latency" },
    ],
    [
      { ...shaping, downloadKbps: 7 },
      { reason: "out_of_range", component: "downloadBandwidth" },
    ],
    [
      { ...shaping, uploadKbps: 1000001 },
      { reason: "out_of_range", component: "uploadBandwidth" },
    ],
    [
      { ...shaping, packetLossPercent: 101 },
      { reason: "out_of_range", component: "packetLoss" },
    ],
    [
      { delayMs: 0, downloadKbps: 0, uploadKbps: 0, packetLossPercent: 2 },
      { reason: "nothing_to_apply", unapplied: ["packetLoss"] },
    ],
    [
      { delayMs: 0, downloadKbps: 0, uploadKbps: 0 },
      { reason: "nothing_to_apply", unapplied: [] },
    ],
  ] as const) {
    test(`invalid shaping ${JSON.stringify(request)} is definitive`, async () => {
      expect(await client.applyShaped(rule, request, 15000, rollback)).toMatchObject({
        kind: "refused",
        outcome: "invalid_shaping",
        rejection,
      });
      expect(bridge.statusCalls).toBe(0);
      expect(bridge.ruleCalls).toHaveLength(1);
      expect(bridge.activeRules()).toEqual([]);
    });
  }

  test("another session refuses a shaped apply", async () => {
    await client.applyShaped({ ...rule, owner: "session-b" }, shaping, 15000, rollback);
    expect(await client.applyShaped(rule, shaping, 15000, rollback)).toMatchObject({
      kind: "refused",
      outcome: "owned_by_another_session",
    });
    expect(bridge.statusCalls).toBe(0);
    expect(bridge.activeRules()[0]?.owner).toBe("session-b");
  });

  for (const state of ["not_installed", "installation_required", "approval_required"] as const) {
    test(`shaped ${state} reaches no provider`, async () => {
      bridge.setState(state);
      expect(await client.applyShaped(rule, shaping, 15000, rollback)).toMatchObject({
        kind: "not_ready",
        state,
      });
      expect(bridge.statusCalls).toBe(0);
      expect(bridge.ruleCalls).toHaveLength(1);
      expect(bridge.activeRules()).toEqual([]);
    });
  }

  test("legacy shaped apply is upgrade_required without reconcile or reset", async () => {
    bridge.controllerVersion = 3;
    const result = await client.applyShaped(rule, shaping, 15000, rollback);
    expect(result).toMatchObject({
      kind: "upgrade_required",
      installedVersion: 3,
      requiredVersion: 4,
      command: "auto-mobile --ios-network-filter install --upgrade",
    });
    expect(bridge.statusCalls).toBe(0);
    expect(bridge.ruleCalls).toHaveLength(1);
    expect(bridge.activeRules()).toEqual([]);
    expect(await client.applyOffline(rule, 15000, rollback)).toMatchObject({ kind: "applied" });
    expect((await bridge.status()).contractVersion).toBe(3);
    expect((await bridge.snapshot()).contractVersion).toBe(3);
    expect(await client.renew(rule, 15000)).toBe("renewed");
    expect(await client.reset({ ...rule, revision: 2 })).toEqual({
      kind: "reset",
      reconciled: false,
    });
    expect(bridge.activeRules()).toEqual([]);
  });

  test("same revision only accepts identical configuration redelivery", async () => {
    expect((await client.applyShaped(rule, shaping, 15000, rollback)).kind).toBe("applied");
    expect((await client.applyShaped(rule, shaping, 15000, rollback)).kind).toBe("applied");
    expect(
      await client.applyShaped(rule, { ...shaping, delayMs: 200 }, 15000, rollback),
    ).toMatchObject({ kind: "refused", outcome: "invalid_command" });
    expect(await client.applyOffline(rule, 15000, rollback)).toMatchObject({
      kind: "refused",
      outcome: "invalid_command",
    });
    expect(bridge.activeRules()[0]).toMatchObject({ condition: "shaped", shaping: resolution });
    expect(await client.applyOffline({ ...rule, revision: 2 }, 15000, () => 3)).toMatchObject({
      kind: "applied",
    });
    expect(bridge.activeRules()[0]?.condition).toBe("offline");
  });

  test("shaped reset only removes our rule", async () => {
    await client.applyShaped({ ...rule, owner: "session-b" }, shaping, 15000, rollback);
    expect(await client.reset({ ...rule, revision: 2 })).toMatchObject({
      kind: "refused",
      outcome: "owned_by_another_session",
    });
    expect(bridge.activeRules()).toHaveLength(1);
    expect(await client.reset({ ...rule, owner: "session-b", revision: 2 })).toEqual({
      kind: "reset",
      reconciled: false,
    });
    expect(bridge.activeRules()).toEqual([]);
  });

  for (const delivery of ["lost", "dropped"] as const) {
    test(`shaped reset ${delivery} reconciles condition-agnostically`, async () => {
      await client.applyShaped(rule, shaping, 15000, rollback);
      bridge.ruleScripts.push(delivery);
      const result = await client.reset({ ...rule, revision: 2 });
      expect(result).toMatchObject(
        delivery === "lost"
          ? { kind: "reset", reconciled: true }
          : { kind: "failed", state: "unavailable" },
      );
      expect(bridge.statusCalls).toBe(1);
    });
  }

  test("shaped renew maps provider answers", async () => {
    await client.applyShaped(rule, shaping, 15000, rollback);
    expect(await client.renew(rule, 15000)).toBe("renewed");
    bridge.ruleScripts.push("dropped");
    expect(await client.renew(rule, 15000)).toBe("retry");
    expect(await client.renew({ ...rule, revision: 7 }, 15000)).toBe("lost");
    bridge.expireAll();
    expect(await client.renew(rule, 15000)).toBe("lost");
  });
});
