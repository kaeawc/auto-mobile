import { describe, expect, test } from "bun:test";
import {
  DeviceControlTransportError,
  type DeviceControlTransportFailure,
} from "../../src/daemon/deviceControlTransportFailure";
import { deviceControlTransportFailureResult } from "../../src/server/proxyServer";

describe("proxy server device-control transport errors", () => {
  test("returns safe machine-readable transport failure details", () => {
    const failure: DeviceControlTransportFailure = {
      code: "device_control_transport_failure",
      transport: "daemon_loopback_http",
      toolName: "launchApp",
      deviceId: "emulator-5554",
      deviceSessionUuid: "device-epoch-a",
      sessionUuid: "session-a",
      routingSessionUuid: "session-a",
      sessionValid: true,
      deviceSessionValid: true,
      phase: "response",
      retryable: false,
      reconnectAttempted: true,
      replayAttempted: false,
    };
    const unsafeFailure = {
      ...failure,
      endpoint: "https://secret.invalid?token=hidden",
    } as DeviceControlTransportFailure;
    const result = deviceControlTransportFailureResult(
      new DeviceControlTransportError(
        "Device-control transport closed while handling launchApp",
        unsafeFailure,
      ),
    );

    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: {
              message: "Device-control transport closed while handling launchApp",
              ...failure,
            },
          }),
        },
      ],
      isError: true,
    });
    expect(JSON.stringify(result)).not.toContain("secret.invalid");
  });
});
