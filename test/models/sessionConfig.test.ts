import { describe, expect, test } from "bun:test";
import {
  assertSessionOwnerRunning,
  daemonSupportsSessionBroker,
  parseSessionConfigSource,
  resolveSessionConfig,
  SESSION_BROKER_V1_CAPABILITY,
} from "../../src/models/sessionConfig";

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
