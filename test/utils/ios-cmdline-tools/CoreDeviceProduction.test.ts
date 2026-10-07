import {
  createIosDoctorDependencies,
  checkCoreDeviceVersion,
} from "../../../src/doctor/checks/ios";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ProductionDevicectlCommandInvoker } from "../../../src/utils/ios-cmdline-tools/ProductionDevicectlCommandInvoker";
import {
  createCoreDeviceProbeHolder,
  createProductionCoreDeviceProbe,
} from "../../../src/utils/ios-cmdline-tools/CoreDeviceProbeHolder";
import type {
  HostCommandExecutor,
  HostCommandOptions,
} from "../../../src/utils/HostCommandExecutor";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeLogger } from "../../fakes/FakeLogger";
import { FakeHostCommandExecutor } from "../../fakes/FakeHostCommandExecutor";

const capture = (name: string) =>
  readFileSync(join(process.cwd(), `test/fixtures/ios-devicectl/${name}.json`), "utf8");
function harness(name = "info-lockstate-booted-simulator-1001") {
  const calls: Array<{ args: string[]; options?: HostCommandOptions }> = [];
  const timer = new FakeTimer();
  const logger = new FakeLogger();
  let failure: Error | undefined = new Error("exit 1");
  let output = capture(name);
  const executor: HostCommandExecutor = {
    executeCommand: async (_file, args = [], options) => {
      calls.push({ args, options });
      if (failure) {
        throw failure;
      }
      return new FakeHostCommandExecutor().executeCommand("fake");
    },
  };
  const removed: string[] = [];
  const files = {
    tmpdir: () => "/fake",
    mkdtemp: async () => "/fake/probe",
    readFile: async () => output,
    rm: async (path: string) => {
      removed.push(path);
    },
  };
  const invoker = new ProductionDevicectlCommandInvoker({
    executor,
    files,
    timer,
    logger,
    timeoutMs: 5000,
  });
  return {
    invoker,
    executor,
    files,
    timer,
    logger,
    calls,
    removed,
    setFailure: (error?: Error) => {
      failure = error;
    },
    setOutput: (text: string) => {
      output = text;
    },
  };
}

describe("production CoreDevice wiring", () => {
  test.each([
    ["info-lockstate-booted-simulator-1001", "com.apple.coredevice.feature.getlockstate"],
    [
      "motion-hinge-angle-booted-nonduo-simulator-1001",
      "com.apple.coredevice.feature.monitormotion",
    ],
    ["info-files-appdatacontainer-booted-simulator-1001", "com.apple.coredevice.feature.listFiles"],
  ])("classifies captured %s even after a rejected exec", async (name, featureId) => {
    const h = harness(name);
    expect(await h.invoker.invoke("sim-1", "info lockState")).toEqual({
      kind: "unsupported",
      capabilityFeatureId: featureId,
    });
    expect(h.calls[0].options?.timeoutMs).toBe(5000);
    expect(h.calls[0].options?.signal).toBeDefined();
    expect(h.calls[0].args).toContain("--json-output");
    expect(h.removed).toEqual(["/fake/probe"]);
  });

  test("accepts captured success only after successful exec", async () => {
    const h = harness("info-displays-booted-simulator");
    h.setFailure();
    expect(await h.invoker.invoke("sim-1", "info displays")).toEqual({
      kind: "ok",
      output: capture("info-displays-booted-simulator"),
    });
    h.setFailure(new Error("exit 1"));
    expect((await h.invoker.invoke("sim-1", "info displays")).kind).toBe("failed");
    h.setOutput("invalid JSON");
    expect((await h.invoker.invoke("sim-1", "info displays")).kind).toBe("failed");
  });

  test.each([
    ["direct string", false, false],
    ["direct buffer", false, true],
    ["wrapped string", true, false],
    ["wrapped buffer", true, true],
  ] as const)(
    "preserves %s devicectl stderr when the result file is missing",
    async (_name, wrapped, buffer) => {
      const h = harness();
      // Reused from DeviceAppManager.test.ts's unrelated terminate failure regression.
      const stderr = "ERROR: The device is locked. Unlock it and try again.";
      const commandError = Object.assign(new Error("exit 1"), {
        code: 1,
        stderr: buffer ? Buffer.from(stderr) : stderr,
      });
      const failure = wrapped ? new Error("Command failed", { cause: commandError }) : commandError;
      h.setFailure(failure);
      h.files.readFile = async () => {
        throw Object.assign(new Error("ENOENT: no such file or directory, result.json"), {
          code: "ENOENT",
        });
      };

      expect(await h.invoker.invoke("sim-1", "info lockState")).toMatchObject({
        kind: "failed",
        message: expect.stringContaining(stderr),
      });
      expect(h.logger.at("warn").some((entry) => entry.args.includes(failure))).toBe(true);
      expect(h.removed).toEqual(["/fake/probe"]);
    },
  );

  test("preserves devicectl failure when its result file contains invalid JSON", async () => {
    const h = harness();
    h.setOutput("invalid JSON");
    const failure = new Error("devicectl command failed");
    h.setFailure(failure);

    expect(await h.invoker.invoke("sim-1", "info lockState")).toEqual({
      kind: "failed",
      message: failure.message,
    });
    expect(h.logger.at("warn")[0].args).toContain(failure);
  });

  test("reports the missing result file when exec succeeds", async () => {
    const h = harness();
    h.setFailure();
    const failure = Object.assign(new Error("ENOENT: no such file or directory, result.json"), {
      code: "ENOENT",
    });
    h.files.readFile = async () => {
      throw failure;
    };

    expect(await h.invoker.invoke("sim-1", "info lockState")).toEqual({
      kind: "failed",
      message: failure.message,
    });
    expect(h.logger.at("warn")[0].args).toContain(failure);
    expect(h.removed).toEqual(["/fake/probe"]);
  });

  test("composition-owned holders are independent and a shared injected probe spawns nothing on construction", () => {
    const first = createCoreDeviceProbeHolder();
    const second = createCoreDeviceProbeHolder();
    expect(first.get()).not.toBe(second.get());
    const h = harness();
    let constructions = 0;
    const holder = createCoreDeviceProbeHolder({
      factory: () => {
        constructions += 1;
        return createProductionCoreDeviceProbe({
          executor: h.executor,
          files: h.files,
          timer: h.timer,
          logger: h.logger,
        });
      },
    });
    expect(constructions).toBe(0);
    expect(holder.get()).toBe(holder.get());
    expect(constructions).toBe(1);
    const doctor = createIosDoctorDependencies({ coreDeviceProbe: holder.get() });
    const resource = createIosDoctorDependencies({ coreDeviceProbe: holder.get() });
    expect(doctor.getCoreDeviceProbe()).toBe(resource.getCoreDeviceProbe());
    const fresh = createIosDoctorDependencies();
    expect(fresh.getCoreDeviceProbe()).toBe(fresh.getCoreDeviceProbe());
    expect(fresh.getCoreDeviceProbe()).not.toBe(createIosDoctorDependencies().getCoreDeviceProbe());
    expect(h.calls).toHaveLength(0);
    expect(holder.get().getCachedVersion()).toBeUndefined();
  });
  test("doctor refresh seeds later booted capability calls and a failed refresh invalidates success", async () => {
    const h = harness("info-displays-booted-simulator");
    let failure = false;
    h.executor.executeCommand = async (_file, args = [], options) => {
      h.calls.push({ args, options });
      if (failure) {
        throw new Error("command not found");
      }
      const stdout = readFileSync(
        join(process.cwd(), "test/fixtures/ios-devicectl/version.txt"),
        "utf8",
      );
      return {
        stdout,
        stderr: "",
        toString: () => stdout,
        trim: () => stdout.trim(),
        includes: (value) => stdout.includes(value),
      };
    };
    const probe = createProductionCoreDeviceProbe({
      executor: h.executor,
      files: h.files,
      timer: h.timer,
      logger: h.logger,
      simctl: {
        getDeviceInfo: async () => null,
        listSimulatorImages: async () => [
          { name: "sim", platform: "ios", deviceId: "sim-1", state: "Booted" },
        ],
      },
    });
    const ios = {
      ...createIosDoctorDependencies({ coreDeviceProbe: probe }),
      platform: () => "darwin" as const,
      logger: h.logger,
      execFile: (
        file: string,
        args: string[],
        options?: { timeoutMs?: number; signal?: AbortSignal },
      ) => h.executor.executeCommand(file, args, options),
    };
    expect(await checkCoreDeviceVersion(ios)).toMatchObject({ status: "pass", value: "651.13.4" });
    expect(h.calls.map((call) => call.args)).toEqual([["devicectl", "--version"]]);
    expect(await probe.checkSimulatorCommand("sim-1", "info displays", [651, 0, 0])).toEqual({
      kind: "supported",
      output: capture("info-displays-booted-simulator"),
    });
    expect(h.calls.filter((call) => call.args.includes("--version"))).toHaveLength(1);
    failure = true;
    expect(await checkCoreDeviceVersion(ios)).toMatchObject({
      status: "warn",
      message: expect.stringContaining(
        "devicectl missing: devicectl not functional: command not found;",
      ),
    });
    expect(probe.getCachedVersion()).toMatchObject({ kind: "unavailable" });
    failure = false;
    expect(await checkCoreDeviceVersion(ios)).toMatchObject({ status: "pass", value: "651.13.4" });
    expect(h.calls.filter((call) => call.args.includes("--version"))).toHaveLength(3);
  });

  test("deadline aborts a hanging exec and never consumes its possible 1001 file", async () => {
    const h = harness();
    h.executor.executeCommand = async (_file, args = [], options) => {
      h.calls.push({ args, options });
      return new Promise(() => {});
    };
    const pending = h.invoker.invoke("sim-1", "info lockState");
    for (let turn = 0; turn < 8; turn += 1) {
      await Promise.resolve();
    }
    h.timer.advanceTime(5000);
    expect(await pending).toMatchObject({ kind: "failed", message: "devicectl probe timed out" });
    expect(h.calls[0].options?.signal?.aborted).toBe(true);
    expect(h.removed).toHaveLength(1);
  });

  test("the exec seam's timeout and missing utility are failures even if a file exists", async () => {
    const h = harness();
    for (const code of ["ETIMEDOUT", "ENOENT"]) {
      h.setFailure(Object.assign(new Error(code), { code }));
      expect((await h.invoker.invoke("sim-1", "info lockState")).kind).toBe("failed");
    }
  });

  test("version uses the same deadline seam; boot checks structurally precede all invocations", async () => {
    const h = harness();
    const events: string[] = [];
    let state = "Shutdown";
    h.executor.executeCommand = async (_file, args = [], options) => {
      events.push(args[1]);
      h.calls.push({ args, options });
      if (args[1] !== "--version") {
        throw new Error("exit 1");
      }
      const stdout = readFileSync(
        join(process.cwd(), "test/fixtures/ios-devicectl/version.txt"),
        "utf8",
      );
      return {
        stdout,
        stderr: "",
        toString: () => stdout,
        trim: () => stdout.trim(),
        includes: (value) => stdout.includes(value),
      };
    };
    const probe = createProductionCoreDeviceProbe({
      executor: h.executor,
      files: h.files,
      timer: h.timer,
      logger: h.logger,
      simctl: {
        getDeviceInfo: async () => null,
        listSimulatorImages: async (timeoutMs, options) => {
          events.push("boot");
          expect(timeoutMs).toBe(5000);
          expect(options?.bypassCache).toBe(true);
          return [{ name: "sim", platform: "ios", deviceId: "sim-1", state, deviceType: "nonDuo" }];
        },
      },
    });
    expect((await probe.checkSimulatorCommand("sim-1", "info lockState", [651, 0, 0])).kind).toBe(
      "notBooted",
    );
    expect(h.calls).toHaveLength(0);
    state = "Booted";
    await probe.checkSimulatorCommand("sim-1", "info lockState", [651, 0, 0]);
    expect(events).toEqual(["boot", "boot", "--version", "device"]);
    expect(h.calls.every((call) => call.options?.timeoutMs === 5000 && call.options.signal)).toBe(
      true,
    );
  });
});
