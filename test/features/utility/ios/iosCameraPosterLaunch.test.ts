import { expect, test } from "bun:test";
import pngReport from "../../../../ios/CameraPosterInjection/fixtures/report-injected-png-ios18.6.json";
import qrReport from "../../../../ios/CameraPosterInjection/fixtures/report-injected-qr-ios26.5.json";
import { prepareCameraPosterLaunch } from "../../../../src/features/utility/ios/iosCameraPosterLaunch";
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
        ? { SIMCTL_CHILD_AM_CAMERA_POSTER_PATH: "/fixture/poster.png" }
        : { SIMCTL_CHILD_AM_CAMERA_POSTER_QR: "fixture" }),
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
