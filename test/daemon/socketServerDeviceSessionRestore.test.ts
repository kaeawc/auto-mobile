import { afterEach, expect, test } from "bun:test";
import { DaemonState } from "../../src/daemon/daemonState";
import { UnixSocketServer } from "../../src/daemon/socketServer";
import { DeviceControlTransportError } from "../../src/daemon/deviceControlTransportFailure";
import { DefaultDeviceIncarnationInvalidator } from "../../src/server/DeviceIncarnationInvalidator";
import type { DaemonRequest } from "../../src/daemon/types";
import { FakeTimer } from "../fakes/FakeTimer";
import { createDeviceRestoreEpochHarness } from "../helpers/deviceRestoreEpochHarness";

afterEach(() => DaemonState.getInstance().reset());

test("device-control replay refuses a restore-retired epoch with actionable transport error", async () => {
  const timer = new FakeTimer();
  const device = { deviceId: "emulator-5554", name: "Pixel", platform: "android" as const };
  await createDeviceRestoreEpochHarness(device, timer);
  const server = new UnixSocketServer(
    "/fake/restore.sock",
    "http://localhost:0/mcp",
    DaemonState.getInstance(),
    timer,
  );
  const access = server as unknown as {
    isDeviceControlDeviceSessionValid(identity: {
      deviceId: string;
      deviceSessionUuid: string;
    }): boolean;
    deviceControlTransportError(input: {
      request: DaemonRequest;
      identity: { deviceId: string; deviceSessionUuid: string };
      phase: "response";
      reconnectAttempted: boolean;
      replayAttempted: boolean;
      recoveryExhausted: boolean;
    }): DeviceControlTransportError;
  };
  const identity = { deviceId: device.deviceId, deviceSessionUuid: "epoch-old" };
  expect(access.isDeviceControlDeviceSessionValid(identity)).toBe(true);
  await new DefaultDeviceIncarnationInvalidator([]).invalidate(device);
  expect(access.isDeviceControlDeviceSessionValid(identity)).toBe(false);
  const error = access.deviceControlTransportError({
    request: {
      id: "restore",
      type: "mcp_request",
      method: "tools/call",
      params: { name: "observe", arguments: {} },
    },
    identity,
    phase: "response",
    reconnectAttempted: true,
    replayAttempted: false,
    recoveryExhausted: false,
  });
  expect(error).toBeInstanceOf(DeviceControlTransportError);
  expect(error.failure).toMatchObject({ deviceSessionValid: false, retryable: false });
  expect(error.message).toContain("snapshot restore");
  expect(error.message).toContain("deviceSnapshot");
});
