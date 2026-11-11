import { buildObserveResult } from "../helpers/observeFixture";
import { afterEach, expect, test } from "bun:test";
import { registerAppTools } from "../../src/server/appTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { ActionableError, type BootedDevice } from "../../src/models";
import type { LaunchAppCall } from "../../src/features/action/LaunchApp";
import {
  PrototypeAgentInjector,
  PrototypeAgentRegistry,
} from "../../src/features/prototype/ios/prototypeAgentInjection";
import {
  FakePrototypeAgentClient,
  FakePrototypeAgentDylibResolver,
  FakePrototypeAgentPorts,
} from "../fakes/FakePrototypeAgentInjection";
import {
  FakeIosCameraPosterRegistry,
  FakeIosCameraPosterDylibProvider,
} from "../fakes/FakeIosCameraPoster";
import { FakePrototypeViewerAttacher } from "../fakes/FakePrototypeViewerAttacher";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";
import { toolJson } from "../helpers/toolResponse";

isolateToolRegistry();
const simulator: BootedDevice = {
  platform: "ios",
  deviceId: "11111111-2222-3333-4444-555555555555",
  name: "iPhone",
};
const appId = "com.example.camera";
function setup() {
  const registry = new FakeIosCameraPosterRegistry();
  const provider = new FakeIosCameraPosterDylibProvider();
  const calls: LaunchAppCall[] = [];
  const timer = new FakeTimer();
  const ports = new FakePrototypeAgentPorts();
  const prototypeRegistry = new PrototypeAgentRegistry(ports);
  const prototypeProvider = new FakePrototypeAgentDylibResolver();
  registerAppTools({
    launchApp: {
      iosCameraPosterRegistry: registry,
      iosCameraPosterDylibProvider: provider,
      hostEnv: { SIMCTL_CHILD_DYLD_INSERT_LIBRARIES: "/existing.dylib" },
      timer,
      prearmNetwork: async () => {},
      prototypeAgentRegistry: prototypeRegistry,
      prototypeViewerAttacher: new FakePrototypeViewerAttacher(),
      createLaunchApp: () => ({
        execute: async (id, call) => {
          calls.push(call);
          return {
            success: true,
            packageName: id,
            observation: buildObserveResult({
              updatedAt: 0,
              screenSize: { width: 390, height: 844 },
              systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
              activeWindow: { appId: id, activityName: "Main", layoutSeqSum: 1 },
            }),
          };
        },
      }),
      createPrototypeAgentInjector: () =>
        new PrototypeAgentInjector({
          dylibResolver: prototypeProvider,
          ports,
          registry: prototypeRegistry,
          idGenerator: new FakeIdGenerator(),
          hostEnv: { SIMCTL_CHILD_DYLD_INSERT_LIBRARIES: "/existing.dylib" },
          connect: async () => new FakePrototypeAgentClient(),
        }),
    },
  });
  const launch = (device = simulator, prototype = false) =>
    ToolRegistry.getTool("launchApp")!.deviceAwareHandler!(device, { appId, prototype });
  return { registry, provider, calls, launch, ports, prototypeProvider, timer };
}
afterEach(() => ToolRegistry.clearTools());

test.each(["image", "qr"] as const)(
  "launch applies %s poster PNG, merges ambient DYLD and forces cold boot",
  async (kind) => {
    const h = setup();
    h.registry.set(
      simulator.deviceId,
      kind === "image" ? { kind, path: "/image.png" } : { kind, text: "hello", path: "/qr.png" },
    );
    const response = toolJson(await h.launch());
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.coldBoot).toBe(true);
    expect(h.calls[0]?.launchEnvironment).toEqual({
      SIMCTL_CHILD_DYLD_INSERT_LIBRARIES: `/existing.dylib:${h.provider.path}`,
      ...(kind === "image"
        ? { SIMCTL_CHILD_AM_CAMERA_POSTER_PATH: "/image.png" }
        : { SIMCTL_CHILD_AM_CAMERA_POSTER_QR: "hello" }),
    });
    expect(h.timer.getSleepHistory()).toEqual([]);
    expect(response.cameraPosterApplied).toBe(true);
    expect(response.message).toContain("camera poster applied");
  },
);

test("poster composes with prototype env without losing its library, port or token", async () => {
  const h = setup();
  h.registry.set(simulator.deviceId, { kind: "image", path: "/image.png" });
  await h.launch(simulator, true);
  expect(h.calls[0]?.coldBoot).toBe(true);
  expect(h.calls[0]?.launchEnvironment).toEqual({
    SIMCTL_CHILD_DYLD_INSERT_LIBRARIES: `/existing.dylib:${h.prototypeProvider.resolved.path}:${h.provider.path}`,
    SIMCTL_CHILD_AUTOMOBILE_PROTOTYPE_PORT: "8770",
    SIMCTL_CHILD_AUTOMOBILE_PROTOTYPE_TOKEN: "fake-1",
    SIMCTL_CHILD_AM_CAMERA_POSTER_PATH: "/image.png",
  });
});

test("provider failure is actionable, aborts prototype allocation and never launches", async () => {
  const h = setup();
  h.registry.set(simulator.deviceId, { kind: "image", path: "/image.png" });
  h.provider.error = new ActionableError("Install Xcode or set AUTOMOBILE_IOS_CAMERA_POSTER_DYLIB");
  await expect(h.launch(simulator, true)).rejects.toBeInstanceOf(ActionableError);
  expect(h.calls).toEqual([]);
  expect(h.ports.allocated.size).toBe(0);
});

test.each([
  simulator,
  { ...simulator, deviceId: "00008110-001A2B3C4D5E6F70" },
  { platform: "android", deviceId: "emulator-5554", name: "Pixel" },
] satisfies BootedDevice[])("no poster keeps launch unchanged for $deviceId", async (device) => {
  const h = setup();
  const response = toolJson(await h.launch(device));
  expect(h.provider.calls).toBe(0);
  expect(h.calls[0]?.coldBoot).toBe(false);
  expect(h.calls[0]?.launchEnvironment).toBeUndefined();
  expect(response.cameraPosterApplied).toBeUndefined();
});
