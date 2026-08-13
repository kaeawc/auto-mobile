import { describe, expect, test } from "bun:test";
import { parseArgs } from "../../src/cli/parseArgs";

const logger = { warn: () => {} };

describe("parseArgs (#4277)", () => {
  test("parses CLI feature flags without loading the server entrypoint", () => {
    const parsed = parseArgs(
      ["--cli", "listApps", "--embedded-sdk", "--network-mockable"],
      logger
    );

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
    const fromCli = parseArgs(
      ["--runner-readiness-timeout-ms", "45000"],
      logger,
      { AUTOMOBILE_RUNNER_READINESS_TIMEOUT_MS: "20000" },
    );

    expect(fromEnvironment.runnerReadinessTimeoutMs).toBe(20_000);
    expect(fromCli.runnerReadinessTimeoutMs).toBe(45_000);
  });

  test("leaves runner readiness unset when a bare client has no override", () => {
    const parsed = parseArgs([], logger, {});

    expect(parsed.runnerReadinessTimeoutMs).toBeUndefined();
  });
});
