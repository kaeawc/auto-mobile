import { describe, expect, test } from "bun:test";
import { formatToolResultLog } from "../../src/server/toolResultLog";

describe("formatToolResultLog", () => {
  test("logs a completed success at info with no post-timeout note", () => {
    const line = formatToolResultLog({
      toolName: "openLink",
      success: true,
      error: null,
      callerTimedOut: false,
    });

    expect(line.level).toBe("info");
    expect(line.message).toContain("openLink result: success=true");
    expect(line.message).not.toMatch(/timed out|cancel/i);
  });

  test("logs a failure at info and includes the error", () => {
    const line = formatToolResultLog({
      toolName: "openLink",
      success: false,
      error: "no activity found",
      callerTimedOut: false,
    });

    expect(line.level).toBe("info");
    expect(line.message).toContain("success=false");
    expect(line.message).toContain("no activity found");
  });

  test("falls back to 'unknown' for a failure with no error", () => {
    const line = formatToolResultLog({
      toolName: "openLink",
      success: false,
      error: null,
      callerTimedOut: false,
    });

    expect(line.message).toContain("error=unknown");
  });

  test("reconciles a post-timeout success: warns instead of a bare success=true", () => {
    // Issue #2723: once the caller's request has already timed out (-32001), a
    // late success=true is misleading. Surface it as a warning that explains the
    // result arrived after the caller gave up, rather than a contradictory info log.
    const line = formatToolResultLog({
      toolName: "openLink",
      success: true,
      error: null,
      callerTimedOut: true,
    });

    expect(line.level).toBe("warn");
    expect(line.message).toContain("openLink");
    expect(line.message).toMatch(/after the caller's request (already )?timed out/i);
  });

  test("post-timeout failure also warns and keeps the error", () => {
    const line = formatToolResultLog({
      toolName: "openLink",
      success: false,
      error: "boom",
      callerTimedOut: true,
    });

    expect(line.level).toBe("warn");
    expect(line.message).toContain("success=false");
    expect(line.message).toContain("boom");
    expect(line.message).toMatch(/timed out/i);
  });
});
