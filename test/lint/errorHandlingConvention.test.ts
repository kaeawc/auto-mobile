import { describe, expect, test } from "bun:test";
import plugin from "../../oxlint-plugins/auto-mobile.mjs";
import { runRule } from "./oxlintRuleHarness";

// This backstop exercises only the syntactic catch-convention rule on in-memory
// snippets. The no-unknown-cast / type-aware rules are covered by the src lint
// run, not here.
function lintSnippet(code: string): string[] {
  return runRule(plugin.rules["catch-convention"], code);
}

describe("error-handling convention lint backstop", () => {
  test("rejects a fallback return at a formerly allowlisted path and line", async () => {
    const messages = await lintSnippet(`${"\n".repeat(145)}export function probe(): boolean {
  try {
    return true;
  } catch {
    return false;
  }
}
`, "src/daemon/client.ts");

    expect(messages).toContain("Catch blocks that return a fallback must log the caught error before returning.");
  });

  test("rejects empty catch bodies", async () => {
    const messages = await lintSnippet(`
export function cleanup(): void {
  try {
    throw new Error("boom");
  } catch {
  }
}
`);

    // An empty catch has no binding, never logs, and never throws, so
    // catch-convention flags it as a traceless swallow. (oxlint's built-in
    // `no-empty` with allowEmptyCatch:false also fires at the config level; this
    // rule-unit test asserts the convention rule's own diagnostic.)
    expect(messages.some(m => m.startsWith("Catch block swallows the error with no trace"))).toBe(true);
  });

  test("rejects return-only catch bodies without logging", async () => {
    const messages = await lintSnippet(`
export function parse(): string | null {
  try {
    return "ok";
  } catch {
    return null;
  }
}
`);

    expect(messages).toContain("Catch blocks that return a fallback must log the caught error before returning.");
  });

  test("rejects bare and undefined return-only catch bodies without logging", async () => {
    const messages = await lintSnippet(`
export function ignore(): void {
  try {
    throw new Error("boom");
  } catch {
    return;
  }
}

export function maybe(): string | undefined {
  try {
    return "ok";
  } catch {
    return undefined;
  }
}
`);

    expect(messages.filter(message => message === "Catch blocks that return a fallback must log the caught error before returning.")).toHaveLength(2);
  });

  test("rejects boolean fallback returns without logging", async () => {
    const messages = await lintSnippet(`
export function probe(): boolean {
  try {
    return true;
  } catch {
    return false;
  }
}
`);

    expect(messages).toContain("Catch blocks that return a fallback must log the caught error before returning.");
  });

  test("rejects comment-only catch bodies that core no-empty ignores (#3594)", async () => {
    // no-empty skips blocks containing a comment, so this shape shipped
    // undetected in IOSCtrlProxyClient. tracelessCatch must still flag it.
    const messages = await lintSnippet(`
export function poll(): void {
  try {
    throw new Error("boom");
  } catch {
    // non-fatal, skip
  }
}
`);

    expect(messages).toContain("Catch block swallows the error with no trace: it does not log, does not throw, and never references the caught error. Per the error-handling convention, log it (logger.debug/warn/error) or throw a structured error (see CLAUDE.md).");
  });

  test("rejects an unused-error catch returning a non-fallback object (#3594 Idle case)", async () => {
    const messages = await lintSnippet(`
export function status(): { done: boolean; value: number | null } {
  try {
    return { done: true, value: 1 };
  } catch (err) {
    return { done: false, value: null };
  }
}
`);

    expect(messages).toContain("Catch block swallows the error with no trace: it does not log, does not throw, and never references the caught error. Per the error-handling convention, log it (logger.debug/warn/error) or throw a structured error (see CLAUDE.md).");
  });

  test("allows catches that forward the error without logging", async () => {
    // Forwarding the caught error to a handler/rejector references the binding,
    // so it is not a silent swallow and must not be flagged.
    const messages = await lintSnippet(`
export function run(reject: (error: unknown) => void): void {
  try {
    throw new Error("boom");
  } catch (error) {
    reject(error);
  }
}
`);

    expect(messages).not.toContain("Catch block swallows the error with no trace: it does not log, does not throw, and never references the caught error. Per the error-handling convention, log it (logger.debug/warn/error) or throw a structured error (see CLAUDE.md).");
  });

  test("allows non-fallback recovery returns", async () => {
    const messages = await lintSnippet(`
function recover(error: unknown): string {
  return String(error);
}

export function parse(): string {
  try {
    return "ok";
  } catch (error) {
    return recover(error);
  }
}
`);

    expect(messages).not.toContain("Catch blocks that return a fallback must log the caught error before returning.");
  });

  test("rejects unlogged status-object returns", async () => {
    const messages = await lintSnippet(`
export function check(): { status: "pass" | "skip"; message?: string } {
  try {
    return { status: "pass" };
  } catch {
    return { status: "skip", message: "Could not check" };
  }
}
`);

    expect(messages).toContain("Catch blocks that return a typed failure/status object must log at warn, not debug.");
  });

  test("rejects debug logging before returning a typed status failure", async () => {
    const messages = await lintSnippet(`
import { logger } from "../utils/logger";

export function check(): { status: "pass" | "skip"; message?: string } {
  try {
    return { status: "pass" };
  } catch (error) {
    logger.debug(\`check failed: \${error}\`);
    return { status: "skip", message: "Could not check" };
  }
}
`);

    expect(messages).toContain("Catch blocks that return a typed failure/status object must log at warn, not debug.");
  });

  test("rejects injected debug loggers before returning a typed status failure", async () => {
    const messages = await lintSnippet(`
interface Dependencies {
  logger: {
    debug(message: string): void;
    warn(message: string): void;
  };
}

export function check(dependencies: Dependencies): { status: "pass" | "skip"; message?: string } {
  try {
    return { status: "pass" };
  } catch (error) {
    dependencies.logger.debug(\`check failed: \${error}\`);
    return { status: "skip", message: "Could not check" };
  }
}
`);

    expect(messages).toContain("Catch blocks that return a typed failure/status object must log at warn, not debug.");
  });

  test("rejects status returns that happen before a later logger warning", async () => {
    const messages = await lintSnippet(`
import { logger } from "../utils/logger";

export function check(error: unknown): { status: "fail" | "skip"; message?: string } {
  try {
    throw error;
  } catch (caught) {
    if (caught instanceof Error) {
      return { status: "fail", message: caught.message };
    }
    logger.warn(\`check failed: \${caught}\`, caught);
    return { status: "skip", message: "Could not check" };
  }
}
`);

    expect(messages).toContain("Catch blocks that return a typed failure/status object must log at warn, not debug.");
  });

  test("rejects branch status returns that are not preceded by a warning on that branch", async () => {
    const messages = await lintSnippet(`
import { logger } from "../utils/logger";

export function check(caught: unknown): { status: "fail" | "skip"; message?: string } {
  try {
    throw caught;
  } catch (error) {
    if (error instanceof Error) {
      logger.warn(\`check failed: \${error.message}\`, error);
      return { status: "fail", message: error.message };
    }
    return { status: "skip", message: "Could not check" };
  }
}
`);

    expect(messages).toContain("Catch blocks that return a typed failure/status object must log at warn, not debug.");
  });

  test("rejects non-logger warn calls before typed status returns", async () => {
    const messages = await lintSnippet(`
export function check(): { status: "fail"; message?: string } {
  try {
    throw new Error("boom");
  } catch (error) {
    console.warn(error);
    return { status: "fail", message: "Could not check" };
  }
}
`);

    expect(messages).toContain("Catch blocks that return a typed failure/status object must log at warn, not debug.");
  });

  test("allows logged fallback returns and warn-logged typed failures", async () => {
    const messages = await lintSnippet(`
import { logger } from "../utils/logger";

export function parse(): string | null {
  try {
    return "ok";
  } catch (error) {
    logger.debug(\`parse failed: \${error}\`);
    return null;
  }
}

export function check(): { status: "pass" | "skip"; message?: string } {
  try {
    return { status: "pass" };
  } catch (error) {
    logger.warn(\`check failed: \${error}\`, error);
    return { status: "skip", message: "Could not check" };
  }
}
`);

    expect(messages).not.toContain("Catch blocks that return a fallback must log the caught error before returning.");
    expect(messages).not.toContain("Catch blocks that return a typed failure/status object must log at warn, not debug.");
  });

  test("applies through later source overrides and issue-touched files", async () => {
    const code = `
export function parse(): string | null {
  try {
    return "ok";
  } catch {
    return null;
  }
}
`;
    const sourcePaths = [
      "src/features/navigation/ScreenFingerprint.ts",
      "src/features/navigation/ExploreElementExtraction.ts",
      "src/utils/SystemTimer.ts",
      "src/doctor/checks/android.ts",
      "src/doctor/checks/automobile.ts",
      "src/utils/CtrlProxyManager.ts",
    ];

    for (const filePath of sourcePaths) {
      const messages = await lintSnippet(code, filePath);
      expect(messages).toContain("Catch blocks that return a fallback must log the caught error before returning.");
    }
  });
});
