import { describe, expect, it } from "bun:test";
import { parseBootDeviceArgs } from "../../src/cli/bootDevice";

describe("daemon-free boot CLI", () => {
  it("accepts only boot concerns and leaves daemon/session concerns out", () => {
    expect(
      parseBootDeviceArgs([
        "--platform",
        "ios",
        "--device-id",
        "CI-UDID",
        "--timeout-ms",
        "300000",
      ]),
    ).toEqual({
      platform: "ios",
      deviceId: "CI-UDID",
      timeoutMs: 300000,
      preferRunning: true,
    });
  });

  it("rejects an unsupported option instead of silently passing it through", () => {
    expect(() => parseBootDeviceArgs(["--platform", "android", "--ensure-ctrl-proxy"])).toThrow(
      "Unknown boot-device argument",
    );
  });
});
