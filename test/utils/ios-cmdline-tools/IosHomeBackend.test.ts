import { describe, expect, test } from "bun:test";
import type { ExecResult } from "../../../src/models";
import type { SimCtl } from "../../../src/utils/ios-cmdline-tools/SimCtlClient";
import {
  PhysicalIosHomeBackend,
  SimulatorIosHomeBackend,
  resolveIosHomeBackend,
  type IosHomeBackend,
} from "../../../src/utils/ios-cmdline-tools/IosHomeBackend";

const simulatorUdid = "A1B2C3D4-E5F6-7890-ABCD-EF1234567890";
const physicalUdid = "00008030-001C2D3E1234567A";

class FakeHomeSimctl implements Pick<SimCtl, "executeCommandArgs"> {
  readonly calls: Array<{ args: string[]; timeoutMs?: number; signal?: AbortSignal }> = [];
  error?: Error;

  async executeCommandArgs(
    args: string[],
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<ExecResult> {
    this.calls.push({ args, timeoutMs, signal });
    if (this.error) {
      throw this.error;
    }
    return {
      stdout: "",
      stderr: "",
      toString: () => "",
      trim: () => "",
      includes: () => false,
    };
  }
}

describe("resolveIosHomeBackend", () => {
  test("selects simulator transport and forwards exact SpringBoard argv and timeout", async () => {
    const simctl = new FakeHomeSimctl();
    const backend: IosHomeBackend = resolveIosHomeBackend(simulatorUdid, { simctl });

    expect(backend).toBeInstanceOf(SimulatorIosHomeBackend);
    expect(backend.kind).toBe("simulator");
    await backend.launchSpringboard({ timeoutMs: 731 });
    expect(simctl.calls).toEqual([
      {
        args: ["launch", simulatorUdid, "com.apple.springboard"],
        timeoutMs: 731,
        signal: undefined,
      },
    ]);
  });

  test.each([physicalUdid, "a".repeat(40), "unknown-device"])(
    "selects physical transport without simctl for %s",
    async (deviceId) => {
      const simctl = new FakeHomeSimctl();
      simctl.error = new Error("simctl must not run on physical devices");
      const backend = resolveIosHomeBackend(deviceId, { simctl });

      expect(backend).toBeInstanceOf(PhysicalIosHomeBackend);
      expect(backend.kind).toBe("physical");
      await backend.launchSpringboard({ timeoutMs: 1000 });
      expect(simctl.calls).toEqual([]);
    },
  );

  test("propagates the original simctl error unchanged", async () => {
    const simctl = new FakeHomeSimctl();
    const error = new Error("simctl launch failed");
    simctl.error = error;
    const backend = resolveIosHomeBackend(simulatorUdid, { simctl });

    await expect(backend.launchSpringboard({ timeoutMs: 1000 })).rejects.toBe(error);
    expect(simctl.calls).toHaveLength(1);
  });
});
