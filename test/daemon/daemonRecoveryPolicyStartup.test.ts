import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { DeviceSessionRepository } from "../../src/db/deviceSessionRepository";
import { Daemon } from "../../src/daemon/daemon";
import { DaemonState } from "../../src/daemon/daemonState";
import { logger } from "../../src/utils/logger";
import { FakeTimer } from "../fakes/FakeTimer";

describe("daemon device recovery policy startup", () => {
  afterEach(() => {
    if (DaemonState.getInstance().isInitialized()) {
      DaemonState.getInstance().reset();
    }
  });

  test("parses once, logs the effective policy, and warns before falling back", () => {
    const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
    const infoSpy = spyOn(logger, "info").mockImplementation(() => {});

    try {
      const daemon = new Daemon(
        {},
        undefined,
        new FakeTimer(),
        new DeviceSessionRepository(),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        {
          AUTOMOBILE_DEVICE_RECOVERY_ON_LOSS: "true",
          AUTOMOBILE_DEVICE_RECOVERY_MAX_ATTEMPTS: "999",
        },
      );

      expect(daemon.getDevicePool().getRecoveryPolicy()).toEqual({
        onLoss: false,
        maxAttempts: 2,
      });
      expect(warnSpy.mock.calls.map((call) => call[0])).toEqual(
        expect.arrayContaining([
          expect.stringContaining("Invalid AUTOMOBILE_DEVICE_RECOVERY_ON_LOSS"),
          expect.stringContaining("Invalid AUTOMOBILE_DEVICE_RECOVERY_MAX_ATTEMPTS"),
        ]),
      );
      expect(infoSpy.mock.calls.map((call) => call[0])).toContain(
        "[Daemon] Device recovery policy: onLoss=false, maxAttempts=2",
      );
    } finally {
      warnSpy.mockRestore();
      infoSpy.mockRestore();
    }
  });
});
