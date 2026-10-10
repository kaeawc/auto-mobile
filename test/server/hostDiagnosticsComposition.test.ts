import { isolateToolRegistry } from "../helpers/withTemporaryTool";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { beforeAll, expect, spyOn, test } from "bun:test";
import { createMcpServer } from "../../src/server/index";
import * as doctorTools from "../../src/server/doctorTools";
import { runDoctor } from "../../src/doctor";
import * as iosChecks from "../../src/doctor/checks/ios";
import * as systemChecks from "../../src/doctor/checks/system";
import * as autoMobileChecks from "../../src/doctor/checks/automobile";
import { ToolRegistry } from "../../src/server/toolRegistry";
import * as resources from "../../src/server/hostToolchainResources";
import {
  createIosDoctorDependencies,
  type IosDoctorDependencies,
} from "../../src/doctor/checks/ios";
import { createProductionCoreDeviceProbe } from "../../src/utils/ios-cmdline-tools/CoreDeviceProbeHolder";
import { FakeHostCommandExecutor } from "../fakes/FakeHostCommandExecutor";
import { FakeTimer } from "../fakes/FakeTimer";

isolateToolRegistry();

beforeAll(async () => {
  // Pay cold schema/SDK initialization outside the per-test timing budget.
  const executor = new FakeHostCommandExecutor();
  const probe = createProductionCoreDeviceProbe({ executor, timer: new FakeTimer() });
  const ios = createIosDoctorDependencies({ coreDeviceProbe: probe });
  const resourceRegistration = spyOn(
    resources,
    "registerHostToolchainResources",
  ).mockImplementation(() => {});
  PlatformDeviceManagerFactory.setInstance(new FakeDeviceManager());
  try {
    const previousDoctor = ToolRegistry.getTool("doctor");
    const server = createMcpServer({ iosDependencies: ios });
    await server.close();
    expect(ToolRegistry.getTool("doctor")).toBe(previousDoctor);
    expect(executor.getExecutedCommands()).toEqual([]);
  } finally {
    PlatformDeviceManagerFactory.reset();
    resourceRegistration.mockRestore();
  }
});

test("server composition injects the resource probe without adding a doctor tool or spawning", async () => {
  const executor = new FakeHostCommandExecutor();
  const probe = createProductionCoreDeviceProbe({ executor, timer: new FakeTimer() });
  const ios = createIosDoctorDependencies({ coreDeviceProbe: probe });
  let resource: IosDoctorDependencies | undefined;
  const resourceRegistration = spyOn(
    resources,
    "registerHostToolchainResources",
  ).mockImplementation((options) => {
    resource = options?.iosDependencies;
  });
  PlatformDeviceManagerFactory.setInstance(new FakeDeviceManager());
  try {
    // Other files may have registered the CLI tool in this singleton already.
    // getTool includes hidden callable tools, unlike discovery-only accessors.
    const previousDoctor = ToolRegistry.getTool("doctor");
    const server = createMcpServer({ iosDependencies: ios });
    expect(ToolRegistry.getTool("doctor")).toBe(previousDoctor);
    expect(resource).toBe(ios);
    expect(resource?.getCoreDeviceProbe()).toBe(probe);
    expect(executor.getExecutedCommands()).toEqual([]);
    await server.close();
  } finally {
    PlatformDeviceManagerFactory.reset();
    resourceRegistration.mockRestore();
  }
});

test("runDoctor and the CLI doctor tool pass injected iOS dependencies to the checks", async () => {
  const executor = new FakeHostCommandExecutor();
  const probe = createProductionCoreDeviceProbe({ executor, timer: new FakeTimer() });
  const ios = createIosDoctorDependencies({ coreDeviceProbe: probe });
  const checks = spyOn(iosChecks, "runIosChecks").mockResolvedValue([]);
  const system = spyOn(systemChecks, "runSystemChecks").mockReturnValue([]);
  const autoMobile = spyOn(autoMobileChecks, "runAutoMobileChecks").mockResolvedValue([]);
  let handler: Parameters<typeof ToolRegistry.register>[3] | undefined;
  const registration = spyOn(ToolRegistry, "register").mockImplementation(
    (_name, _description, _schema, registeredHandler) => {
      handler = registeredHandler;
    },
  );
  try {
    await runDoctor({ ios: true }, { iosDependencies: ios });
    expect(checks.mock.calls[0]?.[1]).toBe(ios);

    doctorTools.registerDoctorTools({ iosDependencies: ios });
    expect(registration).toHaveBeenCalledWith(
      "doctor",
      "Run AutoMobile setup diagnostics",
      doctorTools.doctorSchema,
      expect.any(Function),
      { defaultEnabled: true, readOnly: true },
    );
    expect(handler).toBeDefined();
    await handler!({ ios: true });
    expect(checks.mock.calls[1]?.[1]).toBe(ios);
    expect(checks).toHaveBeenCalledTimes(2);
    expect(ios.getCoreDeviceProbe()).toBe(probe);
    expect(executor.getExecutedCommands()).toEqual([]);
  } finally {
    registration.mockRestore();
    checks.mockRestore();
    system.mockRestore();
    autoMobile.mockRestore();
  }
});
