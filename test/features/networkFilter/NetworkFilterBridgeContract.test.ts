import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ExecNetworkFilterBridge,
  ExpiringControllerVersionMemory,
  NETWORK_FILTER_UPGRADE_COMMAND,
  type NetworkFilterRuleCommandResult,
} from "../../../src/features/networkFilter/NetworkFilterBridge";
import {
  DefaultHostCommandExecutor,
  type ExecFileAsync,
} from "../../../src/utils/HostCommandExecutor";
import { logger } from "../../../src/utils/logger";

const target = { udid: "DFBF2D27-6674-42EA-AFC4-AB702275D1D4", bundleId: "com.example.app" };
const owner = { owner: "session-a", ownerGeneration: 100, revision: 4 };
const shaping = { delayMs: 100, downloadKbps: 80, uploadKbps: 40, packetLossPercent: 2.5 };
const fixture = (name: string) =>
  readFileSync(
    join(import.meta.dir, "../../fixtures/network-filter-controller", `${name}.json`),
    "utf8",
  );

class ScriptedExec {
  readonly calls: string[][] = [];
  readonly answers: Array<string | Error> = [];
  readonly exec: ExecFileAsync = async (_file, args) => {
    this.calls.push(args);
    const answer = this.answers.shift();
    if (answer instanceof Error) {
      throw answer;
    }
    if (answer === undefined) {
      throw new Error("unscripted exec");
    }
    return { stdout: answer, stderr: "" };
  };
  legacy(command: string): void {
    this.answers.push(
      Object.assign(new Error("exit 2"), {
        code: 2,
        stdout: fixture(`v3-app/${command}-contract-flag-rejected`),
      }),
    );
  }
}

describe("controller contract negotiation and shaping", () => {
  let exec: ScriptedExec;
  let bridge: ExecNetworkFilterBridge;
  let warn: ReturnType<typeof spyOn<typeof logger, "warn">>;
  beforeEach(() => {
    exec = new ScriptedExec();
    bridge = new ExecNetworkFilterBridge({
      versionMemory: new ExpiringControllerVersionMemory(),
      executor: new DefaultHostCommandExecutor(exec.exec),
      exists: () => true,
      deviceSet: () => "/fixture/Devices",
      managedSimulators: async () => [],
    });
    warn = spyOn(logger, "warn").mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  test("v4 snapshot preserves mixed rules and shaping activity", async () => {
    exec.answers.push(fixture("v4/ready"));
    const result = await bridge.snapshot();
    expect(exec.calls).toEqual([["snapshot", "--contract-version", "4"]]);
    expect(result.contractVersion).toBe(4);
    expect(result.snapshot).toEqual(JSON.parse(fixture("v4/ready")).snapshot);
    expect(result.snapshot?.rules?.map((rule) => rule.condition)).toEqual(["offline", "shaped"]);
  });

  for (const name of [
    "rule-applied-shaped",
    "rule-unsupported-condition",
    "rule-invalid-shaping",
    "rule-applied",
    "rule-owned-by-another-session",
  ]) {
    test(`v4 ${name} preserves the provider verdict`, async () => {
      exec.answers.push(fixture(`v4/${name}`));
      const result = await bridge.apply(target, owner, 15_000, shaping);
      expect(result.contractVersion).toBe(4);
      expect(result.rule).toEqual(JSON.parse(fixture(`v4/${name}`)).rule);
      expect(exec.calls[0]?.slice(0, 3)).toEqual(["apply", "--contract-version", "4"]);
      expect(exec.calls[0]?.slice(-8)).toEqual([
        "--delay-ms",
        "100",
        "--down-kbps",
        "80",
        "--up-kbps",
        "40",
        "--packet-loss-percent",
        "2.5",
      ]);
      expect(exec.calls[0]?.indexOf("--delay-ms")).toBeGreaterThan(
        exec.calls[0]?.indexOf("--revision") ?? 0,
      );
    });
  }

  for (const loss of [undefined, 0]) {
    test(`loss ${loss} is omitted; integer shaping and lease fields round`, async () => {
      exec.answers.push(fixture("v4/rule-applied-shaped"));
      await bridge.apply(target, owner, 15000.6, {
        delayMs: 100.6,
        downloadKbps: 80.4,
        uploadKbps: 40.5,
        packetLossPercent: loss,
      });
      expect(exec.calls[0]?.slice(-8)).toEqual([
        "--lease-ms",
        "15001",
        "--delay-ms",
        "101",
        "--down-kbps",
        "80",
        "--up-kbps",
        "41",
      ]);
      expect(exec.calls[0]).not.toContain("--packet-loss-percent");
    });
  }

  for (const command of ["status", "snapshot", "apply", "reset", "renew"] as const) {
    test(`legacy ${command} retries exactly once and remembers the controller`, async () => {
      exec.legacy(command);
      const output =
        command === "apply"
          ? fixture("rule-applied")
          : command === "reset" || command === "renew"
            ? JSON.stringify({
                version: 3,
                state: "ready",
                detail: "ok",
                rule: { outcome: command === "reset" ? "reset" : "renewed" },
              })
            : fixture("ready");
      exec.answers.push(output, output);
      const invoke = () =>
        command === "apply" || command === "renew"
          ? bridge[command](target, owner, 15000)
          : command === "reset"
            ? bridge.reset(target, owner)
            : bridge[command]();
      const first = await invoke();
      expect(first.state).toBe("ready");
      expect(first.contractVersion).toBe(3);
      expect(exec.calls).toHaveLength(2);
      expect(exec.calls[0]?.slice(0, 3)).toEqual([command, "--contract-version", "4"]);
      expect(exec.calls[1]).toEqual([command, ...exec.calls[0]!.slice(3)]);
      const second = await invoke();
      expect(second.contractVersion).toBe(3);
      expect(exec.calls).toHaveLength(3);
      expect(exec.calls[2]).toEqual(exec.calls[1]);
    });
  }

  test("legacy shaped apply requires an upgrade, re-probes, and clears memory on v4", async () => {
    exec.legacy("apply-shaped");
    const first = await bridge.apply(target, owner, 15000, shaping);
    expect(first).toMatchObject({
      state: "unavailable",
      contractVersion: 3,
      upgradeRequired: {
        installedVersion: 3,
        requiredVersion: 4,
        command: NETWORK_FILTER_UPGRADE_COMMAND,
      },
    });
    expect(first.rule).toBeUndefined();
    expect(first.detail).toContain("3");
    expect(first.detail).toContain("4");
    expect(first.detail).toContain("auto-mobile --ios-network-filter install --upgrade");
    expect(exec.calls).toHaveLength(1);
    exec.answers.push(fixture("ready"));
    expect((await bridge.status()).contractVersion).toBe(3);
    expect(exec.calls[1]).toEqual(["status"]);
    exec.legacy("apply-shaped");
    expect((await bridge.apply(target, owner, 15000, shaping)).upgradeRequired).toEqual(
      first.upgradeRequired,
    );
    expect(exec.calls).toHaveLength(3);
    exec.answers.push(fixture("v4/rule-applied-shaped"), fixture("v4/ready"));
    expect((await bridge.apply(target, owner, 15000, shaping)).rule?.outcome).toBe("applied");
    expect((await bridge.status()).contractVersion).toBe(4);
    expect(exec.calls[4]).toEqual(["status", "--contract-version", "4"]);
  });

  for (const name of ["ready", "unavailable", "rule-applied"]) {
    test(`v3 ${name} answering a v4 request is a mismatch without fallback`, async () => {
      exec.answers.push(fixture(name));
      const result = await bridge.apply(target, owner, 15000);
      expect(result.state).toBe("unavailable");
      expect(result.contractVersion).toBe(3);
      expect(result.detail).toContain("expects versions 3 and 4");
      expect(result.rule).toBeUndefined();
      expect(result.upgradeRequired).toBeUndefined();
      expect(exec.calls).toHaveLength(1);
    });
  }

  for (const version of [1, 2, 5]) {
    test(`unknown version ${version} is rejected before interpreting the body`, async () => {
      exec.answers.push(
        JSON.stringify({ ...JSON.parse(fixture("v4/rule-applied-shaped")), version }),
      );
      const result = await bridge.apply(target, owner, 15000, shaping);
      expect(result).toMatchObject({ state: "unavailable", contractVersion: version });
      expect(result.rule).toBeUndefined();
      expect(result.detail).toContain(`contract version ${version}`);
      expect(result.detail).toContain("expects versions 3 and 4");
      expect(exec.calls).toHaveLength(1);
    });
  }

  test("v3 shaped rules fail the v3 schema even after legacy detection", async () => {
    exec.legacy("status");
    exec.answers.push(JSON.stringify({ ...JSON.parse(fixture("v4/ready")), version: 3 }));
    const result = await bridge.status();
    expect(result.state).toBe("unavailable");
    expect(result.rules).toBeUndefined();
  });

  test("v4 does not accept a v3 snapshot body", async () => {
    exec.answers.push(JSON.stringify({ ...JSON.parse(fixture("ready")), version: 4 }));
    expect((await bridge.snapshot()).state).toBe("unavailable");
  });

  test("a mismatching earlier line cannot hide behind a valid v4 verdict", async () => {
    exec.answers.push(fixture("rule-applied") + fixture("v4/rule-applied"));
    const result: NetworkFilterRuleCommandResult = await bridge.apply(target, owner, 15000);
    expect(result.state).toBe("unavailable");
    expect(result.contractVersion).toBe(3);
    expect(result.rule).toBeUndefined();
    expect(exec.calls).toHaveLength(1);
  });

  test("all v4 lines are validated, not just the last one", async () => {
    exec.answers.push(
      JSON.stringify({ ...JSON.parse(fixture("v4/rule-applied")), rule: { outcome: "unknown" } }) +
        "\n" +
        fixture("v4/rule-applied"),
    );
    expect((await bridge.apply(target, owner, 15000)).state).toBe("unavailable");
  });

  test("any valid v4 answer clears legacy memory even on a flagless request", async () => {
    exec.legacy("apply-shaped");
    await bridge.apply(target, owner, 15000, shaping);
    exec.answers.push(fixture("v4/ready"), fixture("v4/ready"));
    expect((await bridge.status()).contractVersion).toBe(4);
    expect(exec.calls[1]).toEqual(["status"]);
    expect((await bridge.status()).contractVersion).toBe(4);
    expect(exec.calls[2]).toEqual(["status", "--contract-version", "4"]);
  });

  test("legacy rejection still falls back after a leading runtime diagnostic", async () => {
    exec.answers.push(
      "objc[1]: warning noise\n" + fixture("v3-app/status-contract-flag-rejected"),
      fixture("ready"),
    );
    expect((await bridge.status()).contractVersion).toBe(3);
    expect(exec.calls).toEqual([["status", "--contract-version", "4"], ["status"]]);
  });

  for (const command of ["status", "reset", "renew"] as const) {
    test(`shared memory skips a second fallback and expires for ${command}`, async () => {
      const versionMemory = new ExpiringControllerVersionMemory();
      let nowMs = 100;
      const options = {
        versionMemory,
        now: () => nowMs,
        executor: new DefaultHostCommandExecutor(exec.exec),
        exists: () => true,
        managedSimulators: async () => [],
        deviceSet: () => "/fixture/Devices",
      };
      const first = new ExecNetworkFilterBridge(options);
      const second = new ExecNetworkFilterBridge(options);
      const invoke = () =>
        command === "status"
          ? second.status()
          : command === "reset"
            ? second.reset(target, owner)
            : second.renew(target, owner, 15000);
      const answer =
        command === "status"
          ? fixture("ready")
          : JSON.stringify({
              ...JSON.parse(fixture("rule-applied")),
              rule: { outcome: command === "reset" ? "reset" : "renewed", installedRevision: 4 },
            });
      exec.legacy("status");
      exec.answers.push(fixture("ready"));
      await first.status();
      nowMs += 59_999;
      exec.answers.push(answer);
      expect((await invoke()).contractVersion).toBe(3);
      expect(exec.calls[2]?.slice(0, 3)).not.toContain("--contract-version");
      nowMs += 1;
      exec.legacy(command);
      exec.answers.push(answer, answer);
      expect((await invoke()).contractVersion).toBe(3);
      expect(exec.calls[3]?.slice(0, 3)).toEqual([command, "--contract-version", "4"]);
      expect(exec.calls[4]).not.toContain("--contract-version");
      await invoke();
      expect(exec.calls[5]).not.toContain("--contract-version");
      expect(exec.calls).toHaveLength(6);
    });
  }

  test("memory is keyed by controller path and an upgrade clears shared memory", async () => {
    const versionMemory = new ExpiringControllerVersionMemory();
    const options = {
      versionMemory,
      now: () => 0,
      executor: new DefaultHostCommandExecutor(exec.exec),
      exists: () => true,
      managedSimulators: async () => [],
      deviceSet: () => "/fixture/Devices",
    };
    const first = new ExecNetworkFilterBridge({ ...options, controllerPath: "/first" });
    const second = new ExecNetworkFilterBridge({ ...options, controllerPath: "/first" });
    const other = new ExecNetworkFilterBridge({ ...options, controllerPath: "/other" });
    exec.legacy("status");
    exec.answers.push(
      fixture("ready"),
      fixture("v4/ready"),
      fixture("v4/rule-applied-shaped"),
      fixture("v4/ready"),
    );
    await first.status();
    await other.status();
    expect(exec.calls[2]).toEqual(["status", "--contract-version", "4"]);
    await second.apply(target, owner, 15000, shaping);
    expect(exec.calls[3]?.slice(0, 3)).toEqual(["apply", "--contract-version", "4"]);
    await first.status();
    expect(exec.calls[4]).toEqual(["status", "--contract-version", "4"]);
  });

  test("legacy flag rejection is expected and never warns", async () => {
    exec.legacy("status");
    exec.answers.push(fixture("ready"));
    expect((await bridge.status()).contractVersion).toBe(3);
    expect(warn).not.toHaveBeenCalled();
  });

  for (const noise of ["0", "null", '\"diagnostic\"', "{ not json", '{"message":"log"}']) {
    test(`ignores diagnostic line ${noise}`, async () => {
      exec.answers.push(noise + "\n" + fixture("v4/ready"));
      expect((await bridge.snapshot()).snapshot).toEqual(JSON.parse(fixture("v4/ready")).snapshot);
      expect(warn).not.toHaveBeenCalled();
    });
  }

  for (const activity of [
    {
      ...JSON.parse(fixture("v4/ready")).snapshot.shapingActivity,
      untrackedDataCallbacks: 18446744073709551615,
    },
    { ...JSON.parse(fixture("v4/ready")).snapshot.shapingActivity, newCounter: 0 },
  ]) {
    test(`invalid diagnostic activity is dropped: ${JSON.stringify(activity)}`, async () => {
      const line = JSON.parse(fixture("v4/ready"));
      line.snapshot.shapingActivity = activity;
      exec.answers.push(JSON.stringify(line));
      const result = await bridge.snapshot();
      delete line.snapshot.shapingActivity;
      expect(result.state).toBe("ready");
      expect(result.snapshot).toEqual(line.snapshot);
      expect(warn).toHaveBeenCalledTimes(1);
    });
  }

  for (const [field, values] of [
    ["delayMs", [NaN, -5, -0.1, 1e21, Infinity, Number.MAX_SAFE_INTEGER + 1]],
    ["downloadKbps", [NaN, -5, -0.1, 1e21, Infinity, Number.MAX_SAFE_INTEGER + 1]],
    ["uploadKbps", [NaN, -5, -0.1, 1e21, Infinity, Number.MAX_SAFE_INTEGER + 1]],
    ["packetLossPercent", [NaN, -1, -3, Infinity, 101]],
  ] as const) {
    for (const value of values) {
      test(`bridge rejects ${field}=${value} without exec`, async () => {
        const result = await bridge.apply(target, owner, 15000, { ...shaping, [field]: value });
        expect(result.state).toBe("unavailable");
        expect(result.detail).toContain(field);
        expect(result.rule).toBeUndefined();
        expect(exec.calls).toHaveLength(0);
      });
    }
  }

  test("packet loss uses decimal notation even for subnormal values", async () => {
    exec.answers.push(fixture("v4/rule-applied-shaped"));
    await bridge.apply(target, owner, 15000, { ...shaping, packetLossPercent: Number.MIN_VALUE });
    const args = exec.calls[0];
    const loss = args[args.indexOf("--packet-loss-percent") + 1];
    expect(loss).not.toContain("e");
    expect(Number(loss)).toBe(Number.MIN_VALUE);
  });

  test("last controller line wins over earlier same-version non-ready answers and trailing noise", async () => {
    exec.answers.push(fixture("v4/unavailable") + fixture("v4/ready") + "diagnostic\n");
    expect((await bridge.snapshot()).snapshot).toEqual(JSON.parse(fixture("v4/ready")).snapshot);
    expect(warn).not.toHaveBeenCalled();
  });

  test("multiple legacy rejection lines never allow fallback", async () => {
    exec.answers.push(
      fixture("v3-app/status-contract-flag-rejected") +
        fixture("v3-app/status-contract-flag-rejected"),
    );
    expect((await bridge.status()).state).toBe("unavailable");
    expect(exec.calls).toHaveLength(1);
  });

  test("TTL expiry notices an upgraded controller on a reset-only bridge", async () => {
    const versionMemory = new ExpiringControllerVersionMemory();
    versionMemory.markLegacy("/controller", 0);
    let nowMs = 59_999;
    const resetOnly = new ExecNetworkFilterBridge({
      versionMemory,
      now: () => nowMs,
      controllerPath: "/controller",
      exists: () => true,
      deviceSet: () => "/fixture/Devices",
      executor: new DefaultHostCommandExecutor(exec.exec),
    });
    const rule = { outcome: "reset" };
    exec.answers.push(JSON.stringify({ ...JSON.parse(fixture("rule-applied")), rule }));
    await resetOnly.reset(target, owner);
    expect(exec.calls[0]).not.toContain("--contract-version");
    nowMs = 60_000;
    exec.answers.push(JSON.stringify({ ...JSON.parse(fixture("v4/rule-applied")), rule }));
    expect((await resetOnly.reset(target, owner)).contractVersion).toBe(4);
    expect(exec.calls[1]?.slice(0, 3)).toEqual(["reset", "--contract-version", "4"]);
    expect(versionMemory.isLegacy("/controller", nowMs)).toBe(false);
  });

  for (const patch of [
    { state: "ready" },
    { version: 4 },
    { detail: "Unexpected argument '--managed'" },
    { detail: "Unexpected argument '--contract-version-extra'" },
  ]) {
    test(`only the exact legacy rejection permits fallback: ${JSON.stringify(patch)}`, async () => {
      exec.answers.push(
        JSON.stringify({
          ...JSON.parse(fixture("v3-app/status-contract-flag-rejected")),
          ...patch,
        }),
      );
      expect((await bridge.status()).state).toBe("unavailable");
      expect(exec.calls).toHaveLength(1);
      exec.answers.push(fixture("v4/ready"));
      await bridge.status();
      expect(exec.calls[1]).toEqual(["status", "--contract-version", "4"]);
    });
  }

  test("per-rule shaping activity counters survive decoding", async () => {
    const line = JSON.parse(fixture("v4/ready"));
    const installed = line.snapshot.rules[1];
    const activity = {
      target: installed.target,
      owner: installed.owner,
      ownerGeneration: installed.ownerGeneration,
      revision: installed.revision,
      trackedFlows: 2,
      pausedFlows: 1,
      outboundReleasedBytes: 123,
      inboundReleasedBytes: 456,
      outboundHeldBursts: 3,
      inboundHeldBursts: 4,
      overBudgetDrops: 5,
      refusedFlows: 6,
      callbacksWhilePaused: 7,
      debtReleases: 8,
    };
    line.snapshot.shapingActivity.flows = [activity];
    exec.answers.push(JSON.stringify(line));
    expect((await bridge.snapshot()).snapshot?.shapingActivity?.flows).toEqual([activity]);
  });

  for (const condition of ["offline", "shaped"] as const) {
    test(`v4 ${condition} rejects an invalid shaping sibling`, async () => {
      const line = JSON.parse(fixture("v4/ready"));
      const entry = line.snapshot.rules.find(
        (candidate: { condition: string }) => candidate.condition === condition,
      );
      if (condition === "offline") {
        entry.shaping = line.snapshot.rules[1].shaping;
      } else {
        delete entry.shaping;
      }
      exec.answers.push(JSON.stringify(line));
      expect((await bridge.snapshot()).state).toBe("unavailable");
    });
  }

  test("errors preparing arguments become logged typed failures", async () => {
    const failing = new ExecNetworkFilterBridge({
      versionMemory: new ExpiringControllerVersionMemory(),
      exists: () => true,
      managedSimulators: async () => {
        throw new Error("listing failed");
      },
    });
    expect((await failing.status()).state).toBe("unavailable");
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
