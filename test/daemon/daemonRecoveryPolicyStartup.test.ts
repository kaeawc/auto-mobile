import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { DeviceSessionRepository } from "../../src/db/deviceSessionRepository";
import { Daemon } from "../../src/daemon/daemon";
import { DaemonState } from "../../src/daemon/daemonState";
import { logger } from "../../src/utils/logger";
import { FakeTimer } from "../fakes/FakeTimer";

describe("daemon device recovery policy startup", () => {
  const envNames = [
    "AUTOMOBILE_DEVICE_RECOVERY_ON_LOSS",
    "AUTOMOBILE_DEVICE_RECOVERY_MAX_ATTEMPTS",
  ] as const;
  const originalEnv = new Map(envNames.map(name => [name, process.env[name]]));

  afterEach(() => {
    for (const name of envNames) {
      const original = originalEnv.get(name);
      if (original === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = original;
      }
    }
    if (DaemonState.getInstance().isInitialized()) {
      DaemonState.getInstance().reset();
    }
  });

  test("parses once, logs the effective policy, and warns before falling back", () => {
    process.env.AUTOMOBILE_DEVICE_RECOVERY_ON_LOSS = "true";
    process.env.AUTOMOBILE_DEVICE_RECOVERY_MAX_ATTEMPTS = "999";
    const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
    const infoSpy = spyOn(logger, "info").mockImplementation(() => {});

    try {
      const daemon = new Daemon(
        {},
        undefined,
        new FakeTimer(),
        new DeviceSessionRepository(),
      );
      delete process.env.AUTOMOBILE_DEVICE_RECOVERY_ON_LOSS;
      process.env.AUTOMOBILE_DEVICE_RECOVERY_MAX_ATTEMPTS = "1";

      expect(daemon.getDevicePool().getRecoveryPolicy()).toEqual({
        onLoss: false,
        maxAttempts: 2,
      });
      expect(warnSpy.mock.calls.map(call => call[0])).toEqual(expect.arrayContaining([
        expect.stringContaining("Invalid AUTOMOBILE_DEVICE_RECOVERY_ON_LOSS"),
        expect.stringContaining("Invalid AUTOMOBILE_DEVICE_RECOVERY_MAX_ATTEMPTS"),
      ]));
      expect(infoSpy.mock.calls.map(call => call[0])).toContain(
        "[Daemon] Device recovery policy: onLoss=false, maxAttempts=2"
      );
    } finally {
      warnSpy.mockRestore();
      infoSpy.mockRestore();
    }
  });
});
