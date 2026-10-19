import { afterEach, describe, expect, it, spyOn } from "bun:test";
import {
  bootAdmissionServices,
  installBootAdmissionServices,
  type BootAdmissionServices,
} from "../../src/devices/bootAdmissionServices";
import { logger } from "../../src/utils/logger";

describe("bootAdmissionServices", () => {
  const original = installBootAdmissionServices(undefined);
  installBootAdmissionServices(original);
  afterEach(() => {
    installBootAdmissionServices(original);
  });

  it("is ungated until the composition root installs the real gates", async () => {
    installBootAdmissionServices(undefined);
    expect(bootAdmissionServices.androidColdBootAdmitter()).toBeUndefined();
    await bootAdmissionServices.assertBootCapacityAvailable("android");
    const result = await bootAdmissionServices
      .iosBootInstrumentation()
      .run({ udid: "U1", timeoutMs: 1234 }, async (remainingMs) => remainingMs);
    expect(result).toBe(1234);
  });

  it("warns once when an ungated boot runs outside NODE_ENV=test", async () => {
    installBootAdmissionServices(undefined);
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    const env = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const instrumentation = bootAdmissionServices.iosBootInstrumentation();
      await instrumentation.run({ udid: "U1", timeoutMs: 1 }, async () => 0);
      await instrumentation.run({ udid: "U2", timeoutMs: 1 }, async () => 0);
      const warned = warn.mock.calls.filter(([m]) => String(m).includes("boot admission gates"));
      expect(warned).toHaveLength(1);
    } finally {
      process.env.NODE_ENV = env;
      warn.mockRestore();
    }
  });

  it("delegates to the installed services on every call", async () => {
    const calls: string[] = [];
    const installed: BootAdmissionServices = {
      androidColdBootAdmitter: () => undefined,
      iosBootInstrumentation: () => ({ run: async (_r, boot) => boot(7) }),
      assertBootCapacityAvailable: async (platform) => {
        calls.push(platform);
      },
    };
    installBootAdmissionServices(installed);
    await bootAdmissionServices.assertBootCapacityAvailable("ios");
    expect(calls).toEqual(["ios"]);
  });
});
