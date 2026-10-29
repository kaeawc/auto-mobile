import { describe, expect, test } from "bun:test";
import {
  EMULATOR_GRPC_PORT_FIRST,
  EMULATOR_GRPC_PORT_LAST,
  hasEmulatorGrpcArgument,
} from "../../../../src/utils/android-cmdline-tools/emulatorGrpc/emulatorGrpcPorts";

describe("hasEmulatorGrpcArgument", () => {
  test("detects an explicit -grpc port in both spellings", () => {
    expect(hasEmulatorGrpcArgument(["-avd", "Pixel", "-grpc", "8561"])).toBe(true);
    expect(hasEmulatorGrpcArgument(["-avd", "Pixel", "-grpc=8561"])).toBe(true);
  });

  test("does not mistake -grpc-use-token or unrelated flags for a port", () => {
    expect(hasEmulatorGrpcArgument(["-avd", "Pixel", "-grpc-use-token"])).toBe(false);
    expect(hasEmulatorGrpcArgument(["-avd", "Pixel", "-no-window", "-port", "5554"])).toBe(false);
    expect(hasEmulatorGrpcArgument([])).toBe(false);
  });

  test("the candidate range starts at the emulator's own default and stays clear of console ports", () => {
    expect(EMULATOR_GRPC_PORT_FIRST).toBe(8554);
    expect(EMULATOR_GRPC_PORT_LAST).toBeGreaterThan(EMULATOR_GRPC_PORT_FIRST);
    // Console and ADB ports live in 5554-5683.
    expect(EMULATOR_GRPC_PORT_FIRST).toBeGreaterThan(5683);
  });
});
