import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ExecNetworkFilterBridge,
  NETWORK_FILTER_CONTRACT_VERSION,
} from "../../../src/features/network-filter/NetworkFilterBridge";
import {
  DefaultHostCommandExecutor,
  type ExecFileAsync,
} from "../../../src/utils/HostCommandExecutor";
import type { RawExecOutput } from "../../../src/utils/ExecSeam";
import { logger } from "../../../src/utils/logger";

const CONTROLLER = "/Applications/Test.app/Contents/MacOS/network-filter-controller";
const SIM_A = "12345678-1234-1234-1234-123456789ABC";
const DEVICE_SET = "/Users/test/Library/Developer/CoreSimulator/Devices";

function fixture(name: string): string {
  return readFileSync(
    join(import.meta.dir, "../../fixtures/network-filter-controller", `${name}.json`),
    "utf8",
  );
}

function execError(code: number | string | null, stdout = "", message = "Command failed"): Error {
  return Object.assign(new Error(message), { code, stdout, stderr: "" });
}

class ScriptedExecFile {
  readonly calls: string[][] = [];
  private outcome: { stdout: string } | { error: Error } = { stdout: "" };

  succeed(stdout: string): void {
    this.outcome = { stdout };
  }

  fail(error: Error): void {
    this.outcome = { error };
  }

  readonly exec: ExecFileAsync = async (_file, args): Promise<RawExecOutput> => {
    this.calls.push(args);
    if ("error" in this.outcome) {
      throw this.outcome.error;
    }
    return { stdout: this.outcome.stdout, stderr: "" };
  };
}

describe("ExecNetworkFilterBridge rule commands (#10264)", () => {
  let exec: ScriptedExecFile;
  let warn: ReturnType<typeof spyOn<typeof logger, "warn">>;
  const target = { udid: SIM_A, bundleId: "com.example.app" };
  const ownership = { owner: "session-a", ownerGeneration: 1759900000000, revision: 3 };

  const bridge = (installed = true) =>
    new ExecNetworkFilterBridge({
      executor: new DefaultHostCommandExecutor(exec.exec),
      controllerPath: CONTROLLER,
      exists: (path) => installed && path === CONTROLLER,
      managedSimulators: async () => {
        throw new Error("rule commands name their own simulator");
      },
      deviceSet: () => DEVICE_SET,
    });

  beforeEach(() => {
    exec = new ScriptedExecFile();
    warn = spyOn(logger, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  test("apply passes the target, ownership and lease, and returns the provider's verdict", async () => {
    exec.succeed(fixture("rule-applied"));

    const result = await bridge().apply(target, ownership, 15_000);

    expect(exec.calls).toEqual([
      [
        "apply",
        "--managed",
        DEVICE_SET,
        SIM_A,
        "--bundle-id",
        "com.example.app",
        "--owner",
        "session-a",
        "--owner-generation",
        "1759900000000",
        "--revision",
        "3",
        "--lease-ms",
        "15000",
      ],
    ]);
    expect(result).toEqual({
      state: "ready",
      detail: "Provider answered apply: applied.",
      contractVersion: NETWORK_FILTER_CONTRACT_VERSION,
      rule: { outcome: "applied", installedRevision: 3, leaseRemainingMilliseconds: 15000 },
    });
  });

  test("reset sends no lease and surfaces another session's ownership", async () => {
    exec.succeed(fixture("rule-owned-by-another-session"));

    const result = await bridge().reset(target, ownership);

    expect(exec.calls[0]?.[0]).toBe("reset");
    expect(exec.calls[0]).not.toContain("--lease-ms");
    expect(result.rule).toEqual({ outcome: "owned_by_another_session" });
  });

  test("renew passes the installed revision and lease", async () => {
    exec.succeed(
      `{"detail":"ok","rule":{"installedRevision":3,"outcome":"renewed"},"state":"ready","version":${NETWORK_FILTER_CONTRACT_VERSION}}\n`,
    );

    const result = await bridge().renew(target, ownership, 15_000);

    expect(exec.calls[0]?.[0]).toBe("renew");
    expect(exec.calls[0]?.slice(-4)).toEqual(["--revision", "3", "--lease-ms", "15000"]);
    expect(result.rule?.outcome).toBe("renewed");
  });

  test("a timeout is uncertain: no verdict is reported", async () => {
    exec.fail(execError(null, "", "Command timed out"));

    const result = await bridge().apply(target, ownership, 15_000);

    expect(result.state).toBe("unavailable");
    expect(result.rule).toBeUndefined();
  });

  test("the controller's own unavailable answer carries no verdict", async () => {
    exec.fail(execError(1, fixture("unavailable")));

    const result = await bridge().apply(target, ownership, 15_000);

    expect(result.state).toBe("unavailable");
    expect(result.rule).toBeUndefined();
  });

  test("an unknown rule outcome is unavailable, never a verdict", async () => {
    exec.succeed(
      `{"detail":"x","rule":{"outcome":"maybe"},"state":"ready","version":${NETWORK_FILTER_CONTRACT_VERSION}}\n`,
    );

    const result = await bridge().apply(target, ownership, 15_000);

    expect(result.state).toBe("unavailable");
    expect(result.rule).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test("not installed is reported without running anything", async () => {
    const result = await bridge(false).reset(target, ownership);

    expect(result.state).toBe("not_installed");
    expect(exec.calls).toEqual([]);
  });
});
