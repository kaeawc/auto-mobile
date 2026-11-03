import { describe, expect, test } from "bun:test";
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

function arrange(answers: object[]) {
  const calls: string[][] = [];
  const exec: ExecFileAsync = async (_file, args) => {
    calls.push(args);
    const answer = answers.shift();
    if (!answer) {
      throw new Error("unscripted exec");
    }
    return { stdout: JSON.stringify(answer), stderr: "" };
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
const result = (existingFlows: string) => ({
  version: 5,
  state: "ready",
  detail: "ok",
  rule: { outcome: "applied", existingFlows },
});

describe("contract 5 launch watches and existing-flow read-back", () => {
  test("watch negotiates 5 and sends only the watch condition", async () => {
    const { bridge, calls } = arrange([
      { version: 5, state: "ready", detail: "ok", rule: { outcome: "applied" } },
    ]);
    expect((await bridge.watch(target, ownership, 15000)).rule?.outcome).toBe("applied");
    expect(calls[0]?.slice(0, 3)).toEqual(["apply", "--contract-version", "5"]);
    expect(calls[0]?.slice(-2)).toEqual(["--watch-only", "true"]);
    expect(calls[0]).not.toContain("--delay-ms");
  });

  for (const existingFlows of ["dropped", "unaffected"] as const) {
    test(`offline read-back preserves ${existingFlows} through the client`, async () => {
      const { bridge, calls } = arrange([result(existingFlows)]);
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
    const { bridge } = arrange([result("planned")]);
    expect((await bridge.apply(target, ownership, 15000)).rule).toBeUndefined();
  });

  test("v4 rejection retries offline in 4 without claiming existing drops", async () => {
    const { bridge, calls } = arrange([
      {
        version: 4,
        state: "unavailable",
        detail: "Invalid or repeated --contract-version. Supported contract versions: 3, 4.",
      },
      {
        version: 4,
        state: "ready",
        detail: "ok",
        rule: { outcome: "applied", existingFlows: "dropped" },
      },
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
    const { bridge, calls } = arrange([
      {
        version: 4,
        state: "unavailable",
        detail: "Invalid or repeated --contract-version. Supported contract versions: 3, 4.",
      },
    ]);
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
