import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ExecNetworkFilterBridge,
  ExpiringControllerVersionMemory,
} from "../../../src/features/networkFilter/NetworkFilterBridge";
import {
  DefaultHostCommandExecutor,
  type ExecFileAsync,
} from "../../../src/utils/HostCommandExecutor";
import { IosAppNetworkRuleClient } from "../../../src/features/networkFilter/IosAppNetworkRuleClient";
import { FakeNetworkFilterBridge } from "../../fakes/FakeNetworkFilterBridge";

const target = { udid: "DFBF2D27-6674-42EA-AFC4-AB702275D1D4", bundleId: "com.example.app" };
const ownership = { owner: "session-a", ownerGeneration: 10, revision: 1 };

const fixture = (name: string) =>
  readFileSync(
    join(import.meta.dir, "../../fixtures/network-filter-controller", `${name}.json`),
    "utf8",
  );

function arrange(answers: string[]) {
  const calls: string[][] = [];
  const exec: ExecFileAsync = async (_file, args) => {
    calls.push(args);
    const answer = answers.shift();
    if (!answer) {
      throw new Error("unscripted exec");
    }
    return { stdout: answer, stderr: "" };
  };
  return {
    calls,
    bridge: new ExecNetworkFilterBridge({
      executor: new DefaultHostCommandExecutor(exec),
      exists: () => true,
      deviceSet: () => "/fixture/Devices",
      managedSimulators: async () => [],
      versionMemory: new ExpiringControllerVersionMemory(),
    }),
  };
}
describe("contract 5 launch watches and existing-flow read-back", () => {
  test("v5 ready preserves watch rules", async () => {
    const line = fixture("v5/ready");
    const { bridge } = arrange([line]);
    const answer = await bridge.snapshot();
    expect(answer.contractVersion).toBe(5);
    expect(answer.snapshot).toEqual(JSON.parse(line).snapshot);
    expect(answer.snapshot?.rules?.[0]?.condition).toBe("watch");
  });

  test("v5 unsupported negotiation is unavailable without downgrading", async () => {
    const line = fixture("v5/unsupported-contract-version");
    const { bridge, calls } = arrange([line]);
    const answer = await bridge.watch(target, ownership, 15000);
    expect(answer.contractVersion).toBe(5);
    expect(answer.state).toBe("unavailable");
    expect(answer.detail).toBe(JSON.parse(line).detail);
    expect(calls.length).toBe(1);
  });

  test("watch negotiates 5 and sends only the watch condition", async () => {
    const { bridge, calls } = arrange([fixture("v5/rule-applied-existing-flows-unaffected")]);
    expect((await bridge.watch(target, ownership, 15000)).rule?.outcome).toBe("applied");
    expect(calls[0]?.slice(0, 3)).toEqual(["apply", "--contract-version", "5"]);
    expect(calls[0]?.slice(-2)).toEqual(["--watch-only", "true"]);
    expect(calls[0]).not.toContain("--delay-ms");
  });

  for (const existingFlows of ["dropped", "unaffected"] as const) {
    test(`offline read-back preserves ${existingFlows} through the client`, async () => {
      const { bridge, calls } = arrange([
        fixture(`v5/rule-applied-existing-flows-${existingFlows}`),
      ]);
      const applied = await new IosAppNetworkRuleClient(bridge).applyOffline(
        { ...target, ...ownership },
        15000,
        () => 2,
      );
      expect(applied).toMatchObject({ kind: "applied", existingFlows });
      expect(calls[0]?.slice(0, 3)).toEqual(["apply", "--contract-version", "5"]);
      expect(calls[0]).not.toContain("--watch-only");
    });
  }

  test("invalid drop read-back is uncertain", async () => {
    const line = JSON.parse(fixture("v5/rule-applied-existing-flows-dropped"));
    line.rule.existingFlows = "planned";
    const { bridge } = arrange([JSON.stringify(line)]);
    expect((await bridge.apply(target, ownership, 15000)).rule).toBeUndefined();
  });

  test("v4 rejection retries offline in 4 without claiming existing drops", async () => {
    const { bridge, calls } = arrange([
      fixture("v4/unsupported-contract-version"),
      JSON.stringify({
        version: 4,
        state: "ready",
        detail: "ok",
        rule: { outcome: "applied", existingFlows: "dropped" },
      }),
    ]);
    const answer = await bridge.apply(target, ownership, 15000);
    expect(answer.contractVersion).toBe(4);
    expect(answer.rule).toEqual({ outcome: "applied" });
    expect(calls.map((call) => call.slice(0, 3))).toEqual([
      ["apply", "--contract-version", "5"],
      ["apply", "--contract-version", "4"],
    ]);
  });

  test("a watch cannot downgrade to a v4 offline apply", async () => {
    const { bridge, calls } = arrange([fixture("v4/unsupported-contract-version")]);
    expect((await bridge.watch(target, ownership, 15000)).upgradeRequired).toMatchObject({
      installedVersion: 4,
      requiredVersion: 5,
    });
    expect(calls.length).toBe(1);
  });

  test("lost apply read-back cannot infer drops from installed state", async () => {
    const bridge = new FakeNetworkFilterBridge();
    bridge.setState("ready");
    bridge.ruleScripts.push("lost");
    const applied = await new IosAppNetworkRuleClient(bridge).applyOffline(
      { ...target, ...ownership },
      15000,
      () => 2,
    );
    expect(applied).toMatchObject({ kind: "applied", reconciled: true });
    expect("existingFlows" in applied).toBe(false);
  });
});
