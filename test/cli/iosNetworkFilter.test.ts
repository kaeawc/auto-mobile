import { describe, expect, test } from "bun:test";
import {
  NETWORK_FILTER_USAGE_EXIT_CODE,
  parseIosNetworkFilterArgs,
  runIosNetworkFilterCommand,
  type IosNetworkFilterCommandDeps,
} from "../../src/cli/iosNetworkFilter";
import { hasGlobalHelpFlag } from "../../src/cli/helpFlag";
import type { NetworkFilterInstallState } from "../../src/features/networkFilter/networkFilterApp";

function deps(state: NetworkFilterInstallState, platform: NodeJS.Platform = "darwin") {
  const lines: string[] = [];
  const upgrades: boolean[] = [];
  const value: IosNetworkFilterCommandDeps = {
    install: async ({ upgrade }) => {
      upgrades.push(upgrade);
      return { state, detail: "d", action: "none", installedPath: "/Applications/x.app" };
    },
    status: async () => ({
      installed: true,
      installedPath: "/Applications/x.app",
      installedVersion: "0.0.90",
      expectedVersion: "0.0.90",
      report: { state, controllerState: state, detail: "d" },
    }),
    platform,
    write: (line) => lines.push(line),
  };
  return { value, lines, upgrades };
}

describe("--ios-network-filter", () => {
  test("parses install, install --upgrade and status", () => {
    expect(parseIosNetworkFilterArgs(["install"])).toEqual({ command: "install", upgrade: false });
    expect(parseIosNetworkFilterArgs(["install", "--upgrade"])).toEqual({
      command: "install",
      upgrade: true,
    });
    expect(parseIosNetworkFilterArgs(["status"])).toEqual({ command: "status" });
    expect(() => parseIosNetworkFilterArgs([])).toThrow("Usage");
    expect(() => parseIosNetworkFilterArgs(["install", "--force"])).toThrow("--force");
  });

  test("maps install states to the activate wrapper's exit codes", async () => {
    const expected: Record<NetworkFilterInstallState, number> = {
      ready: 0,
      approval_required: 3,
      restart_required: 4,
      unavailable: 1,
      failed: 1,
    };
    for (const [state, code] of Object.entries(expected)) {
      const { value, lines } = deps(state as NetworkFilterInstallState);
      expect(await runIosNetworkFilterCommand(["install"], value)).toBe(code);
      expect(JSON.parse(lines[0] ?? "{}").state).toBe(state);
    }
  });

  test("forwards --upgrade and rejects bad usage with exit 2", async () => {
    const { value, upgrades, lines } = deps("ready");
    await runIosNetworkFilterCommand(["install", "--upgrade"], value);
    expect(upgrades).toEqual([true]);
    expect(await runIosNetworkFilterCommand(["uninstall"], value)).toBe(
      NETWORK_FILTER_USAGE_EXIT_CODE,
    );
    expect(lines.at(-1)).toContain("Usage");
  });

  test("status prints the read-only state and is unavailable off macOS", async () => {
    const mac = deps("approval_required");
    expect(await runIosNetworkFilterCommand(["status"], mac.value)).toBe(3);
    const linux = deps("ready", "linux");
    expect(await runIosNetworkFilterCommand(["status"], linux.value)).toBe(1);
    expect(linux.lines[0]).toContain("unavailable");
  });

  test("help flags after the command boundary belong to the command", () => {
    expect(hasGlobalHelpFlag(["--ios-network-filter", "install", "--help"])).toBe(false);
  });

  test("dispatches before any daemon or server import", async () => {
    const entrypoint = await Bun.file("src/index.ts").text();
    const dispatch = entrypoint.indexOf('rawArgs.indexOf("--ios-network-filter")');
    const serverImport = entrypoint.indexOf('await import("./server")');
    expect(dispatch).toBeGreaterThanOrEqual(0);
    expect(dispatch).toBeLessThan(serverImport);
  });
});
