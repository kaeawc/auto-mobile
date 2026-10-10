import { describe, expect, test } from "bun:test";
import { parseArgs } from "../../src/cli/parseArgs";

const logger = { warn: () => {} };

describe("malformed invocations (#10132)", () => {
  test("signals a daemon request without a subcommand", () => {
    const parsed = parseArgs(["--daemon"], logger, {});
    expect(parsed.daemonRequested).toBe(true);
    expect(parsed.daemonCommand).toBeUndefined();
  });

  test("rejects inline CLI tool syntax with the accepted form", () => {
    expect(parseArgs(["--cli=observe"], logger, {}).invalidInvocation).toContain("--cli <tool>");
  });

  test.each(["doctor", "status"])("rejects stray %s with a usage hint", (word) => {
    expect(parseArgs([word], logger, {}).invalidInvocation).toContain(`--cli ${word}`);
  });

  test.each([
    [],
    ["--port", "8080", "--host", "127.0.0.1"],
    ["--cli"],
    ["--cli", "observe"],
    ["--cli", "observe", "--text", "hello"],
    ["--daemon", "status"],
    ["--daemon", "bogus"],
    ["--daemon", "session-info", "session-id"],
    ["--enable-tool", "observe", "--enable-tool", "tapOn", "--disable-tool", "clipboard"],
    ["--enable-tool=observe", "--disable-tool=clipboard"],
  ])("preserves accepted argv %j", (...args) => {
    const parsed = parseArgs(args, logger, {});
    expect(parsed.invalidInvocation).toBeUndefined();
    expect(parsed.daemonRequested).toBe(args.includes("--daemon"));
    expect(parsed.cliMode).toBe(args.includes("--cli"));
    expect(parsed.daemonCommand).toBe(
      args.includes("--daemon") ? args[args.indexOf("--daemon") + 1] : undefined,
    );
  });

  test.each([
    ["--daemon-socket-path", "scratch/socket"],
    ["--initial-session-uuid", "session-id"],
    ["--liveness-owner-token", "owner-token"],
    ["--a11y-level", "AA"],
    ["--a11y-failure-mode", "warn"],
    ["--a11y-min-severity", "critical"],
    ["--plan-execution-lock-scope", "session"],
    ["--runner-readiness-timeout-ms", "20000"],
    ["--video-quality", "high"],
    ["--video-quality-preset", "medium"],
    ["--video-target-bitrate-kbps", "800"],
    ["--video-max-throughput-mbps", "3.5"],
    ["--video-fps", "20"],
    ["--video-format", "mp4"],
    ["--video-archive-size-mb", "50"],
    ["--event-all-markers", "tap,swipe"],
    ["--tool-outputs-dir", "scratch/tool-outputs"],
    ["--tool-output-dir", "scratch/tool-outputs"],
    ["--port", "invalid"],
  ])("does not confuse %s values with commands", (flag, value) => {
    expect(parseArgs([flag, value], logger, {}).invalidInvocation).toBeUndefined();
    expect(parseArgs([flag, value, "doctor"], logger, {}).invalidInvocation).toContain(
      "--cli doctor",
    );
  });

  test("keeps boolean output-reduction flags from consuming stray words", () => {
    expect(parseArgs(["--actions-no-observe", "doctor"], logger, {}).invalidInvocation).toContain(
      "--cli doctor",
    );
  });
});

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

  test("parses a harness-supplied stable liveness owner token for proxy mode", () => {
    const parsed = parseArgs(
      ["--initial-session-uuid", "device-session-a", "--liveness-owner-token", "harness-token"],
      logger,
    );

    expect(parsed.initialSessionUuid).toBe("device-session-a");
    expect(parsed.livenessOwnerToken).toBe("harness-token");
    expect(parseArgs([], logger).livenessOwnerToken).toBeUndefined();
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
      {
        name: "--liveness-owner-token with no value preserves the following --debug",
        args: ["--liveness-owner-token", "--debug"],
        expected: { livenessOwnerToken: undefined, debug: true },
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
      {
        name: "--liveness-owner-token with a valid value",
        args: ["--liveness-owner-token", "harness-token"],
        key: "livenessOwnerToken",
        value: "harness-token",
      },
    ])("$name still parses correctly", ({ args, key, value }) => {
      const parsed = parseArgs(args, logger);

      expect(parsed[key as keyof typeof parsed]).toBe(value);
    });
  });
});

describe("--managed-slot-config (#11173)", () => {
  const config = {
    contractVersion: 1,
    managedHostScope: "host-a",
    runnerNamespace: "ns",
    runnerIncarnation: "inc",
    localSlotCapacity: 1,
    requests: [
      {
        slotIndex: 0,
        role: "primary",
        platform: "android",
        requestedSpec: {
          runtime: "system-images;android-34;google_apis;x86_64",
          deviceType: "pixel_8",
        },
      },
    ],
  };
  const noFile = (): string => {
    throw new Error("unexpected file read");
  };

  test("is absent by default", () => {
    expect(parseArgs([], logger, {}, noFile).managedSlotConfig).toBeUndefined();
  });

  test("parses inline JSON from the flag, separate and = forms", () => {
    const json = JSON.stringify(config);
    const separate = parseArgs(["--managed-slot-config", json], logger, {}, noFile);
    const equals = parseArgs([`--managed-slot-config=${json}`], logger, {}, noFile);
    expect(separate.managedSlotConfig?.runnerNamespace).toBe("ns");
    expect(equals.managedSlotConfig?.runnerNamespace).toBe("ns");
    expect(separate.invalidInvocation).toBeUndefined();
  });

  test("reads a file path and lets the flag win over the env", () => {
    const parsed = parseArgs(
      ["--managed-slot-config", "/cfg.json"],
      logger,
      { AUTOMOBILE_MANAGED_SLOT_CONFIG: JSON.stringify({ ...config, runnerNamespace: "env" }) },
      () => JSON.stringify({ ...config, runnerNamespace: "file" }),
    );
    expect(parsed.managedSlotConfig?.runnerNamespace).toBe("file");
  });

  test("uses the env when the flag is absent", () => {
    const parsed = parseArgs(
      [],
      logger,
      { AUTOMOBILE_MANAGED_SLOT_CONFIG: JSON.stringify(config) },
      noFile,
    );
    expect(parsed.managedSlotConfig?.managedHostScope).toBe("host-a");
  });

  test("rejects an unsupported contract version at parse time", () => {
    expect(() =>
      parseArgs(
        ["--managed-slot-config", JSON.stringify({ ...config, contractVersion: 9 })],
        logger,
        {},
        noFile,
      ),
    ).toThrow("contract_unsupported");
  });

  test("throws when the flag has no value instead of falling back to env", () => {
    const env = { AUTOMOBILE_MANAGED_SLOT_CONFIG: JSON.stringify(config) };
    expect(() => parseArgs(["--managed-slot-config"], logger, env, noFile)).toThrow(
      "managed_slot_config_invalid",
    );
    expect(() => parseArgs(["--managed-slot-config", "--debug"], logger, env, noFile)).toThrow(
      "managed_slot_config_invalid",
    );
  });

  test("does not echo inline JSON snippets in parse errors", () => {
    let message = "";
    let cause: unknown;
    try {
      parseArgs(["--managed-slot-config", '{"token": "s3cr3t-value" oops}'], logger, {}, noFile);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
      cause = (error as Error).cause;
    }
    expect(cause).toBeUndefined();
    expect(message).toContain("managed_slot_config_invalid");
    expect(message).not.toContain("s3cr3t-value");
  });

  test("rejects combination with --no-proxy and --initial-session-uuid", () => {
    const json = JSON.stringify(config);
    expect(() =>
      parseArgs(["--no-proxy", "--managed-slot-config", json], logger, {}, noFile),
    ).toThrow("managed_slot_config_invalid");
    expect(() =>
      parseArgs(
        ["--initial-session-uuid", "u-1", "--managed-slot-config", json],
        logger,
        {},
        noFile,
      ),
    ).toThrow("managed_slot_config_invalid");
  });
});
