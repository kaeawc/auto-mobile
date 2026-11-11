import { expect, test } from "bun:test";
import pngReport from "../../../../ios/CameraPosterInjection/fixtures/report-injected-png-ios18.6.json";
import qrReport from "../../../../ios/CameraPosterInjection/fixtures/report-injected-qr-ios26.5.json";
import {
  cameraPosterLaunchSkip,
  prepareCameraPosterLaunch,
} from "../../../../src/features/utility/ios/iosCameraPosterLaunch";
import {
  FakeIosCameraPosterRegistry,
  FakeIosCameraPosterDylibProvider,
} from "../../../fakes/FakeIosCameraPoster";

// The captures are app reports, not environment dumps. This asserts the documented injection
// setup that produces those reports; it does not claim the fake launch reverified AVFoundation.
test.each([
  ["image", pngReport],
  ["qr", qrReport],
] as const)(
  "captured %s fixture setup uses the documented path env for both poster modes",
  async (kind, report) => {
    expect(report.complete).toBe(true);
    expect(report.previewLayerHasContent).toBe(true);
    const registry = new FakeIosCameraPosterRegistry();
    const provider = new FakeIosCameraPosterDylibProvider();
    const device = {
      platform: "ios",
      deviceId: "11111111-2222-3333-4444-555555555555",
      name: "Fixture",
    } as const;
    registry.set(
      device.deviceId,
      kind === "image"
        ? { kind, path: "/fixture/poster.png" }
        : { kind, text: "fixture", path: "/fixture/generated-qr.png" },
    );
    expect(await prepareCameraPosterLaunch(device, { registry, provider, hostEnv: {} })).toEqual({
      SIMCTL_CHILD_DYLD_INSERT_LIBRARIES: "/camera/libAMCameraPoster.dylib",
      ...(kind === "image"
        ? {
            SIMCTL_CHILD_AM_CAMERA_POSTER_PATH: "/fixture/poster.png",
            SIMCTL_CHILD_AM_CAMERA_POSTER_QR: "",
          }
        : { SIMCTL_CHILD_AM_CAMERA_POSTER_QR: "fixture", SIMCTL_CHILD_AM_CAMERA_POSTER_PATH: "" }),
    });
  },
);

test("existing DYLD entries do not duplicate the poster dylib", async () => {
  const registry = new FakeIosCameraPosterRegistry();
  const provider = new FakeIosCameraPosterDylibProvider();
  const device = {
    platform: "ios",
    deviceId: "11111111-2222-3333-4444-555555555555",
    name: "Fixture",
  } as const;
  registry.set(device.deviceId, { kind: "image", path: "/poster.png" });
  const env = await prepareCameraPosterLaunch(device, {
    registry,
    provider,
    hostEnv: { SIMCTL_CHILD_DYLD_INSERT_LIBRARIES: provider.path },
  });
  expect(env?.SIMCTL_CHILD_DYLD_INSERT_LIBRARIES).toBe(provider.path);
});

test("each poster mode clears the other mode's variable inherited from the host", async () => {
  const registry = new FakeIosCameraPosterRegistry();
  const provider = new FakeIosCameraPosterDylibProvider();
  const device = {
    platform: "ios",
    deviceId: "11111111-2222-3333-4444-555555555555",
    name: "Fixture",
  } as const;
  const hostEnv = {
    SIMCTL_CHILD_AM_CAMERA_POSTER_PATH: "/stale/poster.png",
    SIMCTL_CHILD_AM_CAMERA_POSTER_QR: "stale",
  };
  registry.set(device.deviceId, { kind: "qr", text: "fresh", path: "/generated-qr.png" });
  const qrEnv = await prepareCameraPosterLaunch(device, { registry, provider, hostEnv });
  // simctl receives these entries layered over the inherited host environment.
  expect({ ...hostEnv, ...qrEnv }).toMatchObject({
    SIMCTL_CHILD_AM_CAMERA_POSTER_QR: "fresh",
    SIMCTL_CHILD_AM_CAMERA_POSTER_PATH: "",
  });
  registry.set(device.deviceId, { kind: "image", path: "/fresh.png" });
  const imageEnv = await prepareCameraPosterLaunch(device, { registry, provider, hostEnv });
  expect({ ...hostEnv, ...imageEnv }).toMatchObject({
    SIMCTL_CHILD_AM_CAMERA_POSTER_PATH: "/fresh.png",
    SIMCTL_CHILD_AM_CAMERA_POSTER_QR: "",
  });
});

test("Apple system apps launch without the poster and never build the dylib", async () => {
  const registry = new FakeIosCameraPosterRegistry();
  const provider = new FakeIosCameraPosterDylibProvider();
  const device = {
    platform: "ios",
    deviceId: "11111111-2222-3333-4444-555555555555",
    name: "Fixture",
  } as const;
  registry.set(device.deviceId, { kind: "image", path: "/poster.png" });
  const deps = { registry, provider, hostEnv: {} };
  expect(
    await prepareCameraPosterLaunch(device, deps, undefined, "com.apple.Preferences"),
  ).toBeUndefined();
  expect(provider.calls).toBe(0);
  expect(cameraPosterLaunchSkip(device, registry, "com.apple.Preferences")).toContain(
    "com.apple.*",
  );
  expect(cameraPosterLaunchSkip(device, registry, "com.example.app")).toBeUndefined();
  expect(await prepareCameraPosterLaunch(device, deps, undefined, "com.example.app")).toBeDefined();
  registry.clear(device.deviceId);
  expect(cameraPosterLaunchSkip(device, registry, "com.apple.Preferences")).toBeUndefined();
});
