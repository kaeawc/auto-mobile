import { afterEach, expect, test } from "bun:test";
import { androidGrpcAudioCapabilities } from "../../../src/utils/audio/audioCapabilities";
import {
  EmulatorGrpcAudioState,
  emulatorGrpcAudioSnapshot,
  refreshEmulatorGrpcAudio,
  setEmulatorGrpcAudioStateForTesting,
} from "../../../src/utils/audio/emulatorGrpcAudioState";
import { capabilityInventory } from "../../../src/utils/deviceDescriptionProjection";
import type { EmulatorGrpcEndpoint } from "../../../src/utils/android-cmdline-tools/emulatorGrpc/emulatorGrpcDiscovery";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeEmulatorGrpcReachability } from "../../fakes/FakeEmulatorGrpcReachability";

const serial = "emulator-5554";
const endpoint: EmulatorGrpcEndpoint = {
  pid: 1,
  consolePort: 5554,
  address: "localhost:8554",
  auth: { kind: "none" },
  descriptionFile: "fake.ini",
};
const ids = ["android.emulator.audioInputInjection", "android.emulator.audioOutputCapture"];
function harness(found: EmulatorGrpcEndpoint | undefined = endpoint) {
  const ports: number[] = [];
  const reachability = new FakeEmulatorGrpcReachability();
  const timer = new FakeTimer();
  const state = new EmulatorGrpcAudioState(
    {
      findByConsolePort: async (port) => {
        ports.push(port);
        return found;
      },
    },
    reachability,
    timer,
  );
  return { state, ports, reachability, timer };
}
afterEach(() => setEmulatorGrpcAudioStateForTesting(undefined));

test("unprobed defaults and refresh in tests never access the host", async () => {
  expect(emulatorGrpcAudioSnapshot(serial)).toBeUndefined();
  await refreshEmulatorGrpcAudio(serial);
  expect(emulatorGrpcAudioSnapshot(serial)).toBeUndefined();
  expect(androidGrpcAudioCapabilities(undefined)).toEqual([]);
});
test("refresh is single flight, maps console port and respects TTL", async () => {
  const h = harness();
  expect(h.state.snapshot(serial)).toBeUndefined();
  await Promise.all([h.state.refresh(serial), h.state.refresh(serial)]);
  expect(h.ports).toEqual([5554]);
  expect(h.reachability.calls).toEqual([{ address: endpoint.address, deadlineMs: 500 }]);
  expect(androidGrpcAudioCapabilities(h.state.snapshot(serial))).toEqual(
    ids.map((id) => ({ id, state: "available", source: "platform" })),
  );
  await h.state.refresh(serial);
  expect(h.ports).toHaveLength(1);
  h.timer.advanceTime(30_000);
  h.reachability.result = { state: "unreachable", reason: "Connection refused." };
  await h.state.refresh(serial);
  expect(h.ports).toHaveLength(2);
  expect(androidGrpcAudioCapabilities(h.state.snapshot(serial))).toEqual(
    ids.map((id) => ({
      id,
      state: "unavailable",
      source: "platform",
      reason: "Connection refused.",
    })),
  );
});
test("missing endpoint is unsupported with a reason", async () => {
  const h = harness();
  const state = new EmulatorGrpcAudioState(
    { findByConsolePort: async () => undefined },
    h.reachability,
    h.timer,
  );
  await state.refresh(serial);
  expect(h.reachability.calls).toHaveLength(0);
  expect(androidGrpcAudioCapabilities(state.snapshot(serial))).toEqual(
    ids.map((id) => ({
      id,
      state: "unsupported",
      source: "platform",
      reason: "No emulator gRPC endpoint is advertised for emulator-5554.",
    })),
  );
});
test("discovery failure returns a typed failure", async () => {
  const h = harness();
  const state = new EmulatorGrpcAudioState(
    {
      findByConsolePort: async () => {
        throw new Error("discovery failed");
      },
    },
    h.reachability,
    h.timer,
  );
  await state.refresh(serial);
  expect(state.snapshot(serial)).toEqual({
    state: "unreachable",
    reason: expect.stringContaining("discovery failed"),
  });
});
test("projection adds runtime entries without changing the AVD inventory or physical devices", async () => {
  const h = harness();
  setEmulatorGrpcAudioStateForTesting(h.state);
  const device = {
    name: "test",
    platform: "android" as const,
    deviceId: serial,
    isRunning: true,
    capabilityInventory: { schemaVersion: 1 as const, capabilities: [] },
  };
  expect(capabilityInventory(device, true)?.capabilities).toEqual([]);
  await refreshEmulatorGrpcAudio(serial);
  expect(capabilityInventory(device, true)?.capabilities).toEqual(
    ids.map((id) => ({ id, state: "supported", source: "platform", reason: null })),
  );
  expect(device.capabilityInventory.capabilities).toEqual([]);
  expect(capabilityInventory({ ...device, deviceId: "usb-123" }, true)?.capabilities).toEqual([]);
  expect(capabilityInventory(device, false)?.capabilities).toEqual([]);
  expect(
    capabilityInventory(
      { name: "bare", platform: "android", deviceId: serial, isRunning: true },
      true,
    )?.capabilities,
  ).toHaveLength(2);
});

test("discovery deadline yields a typed failure and permits later refresh", async () => {
  const h = harness();
  const state = new EmulatorGrpcAudioState(
    { findByConsolePort: () => new Promise(() => {}) },
    h.reachability,
    h.timer,
  );
  const pending = state.refresh(serial);
  await Promise.resolve();
  h.timer.advanceTime(500);
  await pending;
  expect(state.snapshot(serial)).toEqual({
    state: "unreachable",
    reason: expect.stringContaining("timed out after 500ms"),
  });
  expect(h.timer.getPendingTimeoutCount()).toBe(0);
});

test("non-emulator refresh never calls discovery", async () => {
  const h = harness();
  await h.state.refresh("usb-123");
  expect(h.ports).toEqual([]);
  expect(h.state.snapshot("usb-123")).toBeUndefined();
});

test("scanner listing starts a background refresh without waiting for the endpoint", async () => {
  const { DefaultAndroidDeviceInventoryScanner } =
    await import("../../../src/utils/android-cmdline-tools/AndroidDeviceInventoryScanner");
  const { FakeAdbClient } = await import("../../fakes/FakeAdbClient");
  const { FakeAdbClientFactory } = await import("../../fakes/FakeAdbClientFactory");
  const h = harness();
  let finish: ((value: { state: "reachable" }) => void) | undefined;
  h.reachability.pending = new Promise((resolve) => {
    finish = resolve;
  });
  setEmulatorGrpcAudioStateForTesting(h.state);
  const adb = new FakeAdbClient();
  const scanner = new DefaultAndroidDeviceInventoryScanner({
    timer: () => h.timer,
    adbFactory: () => new FakeAdbClientFactory(adb),
    observationSequence: () => ({ next: () => 1 }),
    avdConfigReader: () => ({ readConfig: async () => null }),
    getRunningAvdName: async () => ({ name: "test" }),
    isUnknownEmulatorName: () => false,
    unknownEmulatorName: () => "Unknown",
    throwIfAborted: () => {},
  });
  const devices = [{ name: "test", platform: "android" as const, deviceId: serial }];
  await scanner.getBootedDevicesWithDiagnostics(false, {
    devices,
    readinessOnly: true,
    skipNameEnrichment: true,
  });
  expect(h.ports).toEqual([]);
  const result = await scanner.getBootedDevicesWithDiagnostics(false, {
    devices,
    readinessOnly: true,
  });
  expect(result.devices).toHaveLength(1);
  expect(h.ports).toEqual([5554]);
  expect(h.state.snapshot(serial)).toBeUndefined();
  finish?.({ state: "reachable" });
  await h.state.refresh(serial);
  expect(h.state.snapshot(serial)).toEqual({ state: "reachable" });
});
