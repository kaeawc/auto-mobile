import { describe, expect, test } from "bun:test";
import { parseArgs } from "../../src/cli/parseArgs";

const logger = { warn: () => {} };

describe("parseArgs (#4277)", () => {
  test("parses CLI feature flags without loading the server entrypoint", () => {
    const parsed = parseArgs(["--cli", "listApps", "--embedded-sdk", "--network-mockable"], logger);

    expect(parsed.cliMode).toBe(true);
    expect(parsed.embeddedSdk).toBe(true);
    expect(parsed.networkMockable).toBe(true);
  });

  test("defaults CLI feature flags to false when omitted", () => {
    const parsed = parseArgs([], logger);

    expect(parsed.cliMode).toBe(false);
    expect(parsed.embeddedSdk).toBe(false);
    expect(parsed.networkMockable).toBe(false);
  });

  test("parses an initial device-session binding for proxy mode", () => {
    const parsed = parseArgs(["--initial-session-uuid", "device-session-a"], logger);

    expect(parsed.initialSessionUuid).toBe("device-session-a");
  });

  test("uses the runner readiness environment default and lets CLI override it", () => {
    const fromEnvironment = parseArgs([], logger, {
      AUTOMOBILE_RUNNER_READINESS_TIMEOUT_MS: "20000",
    });
    const fromCli = parseArgs(["--runner-readiness-timeout-ms", "45000"], logger, {
      AUTOMOBILE_RUNNER_READINESS_TIMEOUT_MS: "20000",
    });

    expect(fromEnvironment.runnerReadinessTimeoutMs).toBe(20_000);
    expect(fromCli.runnerReadinessTimeoutMs).toBe(45_000);
  });

  test("leaves runner readiness unset when a bare client has no override", () => {
    const parsed = parseArgs([], logger, {});

    expect(parsed.runnerReadinessTimeoutMs).toBeUndefined();
  });

  test("parses repeatable exact-tool startup defaults", () => {
    const parsed = parseArgs(
      ["--enable-tool", "clipboard", "--enable-tool", "sqlQuery", "--disable-tool", "observe"],
      logger,
      {},
    );

    expect(parsed.enabledTools).toEqual(["clipboard", "sqlQuery"]);
    expect(parsed.disabledTools).toEqual(["observe"]);
  });

  test("rejects conflicting tool defaults and retired environment variables", () => {
    expect(() =>
      parseArgs(["--enable-tool", "clipboard", "--disable-tool", "clipboard"], logger, {}),
    ).toThrow("both enabled and disabled");

    expect(() =>
      parseArgs([], logger, {
        AUTOMOBILE_TOOLSET_DEFAULTS: "clipboard",
      }),
    ).toThrow("AUTOMOBILE_TOOLSET_DEFAULTS is retired");
  });

  test("applies CLI tool defaults over environment tool defaults", () => {
    const parsed = parseArgs(["--enable-tool", "observe"], logger, {
      AUTOMOBILE_DISABLED_TOOLS: "observe,clipboard",
    });

    expect(parsed.enabledTools).toEqual(["observe"]);
    expect(parsed.disabledTools).toEqual(["clipboard"]);
  });

  // #6168: --port / --host / --initial-session-uuid must not swallow the
  // following flag when given no value (proxy-mode sibling of #6136).
  describe("value-taking options do not consume a following flag when given no value", () => {
    test.each([
      {
        name: "--host with no value preserves the following --port",
        args: ["--host", "--port", "9999"],
        expected: { daemonHost: undefined, daemonPort: 9999 },
      },
      {
        name: "--port with no value preserves the following --host",
        args: ["--port", "--host", "0.0.0.0"],
        expected: { daemonPort: undefined, daemonHost: "0.0.0.0" },
      },
      {
        name: "--initial-session-uuid with no value preserves the following --debug",
        args: ["--initial-session-uuid", "--debug"],
        expected: { initialSessionUuid: undefined, debug: true },
      },
    ])("$name", ({ args, expected }) => {
      const parsed = parseArgs(args, logger);

      for (const [key, value] of Object.entries(expected)) {
        expect(parsed[key as keyof typeof parsed]).toBe(value);
      }
    });

    test.each([
      {
        name: "--host with a valid value",
        args: ["--host", "0.0.0.0"],
        key: "daemonHost",
        value: "0.0.0.0",
      },
      {
        name: "--port with a valid value",
        args: ["--port", "9999"],
        key: "daemonPort",
        value: 9999,
      },
      {
        name: "--initial-session-uuid with a valid value",
        args: ["--initial-session-uuid", "device-session-a"],
        key: "initialSessionUuid",
        value: "device-session-a",
      },
    ])("$name still parses correctly", ({ args, key, value }) => {
      const parsed = parseArgs(args, logger);

      expect(parsed[key as keyof typeof parsed]).toBe(value);
    });
  });
});
