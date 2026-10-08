import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_NETWORK_FILTER_CONTROLLER_PATH,
  ExecNetworkFilterBridge,
  NETWORK_FILTER_CONTRACT_VERSION,
  NETWORK_FILTER_MAX_MANAGED_SIMULATORS,
  createManagedSimulatorLister,
  type ManagedSimulator,
  NETWORK_FILTER_CONTROLLER_TIMEOUT_MS,
  NETWORK_FILTER_INSTALL_COMMAND,
} from "../../../src/features/network-filter/NetworkFilterBridge";
import {
  DefaultHostCommandExecutor,
  type ExecFileAsync,
} from "../../../src/utils/HostCommandExecutor";
import { runWithAbortSignal } from "../../../src/utils/AbortContext";
import type { ExecSeamOptions, RawExecOutput } from "../../../src/utils/ExecSeam";
import { logger } from "../../../src/utils/logger";

const CONTROLLER = "/Applications/Test.app/Contents/MacOS/network-filter-controller";
const SIM_A = "12345678-1234-1234-1234-123456789ABC";
const SIM_B = "7B3A3792-DB53-4654-BA94-27A1D305C3B7";
// The production helper builds the default set with the host `path.join`, so the
// expectation must too (backslashes on Windows runners).
const DEVICE_SET = join("/Users/test", "Library", "Developer", "CoreSimulator", "Devices");

function fixture(name: string): string {
  return readFileSync(
    join(import.meta.dir, "../../fixtures/network-filter-controller", `${name}.json`),
    "utf8",
  );
}

/** Node's execFile rejection: exit code (or errno string) plus captured output. */
function execError(code: number | string | null, stdout = "", message = "Command failed"): Error {
  return Object.assign(new Error(message), { code, stdout, stderr: "" });
}

interface ExecCall {
  file: string;
  args: string[];
  options?: ExecSeamOptions;
}

/** Scripted `execFile` leaf behind the real host exec seam. */
class ScriptedExecFile {
  readonly calls: ExecCall[] = [];
  private outcome: { stdout: string } | { error: Error } = { stdout: "" };

  succeed(stdout: string): void {
    this.outcome = { stdout };
  }

  fail(error: Error): void {
    this.outcome = { error };
  }

  readonly exec: ExecFileAsync = async (file, args, options): Promise<RawExecOutput> => {
    this.calls.push({ file, args, options });
    if ("error" in this.outcome) {
      throw this.outcome.error;
    }
    return { stdout: this.outcome.stdout, stderr: "" };
  };
}

describe("ExecNetworkFilterBridge (#10590)", () => {
  let exec: ScriptedExecFile;
  let installed: boolean;
  let warn: ReturnType<typeof spyOn<typeof logger, "warn">>;
  let managed: ManagedSimulator[];
  let managedCalls: number;

  const bridge = () =>
    new ExecNetworkFilterBridge({
      executor: new DefaultHostCommandExecutor(exec.exec),
      controllerPath: CONTROLLER,
      exists: (path) => installed && path === CONTROLLER,
      managedSimulators: async () => {
        managedCalls += 1;
        return managed;
      },
    });

  beforeEach(() => {
    exec = new ScriptedExecFile();
    installed = true;
    managed = [];
    managedCalls = 0;
    warn = spyOn(logger, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  test("rethrows a cancelled request instead of reporting unavailable", async () => {
    const controller = new AbortController();
    exec.fail(execError(null, "", "aborted"));
    controller.abort(new Error("client cancelled"));

    await expect(runWithAbortSignal(controller.signal, () => bridge().status())).rejects.toThrow(
      "client cancelled",
    );
  });

  test("forwards the ambient request signal to the controller exec", async () => {
    const controller = new AbortController();
    exec.succeed(fixture("ready"));

    await runWithAbortSignal(controller.signal, () => bridge().status());

    expect(exec.calls[0]?.options?.signal).toBe(controller.signal);
  });

  test("defaults to the controller inside the /Applications bundle", () => {
    expect(DEFAULT_NETWORK_FILTER_CONTROLLER_PATH).toBe(
      "/Applications/AutoMobile Network Identity Probe.app/Contents/MacOS/network-filter-controller",
    );
  });

  test("reports not_installed without running anything when the controller is missing", async () => {
    installed = false;

    const status = await bridge().status();

    expect(status).toEqual({
      state: "not_installed",
      detail: `No network-filter-controller at ${CONTROLLER}.`,
    });
    expect(exec.calls).toEqual([]);
    expect(managedCalls).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });

  test("passes one --managed pair per booted simulator", async () => {
    managed = [
      { deviceSet: DEVICE_SET, udid: SIM_A },
      { deviceSet: DEVICE_SET, udid: SIM_B },
    ];
    exec.succeed(fixture("approval-required"));

    await bridge().snapshot();

    expect(exec.calls[0].args).toEqual([
      "snapshot",
      "--managed",
      DEVICE_SET,
      SIM_A,
      "--managed",
      DEVICE_SET,
      SIM_B,
    ]);
  });

  test("reports not_installed when the controller disappears before exec (ENOENT)", async () => {
    exec.fail(execError("ENOENT", "", "spawn ENOENT"));

    expect((await bridge().status()).state).toBe("not_installed");
  });

  test("runs `status` with a timeout above the controller's own 8 s deadline", async () => {
    exec.succeed(fixture("approval-required"));

    await bridge().status();

    expect(exec.calls).toHaveLength(1);
    expect(exec.calls[0].file).toBe(CONTROLLER);
    expect(exec.calls[0].args).toEqual(["status"]);
    expect(exec.calls[0].options?.timeout).toBe(NETWORK_FILTER_CONTROLLER_TIMEOUT_MS);
    expect(NETWORK_FILTER_CONTROLLER_TIMEOUT_MS).toBeGreaterThan(8_000);
  });

  test("parses approval_required from a zero exit", async () => {
    exec.succeed(fixture("approval-required"));

    expect(await bridge().status()).toEqual({
      state: "approval_required",
      detail:
        "Approve AutoMobile Network Identity Probe in System Settings, then run activate again.",
      contractVersion: NETWORK_FILTER_CONTRACT_VERSION,
    });
  });

  for (const [name, state] of [
    ["installation-required", "installation_required"],
    ["unavailable", "unavailable"],
  ] as const) {
    test(`parses ${state} from the JSON the controller prints before exiting 1`, async () => {
      exec.fail(execError(1, fixture(name)));

      const status = await bridge().status();

      expect(status.state).toBe(state);
      expect(status.contractVersion).toBe(NETWORK_FILTER_CONTRACT_VERSION);
      expect(warn).not.toHaveBeenCalled();
    });
  }

  test("snapshot returns the provider snapshot when ready; status omits it", async () => {
    exec.succeed(fixture("ready"));

    const snapshot = await bridge().snapshot();
    const status = await bridge().status();

    expect(exec.calls.map((call) => call.args)).toEqual([["snapshot"], ["status"]]);
    expect(snapshot.state).toBe("ready");
    expect(snapshot.snapshot).toMatchObject({
      version: 2,
      backend: "macos_network_extension",
      mode: "allow_only",
      observedFlows: 1,
      discardedFlows: 0,
    });
    expect(snapshot.snapshot?.flows).toHaveLength(1);
    expect(snapshot.snapshot?.flows[0].delegated).toBe(true);
    expect(status).toEqual({
      state: "ready",
      detail: snapshot.detail,
      contractVersion: NETWORK_FILTER_CONTRACT_VERSION,
    });
  });

  test("decodes v2 per-flow attribution and the managed simulators", async () => {
    const line = JSON.parse(fixture("ready"));
    const [flow] = line.snapshot.flows;
    line.snapshot.managedSimulators = [{ deviceSet: DEVICE_SET, udid: SIM_A }];
    line.snapshot.flows = [
      {
        ...flow,
        attribution: "attributed",
        method: "executable_path",
        simulator: { udid: SIM_A, deviceSet: DEVICE_SET, method: "executable_path" },
        app: {
          bundleId: "com.example.app",
          executablePath: `${DEVICE_SET}/${SIM_A}/data/Containers/Bundle/Application/X/App.app/App`,
          pid: 4242,
          pidVersion: 7,
        },
      },
      { ...flow, attribution: "unattributed", method: "unattributed", reason: "no_audit_token" },
      { ...flow, attribution: "conflicting", method: "unattributed", reason: "a_future_reason" },
    ];
    exec.succeed(`${JSON.stringify(line)}\n`);

    const result = await bridge().snapshot();

    expect(result.state).toBe("ready");
    expect(result.snapshot?.managedSimulators).toEqual([{ deviceSet: DEVICE_SET, udid: SIM_A }]);
    expect(result.snapshot?.flows.map((entry) => entry.attribution)).toEqual([
      "attributed",
      "unattributed",
      "conflicting",
    ]);
    expect(result.snapshot?.flows[0].app).toMatchObject({ pid: 4242, pidVersion: 7 });
    expect(result.snapshot?.flows[1].reason).toBe("no_audit_token");
    expect(warn).not.toHaveBeenCalled();
  });

  test("an unknown attribution status is unavailable, never silently accepted", async () => {
    const line = JSON.parse(fixture("ready"));
    line.snapshot.flows = [{ ...line.snapshot.flows[0], attribution: "maybe" }];
    exec.succeed(`${JSON.stringify(line)}\n`);

    expect((await bridge().snapshot()).state).toBe("unavailable");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test("a version 1 controller is unavailable with a reinstall step (no fallback)", async () => {
    exec.succeed('{"detail":"x","state":"ready","version":1}\n');

    const status = await bridge().status();

    expect(status.state).toBe("unavailable");
    expect(status.contractVersion).toBe(1);
    expect(status.detail).toContain("contract version 1");
    expect(status.detail).toContain(NETWORK_FILTER_INSTALL_COMMAND);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test("a contract version mismatch is unavailable with a reinstall step", async () => {
    const line = JSON.parse(fixture("ready"));
    exec.succeed(`${JSON.stringify({ ...line, version: 3 })}\n`);

    const status = await bridge().status();

    expect(status.state).toBe("unavailable");
    expect(status.contractVersion).toBe(3);
    expect(status.detail).toContain("contract version 3");
    expect(status.detail).toContain(`expects version ${NETWORK_FILTER_CONTRACT_VERSION}`);
    expect(status.detail).toContain(NETWORK_FILTER_INSTALL_COMMAND);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test("malformed JSON is unavailable and logged", async () => {
    exec.succeed("not json\n");

    const status = await bridge().status();

    expect(status).toEqual({
      state: "unavailable",
      detail: "network-filter-controller status printed no JSON result.",
    });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test("an unknown state is unavailable and logged", async () => {
    exec.succeed('{"detail":"x","state":"installed","version":2}\n');

    const status = await bridge().status();

    expect(status.state).toBe("unavailable");
    expect(status.detail).toContain(
      `does not match contract version ${NETWORK_FILTER_CONTRACT_VERSION}`,
    );
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test("a result without a version is unavailable", async () => {
    exec.succeed('{"detail":"x","state":"ready"}\n');

    expect((await bridge().status()).state).toBe("unavailable");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test("a timeout with no output is unavailable and logged, never thrown", async () => {
    exec.fail(
      Object.assign(execError(null, "", "Command failed: timed out"), {
        killed: true,
        signal: "SIGTERM",
      }),
    );

    const status = await bridge().status();

    expect(status.state).toBe("unavailable");
    expect(status.detail).toContain("network-filter-controller status failed");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test("ignores leading noise and parses the last JSON line", async () => {
    exec.succeed(`objc[1]: warning noise\n${fixture("approval-required")}`);

    expect((await bridge().status()).state).toBe("approval_required");
  });
});

describe("createManagedSimulatorLister (#10590)", () => {
  let warn: ReturnType<typeof spyOn<typeof logger, "warn">>;

  beforeEach(() => {
    warn = spyOn(logger, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  test("pairs each booted simulator with the default device set", async () => {
    const list = createManagedSimulatorLister({
      listBootedSimulators: async () => [
        { deviceId: SIM_A },
        { deviceId: SIM_B },
        { deviceId: SIM_A },
      ],
      environment: {},
      homeDirectory: () => "/Users/test",
    });

    expect(await list()).toEqual([
      { deviceSet: DEVICE_SET, udid: SIM_A },
      { deviceSet: DEVICE_SET, udid: SIM_B },
    ]);
  });

  test("rethrows a cancelled request instead of returning no simulators", async () => {
    const controller = new AbortController();
    controller.abort(new Error("client cancelled"));
    const list = createManagedSimulatorLister({
      listBootedSimulators: async () => {
        throw new Error("simctl aborted");
      },
    });

    await expect(runWithAbortSignal(controller.signal, list)).rejects.toThrow("client cancelled");
  });

  test("honours CORESIMULATOR_DEVICE_SET_PATH", async () => {
    const list = createManagedSimulatorLister({
      listBootedSimulators: async () => [{ deviceId: SIM_A }],
      environment: { CORESIMULATOR_DEVICE_SET_PATH: "/custom/set" },
      homeDirectory: () => "/Users/test",
    });

    expect(await list()).toEqual([{ deviceSet: "/custom/set", udid: SIM_A }]);
  });

  test("drops ids that are not simulator UDIDs and caps the pairs", async () => {
    const many = Array.from({ length: NETWORK_FILTER_MAX_MANAGED_SIMULATORS + 5 }, (_, index) => ({
      deviceId: `00000000-0000-0000-0000-${index.toString(16).padStart(12, "0").toUpperCase()}`,
    }));
    const list = createManagedSimulatorLister({
      listBootedSimulators: async () => [{ deviceId: "emulator-5554" }, ...many],
      environment: {},
      homeDirectory: () => "/Users/test",
    });

    const pairs = await list();

    expect(pairs).toHaveLength(NETWORK_FILTER_MAX_MANAGED_SIMULATORS);
    expect(pairs.some((pair) => pair.udid === "emulator-5554")).toBe(false);
  });

  test("a listing failure yields no pairs and is logged", async () => {
    const list = createManagedSimulatorLister({
      listBootedSimulators: async () => {
        throw new Error("simctl failed");
      },
      environment: {},
      homeDirectory: () => "/Users/test",
    });

    expect(await list()).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
