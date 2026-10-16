import { describe, expect, spyOn, test } from "bun:test";
import * as sessionConfig from "../../src/devices/sessionConfig";
import {
  assertSessionOwnerRunning,
  daemonSupportsSessionBroker,
  parseSessionConfig,
  parseSessionConfigSource,
  resolveSessionConfig,
  SESSION_BROKER_V1_CAPABILITY,
  SessionConfigError,
} from "../../src/devices/sessionConfig";
import { logger } from "../../src/utils/logger";
import { FakeLockOwnerGenerationProbe } from "../fakes/FakeLockOwnerGenerationProbe";

const config = {
  contractVersion: 1,
  requestId: "request-1",
  device: {
    schemaVersion: 1,
    platform: "android",
    hardware: { kind: "omitted" },
    os: { kind: "major", major: 35 },
  },
  executionOwnerPid: 4242,
};

describe("session config launch resolution", () => {
  test("reads inline JSON or a path and gives the flag precedence", () => {
    expect(parseSessionConfigSource(JSON.stringify(config), () => "").requestId).toBe("request-1");
    expect(
      resolveSessionConfig({
        flagValue: "/session.json",
        envValue: JSON.stringify({ ...config, requestId: "environment" }),
        readFile: () => JSON.stringify({ ...config, requestId: "file" }),
      })?.requestId,
    ).toBe("file");
  });

  test("rejects incompatible launch bindings before reading a file", () => {
    let reads = 0;
    expect(() =>
      resolveSessionConfig({
        flagValue: "/session.json",
        readFile: () => {
          reads++;
          return JSON.stringify(config);
        },
        hasManagedSlotConfig: true,
      }),
    ).toThrow("session_config_invalid");
    expect(reads).toBe(0);
  });

  test("does not expose malformed inline JSON", () => {
    expect(() => parseSessionConfigSource('{"secret":"do-not-print" oops}', () => "")).toThrow(
      /^session_config_invalid:(?!.*do-not-print)/,
    );
  });

  test("validates the execution owner and capability token", () => {
    expect(() => assertSessionOwnerRunning(config, () => false)).toThrow(
      "executionOwnerPid 4242 is not a running process",
    );
    expect(daemonSupportsSessionBroker([SESSION_BROKER_V1_CAPABILITY])).toBe(true);
    expect(daemonSupportsSessionBroker([])).toBe(false);
  });
});

function ownerRig() {
  const processes = new Map([[4242, "T1"]]);
  const probe = new FakeLockOwnerGenerationProbe();
  probe.onCurrent = (pid) => {
    probe.token = processes.get(pid);
  };
  probe.onCompare = (pid, recorded) => (processes.get(pid) === recorded ? "same" : "different");
  return {
    processes,
    probe,
    isProcessRunning: (pid: number) => processes.has(pid),
    owner: { ...parseSessionConfig(config), executionOwnerStartIdentity: "T1" },
  };
}

describe("session execution owner start identity", () => {
  test("accepts an identity with its PID and enforces the managed-slot length limits", () => {
    expect(
      parseSessionConfig({ ...config, executionOwnerStartIdentity: "T1" })
        .executionOwnerStartIdentity,
    ).toBe("T1");
    for (const identity of ["", "x".repeat(257)]) {
      expect(() =>
        parseSessionConfig({ ...config, executionOwnerStartIdentity: identity }),
      ).toThrow(SessionConfigError);
    }
    expect(
      parseSessionConfig({ ...config, executionOwnerStartIdentity: "x".repeat(256) })
        .executionOwnerStartIdentity,
    ).toHaveLength(256);
  });

  test("rejects identity without a PID with the session config error", () => {
    const { executionOwnerPid: _pid, ...withoutPid } = config;
    void _pid;
    const parse = () => parseSessionConfig({ ...withoutPid, executionOwnerStartIdentity: "T1" });
    expect(parse).toThrow(SessionConfigError);
    expect(parse).toThrow("executionOwnerStartIdentity requires executionOwnerPid");
  });

  test("treats a running but reused PID as a gone owner before capturing its generation", () => {
    const rig = ownerRig();
    rig.processes.set(4242, "T2");
    const resolve = () => sessionConfig.resolveSessionOwnerGenerationToken(rig.owner, rig);
    expect(resolve).toThrow(SessionConfigError);
    expect(resolve).toThrow("executionOwnerPid 4242");
    expect(resolve).toThrow("the PID was reused");
    const assertIdentity = () =>
      sessionConfig.assertSessionOwnerIdentity(rig.owner, (pid, recorded) =>
        rig.probe.compare(pid, recorded),
      );
    expect(assertIdentity).toThrow(SessionConfigError);
    expect(assertIdentity).toThrow("the PID was reused");
    expect(rig.probe.currentCalls).toEqual([]);
  });

  test("uses the recorded identity when the process start matches", () => {
    const rig = ownerRig();
    expect(sessionConfig.resolveSessionOwnerGenerationToken(rig.owner, rig)).toBe("T1");
    expect(rig.probe.compareCalls).toEqual([{ pid: 4242, recorded: "T1" }]);
    expect(rig.probe.currentCalls).toEqual([]);
    expect(
      sessionConfig.assertSessionOwnerIdentity(rig.owner, (pid, recorded) =>
        rig.probe.compare(pid, recorded),
      ),
    ).toBe("same");
  });

  test("warns and trusts the PID's current token when comparison is unknown", () => {
    const rig = ownerRig();
    rig.processes.set(4242, "T2");
    rig.probe.onCompare = () => "unknown";
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      expect(sessionConfig.resolveSessionOwnerGenerationToken(rig.owner, rig)).toBe("T2");
      expect(rig.probe.currentCalls).toEqual([4242]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toContain("trusting the PID alone");
    } finally {
      warn.mockRestore();
    }
  });

  test("logs a throwing comparison and trusts the PID's current token", () => {
    const rig = ownerRig();
    rig.processes.set(4242, "T2");
    const error = new Error("identity unreadable");
    rig.probe.compareError = error;
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      expect(sessionConfig.resolveSessionOwnerGenerationToken(rig.owner, rig)).toBe("T2");
      expect(rig.probe.currentCalls).toEqual([4242]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toContain("trusting the PID alone");
      expect(warn.mock.calls[0]?.[1]).toBe(error);
    } finally {
      warn.mockRestore();
    }
  });

  test("captures the current token without a recorded identity", () => {
    const rig = ownerRig();
    expect(sessionConfig.resolveSessionOwnerGenerationToken(parseSessionConfig(config), rig)).toBe(
      "T1",
    );
    expect(rig.probe.compareCalls).toEqual([]);
    expect(rig.probe.currentCalls).toEqual([4242]);
    expect(
      sessionConfig.assertSessionOwnerIdentity(parseSessionConfig(config), (pid, recorded) =>
        rig.probe.compare(pid, recorded),
      ),
    ).toBeUndefined();
  });

  test("skips the process probes without a PID or config", () => {
    const rig = ownerRig();
    const { executionOwnerPid: _pid, ...withoutPid } = parseSessionConfig(config);
    void _pid;
    expect(sessionConfig.resolveSessionOwnerGenerationToken(withoutPid, rig)).toBeUndefined();
    expect(sessionConfig.resolveSessionOwnerGenerationToken(undefined, rig)).toBeUndefined();
    expect(
      sessionConfig.assertSessionOwnerIdentity(withoutPid, (pid, recorded) =>
        rig.probe.compare(pid, recorded),
      ),
    ).toBeUndefined();
    expect(
      sessionConfig.assertSessionOwnerIdentity(undefined, (pid, recorded) =>
        rig.probe.compare(pid, recorded),
      ),
    ).toBeUndefined();
    expect(rig.probe.compareCalls).toEqual([]);
    expect(rig.probe.currentCalls).toEqual([]);
  });

  test("rejects a stopped PID with the existing message before comparing identity", () => {
    const rig = ownerRig();
    rig.processes.delete(4242);
    const resolve = () => sessionConfig.resolveSessionOwnerGenerationToken(rig.owner, rig);
    expect(resolve).toThrow(SessionConfigError);
    expect(resolve).toThrow("executionOwnerPid 4242 is not a running process");
    expect(rig.probe.compareCalls).toEqual([]);
    expect(rig.probe.currentCalls).toEqual([]);
  });
});
