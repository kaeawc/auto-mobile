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
});
