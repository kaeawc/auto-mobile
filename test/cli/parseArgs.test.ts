import { describe, expect, test } from "bun:test";
import { parseArgs } from "../../src/cli/parseArgs";

const logger = { warn: () => {} };

describe("parseArgs (#4277)", () => {
  test("video environment defaults are applied before CLI overrides and warnings", () => {
    const values = {
      AUTOMOBILE_VIDEO_QUALITY_PRESET: "medium",
      AUTOMOBILE_VIDEO_TARGET_BITRATE_KBPS: "800",
      AUTOMOBILE_VIDEO_MAX_THROUGHPUT_MBPS: "3.5",
      AUTOMOBILE_VIDEO_FPS: "20",
      AUTOMOBILE_VIDEO_MAX_ARCHIVE_MB: "50",
      AUTOMOBILE_VIDEO_FORMAT: "mp4",
    };
    const saved = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
    Object.assign(process.env, values);
    try {
      expect(
        parseArgs(["--video-quality-preset", "high"], logger, {}).videoRecordingDefaults,
      ).toEqual({
        qualityPreset: "high",
        targetBitrateKbps: 800,
        maxThroughputMbps: 3.5,
        fps: 20,
        maxArchiveSizeMb: 50,
        format: "mp4",
      });
      const logged: string[] = [];
      parseArgs(
        [
          "--video-fps",
          "bad",
          "--plan-execution-lock-scope",
          "bad",
          "--runner-readiness-timeout-ms",
          "bad",
        ],
        { warn: (message) => logged.push(message) },
        {},
      );
      expect(logged[0]).toBe("Invalid video fps: bad");
      expect(logged[1]).toBe("Invalid plan execution lock scope: bad. Using default: session");
      expect(logged[2]).toContain(
        "Invalid runner readiness timeout: bad; expected an integer from",
      );
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });

  test.each([
    {
      args: ["--port", "0", "--host", "--debug"],
      warnings: ["Invalid port: 0", "Invalid host: --debug"],
      expected: { daemonPort: undefined, daemonHost: undefined, debug: true },
    },
    {
      args: [
        "--a11y-level",
        "AA",
        "--a11y-failure-mode",
        "warn",
        "--a11y-min-severity",
        "critical",
        "--a11y-use-baseline",
      ],
      warnings: [],
      expected: {
        a11yLevel: "AA",
        a11yFailureMode: "warn",
        a11yMinSeverity: "critical",
        a11yUseBaseline: true,
      },
    },
    {
      args: [
        "--video-quality",
        "high",
        "--video-target-bitrate-kbps",
        "2000",
        "--video-max-throughput-mbps",
        "2.5",
        "--video-fps",
        "30",
        "--video-format",
        "mp4",
        "--video-archive-size-mb",
        "10.5",
      ],
      warnings: [],
      expected: {
        videoRecordingDefaults: {
          qualityPreset: "high",
          targetBitrateKbps: 2000,
          maxThroughputMbps: 2.5,
          fps: 30,
          format: "mp4",
          maxArchiveSizeMb: 10.5,
        },
      },
    },
    {
      args: ["--video-quality", "bad", "--video-format", "gif"],
      warnings: ["Invalid video quality preset (cli): bad", "Invalid video format (cli): gif"],
      expected: { videoRecordingDefaults: {} },
    },
    {
      args: ["--cli", "listApps", "--port", "9000"],
      warnings: [],
      expected: { cliArgs: ["listApps", "--port", "9000"], daemonPort: undefined },
    },
  ])("characterizes argv $args", ({ args, warnings, expected }) => {
    const logged: string[] = [];
    expect(parseArgs(args, { warn: (message) => logged.push(message) }, {})).toMatchObject(
      expected,
    );
    expect(logged).toEqual(warnings);
  });

  test.each([
    {
      args: ["--enable-tool", "tapOn", "--disable-tool", "tapOn"],
      environment: {},
      message: "Tool 'tapOn' cannot be both enabled and disabled by CLI defaults.",
    },
    {
      args: [],
      environment: { AUTOMOBILE_ENABLED_TOOLS: "tapOn", AUTOMOBILE_DISABLED_TOOLS: "tapOn" },
      message: "Tool 'tapOn' cannot be both enabled and disabled by environment defaults.",
    },
    {
      args: [],
      environment: { AUTOMOBILE_TOOLSET_OLD: "1" },
      message:
        "AUTOMOBILE_TOOLSET_OLD is retired; use AUTOMOBILE_ENABLED_TOOLS or AUTOMOBILE_DISABLED_TOOLS.",
    },
  ])("characterizes parsing errors $message", ({ args, environment, message }) => {
    expect(() => parseArgs(args, logger, environment)).toThrow(message);
  });

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

  test("distinguishes the default plan lock scope from an explicit override", () => {
    expect(parseArgs([], logger).planExecutionLockScopeExplicit).toBe(false);
    expect(
      parseArgs(["--plan-execution-lock-scope", "global"], logger).planExecutionLockScopeExplicit,
    ).toBe(true);
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
