import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { DeviceState } from "../../../../src/features/utility/DeviceState";
import {
  FakeIosCameraPosterDylibProvider,
  FakeIosCameraPosterRegistry,
} from "../../../fakes/FakeIosCameraPoster";
import { ActionableError } from "../../../../src/models/ActionableError";
import { FakeAdbClientFactory } from "../../../fakes/FakeAdbClientFactory";
import type { BootedDevice } from "../../../../src/models";

const simulator: BootedDevice = {
  platform: "ios",
  deviceId: "11111111-2222-3333-4444-555555555555",
  name: "iPhone",
};
const image = resolve("/posters/my poster.PNG");
const qr = resolve("/posters/qr.png");
function setup(device = simulator) {
  const registry = new FakeIosCameraPosterRegistry();
  const provider = new FakeIosCameraPosterDylibProvider();
  const adbFactory = new FakeAdbClientFactory();
  const texts: string[] = [];
  const state = new DeviceState(device, {
    iosCameraPosterRegistry: registry,
    iosCameraPosterDylibProvider: provider,
    adbFactory,
    cameraPosterFileExists: (path) => [image, qr].includes(path),
    cameraPosterQrWriter: {
      writePoster: async (text) => {
        texts.push(text);
        return qr;
      },
    },
  });
  return { state, registry, provider, texts, adbFactory };
}

test("simulator image accepts whitespace and echoes ignored surface without relaunching", async () => {
  const h = setup();
  const result = await h.state.setState({
    cameraPoster: { mode: "image", path: image, surface: "table" },
  });
  expect(result.success).toBe(true);
  expect(result.cameraPoster).toMatchObject({
    supported: true,
    method: "ios_simulator_dyld_injection",
    path: image,
    relaunchRequired: true,
    surface: "table",
  });
  expect(result.cameraPoster?.warning).toContain("next launchApp (cold launch) of each app");
  expect(h.registry.get(simulator.deviceId)).toEqual({ kind: "image", path: image });
  expect(h.adbFactory.getFakeClient().getAllCommands()).toEqual([]);
});

test("QR records generated PNG and original text; clear removes it", async () => {
  const h = setup();
  const result = await h.state.setState({ cameraPoster: { mode: "qr", text: "hello" } });
  expect(result.success).toBe(true);
  expect(result.cameraPoster?.path).toBe(qr);
  expect(h.texts).toEqual(["hello"]);
  expect(h.registry.get(simulator.deviceId)).toEqual({ kind: "qr", text: "hello", path: qr });
  const cleared = await h.state.setState({ cameraPoster: { mode: "clear" } });
  expect(cleared.cameraPoster).toMatchObject({
    supported: true,
    mode: "clear",
    relaunchRequired: true,
  });
  expect(cleared.cameraPoster?.path).toBeUndefined();
  expect(h.registry.get(simulator.deviceId)).toBeUndefined();
});

test.each([
  ["/invalid.gif", "PNG, JPG, or JPEG"],
  ["/missing.jpg", "does not exist"],
])("rejects invalid image %s without replacing registry", async (path, message) => {
  const h = setup();
  h.registry.set(simulator.deviceId, { kind: "image", path: image });
  const result = await h.state.setState({ cameraPoster: { mode: "image", path } });
  expect(result.success).toBe(false);
  expect(result.cameraPoster?.error).toContain(message);
  expect(h.registry.get(simulator.deviceId)?.path).toBe(image);
});

test("physical iOS returns typed unsupported before rendering or writing", async () => {
  const h = setup({ ...simulator, deviceId: "00008110-001A2B3C4D5E6F70" });
  const result = await h.state.setState({ cameraPoster: { mode: "qr", text: "hello" } });
  expect(result.success).toBe(false);
  expect(result.cameraPoster).toMatchObject({ supported: false });
  expect(result.error).toContain("unsupported on physical iOS devices");
  expect(h.texts).toEqual([]);
});

test("set preflights the dylib once; clear does not build it", async () => {
  const h = setup();
  await h.state.setState({ cameraPoster: { mode: "image", path: image } });
  expect(h.provider.calls).toBe(1);
  await h.state.setState({ cameraPoster: { mode: "clear" } });
  expect(h.provider.calls).toBe(1);
});

test("dylib preflight failure is reported at set time and keeps the previous poster", async () => {
  const h = setup();
  h.registry.set(simulator.deviceId, { kind: "qr", text: "old", path: qr });
  h.provider.error = new ActionableError("iOS camera poster source not found");
  const result = await h.state.setState({ cameraPoster: { mode: "image", path: image } });
  expect(result.success).toBe(false);
  expect(result.cameraPoster?.error).toContain("Camera poster not recorded");
  expect(result.cameraPoster?.error).toContain("source not found");
  expect(h.registry.get(simulator.deviceId)).toEqual({ kind: "qr", text: "old", path: qr });
});
