import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { serverConfig } from "../../src/utils/ServerConfig";
import {
  MAX_RUNNER_READINESS_TIMEOUT_MS,
  MIN_RUNNER_READINESS_TIMEOUT_MS,
} from "../../src/utils/runnerReadinessConfig";

describe("ServerConfig", () => {
  let previousToolOutputsDir: string | undefined;
  let previousDismissKeyboard: boolean;
  beforeEach(() => {
    previousToolOutputsDir = serverConfig.getToolOutputsDir();
    previousDismissKeyboard = serverConfig.isDismissKeyboardAfterInputEnabled();
  });
  afterEach(() => {
    serverConfig.setToolOutputsDir(previousToolOutputsDir);
    serverConfig.setDismissKeyboardAfterInputEnabled(previousDismissKeyboard);
  });
  describe("plan execution leases", () => {
    const releases: (() => void)[] = [];

    beforeEach(() => {
      serverConfig.setPlanExecutionActive(false);
    });

    afterEach(() => {
      for (const release of releases.splice(0)) {
        release();
      }
      serverConfig.setPlanExecutionActive(false);
    });

    const acquire = () => {
      const lease = serverConfig.acquirePlanExecutionLease();
      releases.push(() => lease.release());
      return lease;
    };

    test("a single lease keeps the guard active until released", () => {
      expect(serverConfig.isPlanExecutionActive()).toBe(false);
      const lease = acquire();
      expect(serverConfig.isPlanExecutionActive()).toBe(true);
      lease.release();
      expect(serverConfig.isPlanExecutionActive()).toBe(false);
    });

    test("releasing one of two leases keeps the other active", () => {
      const first = acquire();
      const second = acquire();
      first.release();
      expect(serverConfig.isPlanExecutionActive()).toBe(true);
      second.release();
      expect(serverConfig.isPlanExecutionActive()).toBe(false);
    });

    test("release is idempotent across active and later leases without underflow", () => {
      const first = acquire();
      const second = acquire();
      first.release();
      first.release();
      expect(serverConfig.isPlanExecutionActive()).toBe(true);
      second.release();
      second.release();
      expect(serverConfig.isPlanExecutionActive()).toBe(false);
      const later = acquire();
      first.release();
      expect(serverConfig.isPlanExecutionActive()).toBe(true);
      later.release();
      expect(serverConfig.isPlanExecutionActive()).toBe(false);
    });

    test("compatibility setter preserves boolean semantics for repeated calls", () => {
      serverConfig.setPlanExecutionActive(true);
      serverConfig.setPlanExecutionActive(true);
      expect(serverConfig.isPlanExecutionActive()).toBe(true);
      serverConfig.setPlanExecutionActive(false);
      serverConfig.setPlanExecutionActive(false);
      expect(serverConfig.isPlanExecutionActive()).toBe(false);
      serverConfig.setPlanExecutionActive(true);
      expect(serverConfig.isPlanExecutionActive()).toBe(true);
      serverConfig.setPlanExecutionActive(false);
      expect(serverConfig.isPlanExecutionActive()).toBe(false);
    });

    test("compatibility setter only releases its own lease", () => {
      const lease = acquire();
      serverConfig.setPlanExecutionActive(false);
      expect(serverConfig.isPlanExecutionActive()).toBe(true);
      serverConfig.setPlanExecutionActive(true);
      serverConfig.setPlanExecutionActive(true);
      serverConfig.setPlanExecutionActive(false);
      expect(serverConfig.isPlanExecutionActive()).toBe(true);
      serverConfig.setPlanExecutionActive(true);
      lease.release();
      expect(serverConfig.isPlanExecutionActive()).toBe(true);
      serverConfig.setPlanExecutionActive(false);
      expect(serverConfig.isPlanExecutionActive()).toBe(false);
    });
  });
  describe("tool output artifacts", () => {
    beforeEach(() => {
      serverConfig.setToolOutputsDir(undefined);
    });

    test("defaults to artifact mode disabled", () => {
      expect(serverConfig.getToolOutputsDir()).toBeUndefined();
      expect(serverConfig.isToolOutputArtifactModeEnabled()).toBe(false);
    });

    test("enables artifact mode when a directory is configured", () => {
      serverConfig.setToolOutputsDir("/tmp/auto-mobile-artifacts");

      expect(serverConfig.getToolOutputsDir()).toBe("/tmp/auto-mobile-artifacts");
      expect(serverConfig.isToolOutputArtifactModeEnabled()).toBe(true);
    });

    test("copies the configured directory value out of config", () => {
      const dir = "/tmp/auto-mobile-artifacts";
      serverConfig.setToolOutputsDir(dir);
      const configured = serverConfig.getToolOutputsDir();

      expect(configured).toBe(dir);
      serverConfig.setToolOutputsDir(undefined);
      expect(configured).toBe(dir);
    });
  });

  describe("dismissKeyboardAfterInput", () => {
    beforeEach(() => {
      serverConfig.setDismissKeyboardAfterInputEnabled(false);
    });

    test("defaults to false", () => {
      expect(serverConfig.isDismissKeyboardAfterInputEnabled()).toBe(false);
    });

    test("returns true after being enabled", () => {
      serverConfig.setDismissKeyboardAfterInputEnabled(true);
      expect(serverConfig.isDismissKeyboardAfterInputEnabled()).toBe(true);
    });

    test("can be toggled back to false", () => {
      serverConfig.setDismissKeyboardAfterInputEnabled(true);
      serverConfig.setDismissKeyboardAfterInputEnabled(false);
      expect(serverConfig.isDismissKeyboardAfterInputEnabled()).toBe(false);
    });
  });

  describe("runner readiness timeout", () => {
    test("accepts bounded values and rejects invalid programmatic options", () => {
      const original = serverConfig.getRunnerReadinessTimeoutMs();
      try {
        serverConfig.setRunnerReadinessTimeoutMs(MIN_RUNNER_READINESS_TIMEOUT_MS);
        expect(serverConfig.getRunnerReadinessTimeoutMs()).toBe(MIN_RUNNER_READINESS_TIMEOUT_MS);
        expect(() => serverConfig.setRunnerReadinessTimeoutMs(Number.NaN)).toThrow(RangeError);
        expect(() =>
          serverConfig.setRunnerReadinessTimeoutMs(MAX_RUNNER_READINESS_TIMEOUT_MS + 1),
        ).toThrow(RangeError);
      } finally {
        serverConfig.setRunnerReadinessTimeoutMs(original);
      }
    });
  });
});
